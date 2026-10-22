/**
 * A3 — per-provider result grants and the discovered-settings writer.
 *
 * Ported from CodexBar @ 6480977 (MIT, © 2026 Peter Steinberger; LICENSE-CodexBar beside the plugins):
 *   Sources/CodexBarCore/Plugins/ProviderPluginResult.swift (ProviderPluginResultPolicy, ProviderPluginConfigWriter),
 *   Sources/CodexBarCore/Providers/Fireworks/FireworksProviderDescriptor.swift:28-33 (ACCOUNT_SLUG writer),
 *   Sources/CodexBarCore/Providers/OpenAI/OpenAIAPIProviderDescriptor.swift:26, 142-275 (mapPluginCard).
 * "Only descriptors grant card and plain-setting capabilities; scripts cannot expand these allowlists": the registry
 * lives outside the plugin's vm context and is deeply frozen. Every other descriptor in CodexBar uses the empty
 * policy `ProviderPluginResultPolicy()`.
 *
 * Errors thrown here are plain Errors; the host re-raises them as invalid-snapshot (ProviderPluginError.invalidSnapshot).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const invalid = message => { throw new Error(message); };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const utf8Length = s => Buffer.byteLength(s, 'utf8');

/** ProviderPluginSnapshotMapper.resultString: 1-256 UTF-8 bytes, not blank, no control characters. */
export function resultString(v, path) {
  if (typeof v !== 'string') invalid(`${path} must be a string`);
  if (!v.trim() || utf8Length(v) > 256 || /[\u0000-\u001F\u007F-\u009F]/.test(v)) {
    invalid(`${path} must contain 1-256 bytes without control characters`);
  }
  return v;
}
function objectKeys(v, path) {
  if (!isObject(v) || Object.prototype.toString.call(v) === '[object Date]') invalid(`${path} must be an object`);
  return Reflect.ownKeys(v).map(String);
}
function allowedKeys(v, allowed, path) {
  if (objectKeys(v, path).some(k => !allowed.includes(k))) invalid(`${path} contains unknown keys`);
}

// ---------------------------------------------------------------- OpenAI card (mapPluginCard)

const MAX_SAFE = 9_007_199_254_740_991;
function cardNumber(obj, key) {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_SAFE) invalid(`card.${key} must be a finite safe number`);
  return v;
}
function cardInteger(obj, key, maximum = 900_719_925_474) {
  const n = cardNumber(obj, key);
  if (!(n >= 0 && Math.round(n) === n && n <= maximum)) invalid(`card.${key} must be a bounded nonnegative integer`);
  return n;
}
function cardArray(obj, key, maximum) {
  const v = obj[key];
  if (!Array.isArray(v) || v.length > maximum) invalid(`card.${key} must be a bounded array`);
  return v.map(e => (e === undefined ? invalid(`card.${key} contains a missing value`) : e));
}
const cardName = obj => (obj.name === undefined ? invalid('card.name is required') : resultString(obj.name, 'card.name'));

/**
 * OpenAIAPIProviderDescriptor.mapPluginCard → `usage.openAIAPIUsage` (history buckets). The `live` payload feeds
 * CodexBar's throughput through `try?` (OpenAILiveUsageBuilder); this port does not build throughput yet, so it is
 * ignored here exactly as a failed `try?` would be.
 */
function mapOpenAICard(card, usage) {
  allowedKeys(card, ['openAIAPIUsage'], 'card');
  const payload = card.openAIAPIUsage;
  if (payload === undefined) invalid('card.openAIAPIUsage is required');
  allowedKeys(payload, ['daily', 'historyDays', 'projectID', 'live'], 'card.openAIAPIUsage');
  const historyDays = cardInteger(payload, 'historyDays', 365);
  if (!(historyDays > 0)) invalid('historyDays must be positive');
  const projectID = payload.projectID === undefined || payload.projectID === null ? null : resultString(payload.projectID, 'projectID');
  let remaining = 10_000;
  const daily = cardArray(payload, 'daily', 366).map(day => {
    allowedKeys(day, ['startTime', 'endTime', 'costUSD', 'requests', 'inputTokens', 'cachedInputTokens', 'outputTokens',
      'totalTokens', 'lineItems', 'models'], 'daily bucket');
    const start = cardNumber(day, 'startTime');
    const end = cardNumber(day, 'endTime');
    if (!(start >= 0 && end > start && end <= 253_402_300_799)) invalid('invalid card bucket interval');
    const lines = cardArray(day, 'lineItems', remaining);
    remaining -= lines.length;
    const models = cardArray(day, 'models', remaining);
    remaining -= models.length;
    return {
      day: new Date(Math.floor(start) * 1000).toISOString().slice(0, 10), startTime: start * 1000, endTime: end * 1000,
      costUSD: cardNumber(day, 'costUSD'), requests: cardInteger(day, 'requests'), inputTokens: cardInteger(day, 'inputTokens'),
      cachedInputTokens: cardInteger(day, 'cachedInputTokens'), outputTokens: cardInteger(day, 'outputTokens'),
      totalTokens: cardInteger(day, 'totalTokens'),
      lineItems: lines.map(item => {
        allowedKeys(item, ['name', 'costUSD'], 'line item');
        return { name: cardName(item), costUSD: cardNumber(item, 'costUSD') };
      }),
      models: models.map(model => {
        allowedKeys(model, ['name', 'requests', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'], 'model');
        return { name: cardName(model), requests: cardInteger(model, 'requests'), inputTokens: cardInteger(model, 'inputTokens'),
          cachedInputTokens: cardInteger(model, 'cachedInputTokens'), outputTokens: cardInteger(model, 'outputTokens'),
          totalTokens: cardInteger(model, 'totalTokens') };
      }),
    };
  });
  return { ...usage, openAIAPIUsage: { historyDays, projectID, daily } };
}

// ---------------------------------------------------------------- the registry

const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const RESULT_POLICIES = deepFreeze({
  // FireworksProviderDescriptor.swift:28-33
  fireworks: {
    cardMapper: null,
    settings: {
      ACCOUNT_SLUG: (value, section) => {
        if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') invalid('invalid discovered account slug');
        section.ACCOUNT_SLUG = value;
      },
    },
  },
  // OpenAIAPIProviderDescriptor.swift:26
  openai: { cardMapper: mapOpenAICard, settings: {} },
});
const EMPTY_POLICY = deepFreeze({ cardMapper: null, settings: {} });

export function resultPolicyFor(providerId) {
  return typeof providerId === 'string' && Object.hasOwn(RESULT_POLICIES, providerId) ? RESULT_POLICIES[providerId] : EMPTY_POLICY;
}

/** ProviderPluginResultPolicy.applying(_:to:) — a copy of `section` with every value written by its grant. */
export function applyPersist(policy, values, section) {
  const keys = Object.keys(values);
  if (keys.length > 16) invalid('persist exceeds 16 keys');
  const updated = structuredClone(isObject(section) ? section : {});
  for (const key of keys) {
    const value = values[key];
    const write = Object.hasOwn(policy.settings, key) ? policy.settings[key] : null;
    if (utf8Length(key) > 64 || typeof value !== 'string' || utf8Length(value) > 256 || !write) {
      invalid('persist contains an unapproved setting');
    }
    write(value, updated);
  }
  return updated;
}

// ---------------------------------------------------------------- the config writer

export const defaultConfigPath = (env = process.env) =>
  env.OCLI_USAGE_READERS_CONFIG ?? join(homedir(), '.config', 'ocli', 'usage-readers.json');

/** JSONEncoder with .sortedKeys — key order is not a difference (ProviderPluginResultPolicy.matches). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const sectionsMatch = (a, b) => canonical(a ?? null) === canonical(b ?? null);

/** Reads the whole config document: null when the file does not exist; throws when it is unreadable or not an object. */
export function loadConfigDocument(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const doc = JSON.parse(text);
  if (!isObject(doc)) throw new Error('usage-readers config must be a JSON object');
  return doc;
}

/**
 * ProviderPluginConfigWriter.save: reload the file; `stale` if this provider's section no longer equals `expected`
 * (the section the fetch read, null when absent); apply the descriptor's writers to `expected`; `unchanged` when that
 * changes nothing; otherwise write the whole document back — other providers kept as parsed, in order — through a
 * temp file + atomic rename at mode 0600. Any error is `failed`. Never throws.
 */
export function persistSettings(providerId, values, expected, { configPath, env = process.env } = {}) {
  const file = configPath ?? defaultConfigPath(env);
  try {
    const doc = loadConfigDocument(file) ?? {};
    const current = Object.hasOwn(doc, providerId) ? doc[providerId] : null;
    if (!sectionsMatch(current, expected)) return 'stale';
    const original = expected ?? {};
    if (!isObject(original)) return 'failed';
    const updated = applyPersist(resultPolicyFor(providerId), values, original);
    if (sectionsMatch(updated, original)) return 'unchanged';
    doc[providerId] = updated;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return 'saved';
  } catch {
    return 'failed';
  }
}
