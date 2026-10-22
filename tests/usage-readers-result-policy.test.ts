import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlugin, readPluginUsage, mapPluginResult, buildRequest, parseManifest,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/plugin-host.mjs';
import {
  RESULT_POLICIES, persistSettings,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/result-policy.mjs';

// A3 — CodexBar @ 6480977: ProviderPluginResult.swift (ProviderPluginResultPolicy + ProviderPluginConfigWriter),
// FireworksProviderDescriptor.swift / OpenAIAPIProviderDescriptor.swift (grants), ProviderPluginStorage.swift,
// ProviderPluginSnapshotMapper.costUsage, ProviderPluginHTTPResponse.request + ProviderPluginManifest
// .openRouterManagementAuthSecret. Fixtures only; every config file is a temp path.

type Req = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutSeconds: number };
type Res = { status?: number; body: string };
function fixture(handler: (req: Req) => Res) {
  const requests: Req[] = [];
  const transport = async (req: Req) => {
    requests.push(req);
    const res = handler(req);
    return { status: res.status ?? 200, headers: { 'content-type': 'application/json' }, body: res.body };
  };
  return { transport, requests };
}
const header = (req: Req, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const tempDir = () => (dir = mkdtempSync(join(tmpdir(), 'a3-policy-')));

// ---------------------------------------------------------------- the grant registry

describe('A3 result policy — grants', () => {
  it('holds exactly CodexBar\'s descriptor grants: fireworks ACCOUNT_SLUG, openai cardMapper', () => {
    expect(Object.keys(RESULT_POLICIES).sort()).toEqual(['fireworks', 'openai']);
    expect(Object.keys(RESULT_POLICIES.fireworks.settings)).toEqual(['ACCOUNT_SLUG']);
    expect(RESULT_POLICIES.fireworks.cardMapper).toBeNull();
    expect(Object.keys(RESULT_POLICIES.openai.settings)).toEqual([]);
    expect(typeof RESULT_POLICIES.openai.cardMapper).toBe('function');
    expect(Object.isFrozen(RESULT_POLICIES) && Object.isFrozen(RESULT_POLICIES.fireworks.settings)).toBe(true);
  });

  const plain = (key: string, type = 'plain') => ({ key, title: key, type });
  const fw = (settings = [plain('ACCOUNT_SLUG'), plain('OTHER')]) =>
    parseManifest({ id: 'fireworks', name: 'Fireworks', endpoints: ['https://api.fireworks.ai'], settings });
  const map = (value: unknown, manifest = fw()) => mapPluginResult(value, { manifest });
  const usage = { cost: { used: 1, currency: 'USD' } };

  it('a granted plain key is returned; an ungranted (even declared plain) key is refused', () => {
    expect(map({ usage, persist: { ACCOUNT_SLUG: 'acct-1' } }).persist).toEqual({ ACCOUNT_SLUG: 'acct-1' });
    expect(() => map({ usage, persist: { OTHER: 'x' } })).toThrow('persist contains an unapproved setting');
    expect(() => map({ usage, persist: { ACCOUNT_SLUG: 'a', OTHER: 'x' } })).toThrow('persist contains an unapproved setting');
    // The writer validates the value exactly as the descriptor does.
    expect(() => map({ usage, persist: { ACCOUNT_SLUG: '..' } })).toThrow('invalid discovered account slug');
    expect(() => map({ usage, persist: { ACCOUNT_SLUG: 'a/b' } })).toThrow('invalid discovered account slug');
    // No manifest (no provider) ⇒ no grants at all, like a user plugin.
    expect(() => mapPluginResult({ usage, persist: { ACCOUNT_SLUG: 'a' } })).toThrow('persist contains an unapproved setting');
    // Another provider declaring the same key does not inherit the grant.
    const other = parseManifest({ id: 'openai', name: 'X', endpoints: ['https://api.openai.com'], settings: [{ key: 'ACCOUNT_SLUG', title: 'S', type: 'plain' }] });
    expect(() => map({ usage, persist: { ACCOUNT_SLUG: 'a' } }, other)).toThrow('persist contains an unapproved setting');
  });

  it('a granted key declared SECURE (or not declared) is refused', () => {
    expect(() => map({ usage, persist: { ACCOUNT_SLUG: 'a' } }, fw([plain('ACCOUNT_SLUG', 'secure')])))
      .toThrow("persist setting 'ACCOUNT_SLUG' must be a declared plain setting");
    expect(() => map({ usage, persist: { ACCOUNT_SLUG: 'a' } }, fw([plain('OTHER')])))
      .toThrow("persist setting 'ACCOUNT_SLUG' must be a declared plain setting");
  });

  it('a script cannot expand the allowlist from inside its context', async () => {
    const src = `defineProvider({ id: "fireworks", name: "Fireworks", endpoints: ["https://api.fireworks.ai"],
      settings: [{ key: "ACCOUNT_SLUG", title: "S", type: "plain" }, { key: "OTHER", title: "O", type: "plain" }],
      async fetchUsage(ctx) {
        try { globalThis.RESULT_POLICIES = { fireworks: { settings: { OTHER: () => {} } } }; } catch {}
        try { Object.prototype.OTHER = () => {}; } catch {}
        return { usage: { cost: { used: 1, currency: "USD" } }, persist: { OTHER: "x" } };
      } });`;
    const result = await loadPlugin(src, { transport: fixture(() => ({ body: '{}' })).transport }).read({});
    expect(result.reading).toEqual({ status: 'unavailable', reason: 'plugin:invalid-snapshot' });
    expect(result.error.message).toContain('persist contains an unapproved setting');
  });
});

// ---------------------------------------------------------------- the config writer

describe('A3 result policy — persistSettings (ProviderPluginConfigWriter.save)', () => {
  const setup = (doc: unknown) => {
    const file = join(tempDir(), 'usage-readers.json');
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
    return { file, env: { OCLI_USAGE_READERS_CONFIG: file } };
  };
  const OTHERS = { openai: { OPENAI_PROJECT_ID: 'p-1', nested: { b: 2, a: [1, 'x'] } }, zai: { MODE: 7 } };

  it('saves a granted key, preserves other providers, writes 0600 via temp + rename', () => {
    const { file, env } = setup({ ...OTHERS, fireworks: { FIREWORKS_API_KEY: 'fk' } });
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'acct-1' }, { FIREWORKS_API_KEY: 'fk' }, { env })).toBe('saved');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.fireworks).toEqual({ FIREWORKS_API_KEY: 'fk', ACCOUNT_SLUG: 'acct-1' });
    expect(JSON.stringify(doc.openai)).toBe(JSON.stringify(OTHERS.openai));
    expect(JSON.stringify(doc.zai)).toBe(JSON.stringify(OTHERS.zai));
    expect(Object.keys(doc)).toEqual(['openai', 'zai', 'fireworks']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });

  it('missing file: expected null ⇒ creates it with only that provider', () => {
    const file = join(tempDir(), 'sub', 'usage-readers.json');
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'a' }, null, { configPath: file })).toBe('saved');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fireworks: { ACCOUNT_SLUG: 'a' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('unchanged when the value is already there (no write)', () => {
    const { file, env } = setup({ fireworks: { ACCOUNT_SLUG: 'a' } });
    const before = readFileSync(file, 'utf8');
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'a' }, { ACCOUNT_SLUG: 'a' }, { env })).toBe('unchanged');
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('stale when that provider\'s section changed since the read; nothing is written', () => {
    const { file, env } = setup({ fireworks: { FIREWORKS_API_KEY: 'replacement' } });
    const before = readFileSync(file, 'utf8');
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'old' }, { FIREWORKS_API_KEY: 'original' }, { env })).toBe('stale');
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'old' }, null, { env })).toBe('stale');
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Key order alone is not a change (CodexBar compares sorted-key encodings).
    const s = setup({ fireworks: { b: '1', a: '2' } });
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'x' }, { a: '2', b: '1' }, { env: s.env })).toBe('saved');
  });

  it('another provider\'s edits never make a save stale', () => {
    const { file, env } = setup({ openai: { OPENAI_PROJECT_ID: 'new' }, fireworks: {} });
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'a' }, {}, { env })).toBe('saved');
    expect(JSON.parse(readFileSync(file, 'utf8')).openai).toEqual({ OPENAI_PROJECT_ID: 'new' });
  });

  it('failed: an ungranted or secure-looking key, a provider with no grants, an unreadable or invalid file', () => {
    const { file, env } = setup({ fireworks: {} });
    const before = readFileSync(file, 'utf8');
    expect(persistSettings('fireworks', { FIREWORKS_API_KEY: 'sk-secret' }, {}, { env })).toBe('failed');
    expect(persistSettings('openai', { ACCOUNT_SLUG: 'a' }, null, { env })).toBe('failed');
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: '.' }, {}, { env })).toBe('failed');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(file, 'utf8')).not.toContain('sk-secret');
    writeFileSync(file, '{ not json');
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'a' }, null, { env })).toBe('failed');
    const asDir = join(dir, 'is-a-dir.json');
    mkdirSync(asDir);
    expect(persistSettings('fireworks', { ACCOUNT_SLUG: 'a' }, null, { configPath: asDir })).toBe('failed');
  });
});

// ---------------------------------------------------------------- fireworks.js end to end

describe('A3 fireworks.js — discovered ACCOUNT_SLUG saved through readPluginUsage', () => {
  const accounts = '{"accounts":[{"name":"accounts/fixture-acct"}]}';
  const summary = '{"lineItems":[{"totalCost":{"units":"3","nanos":500000000,"currencyCode":"USD"}}]}';
  const handler = (req: Req) => ({ body: req.url.includes('/billing/summary') ? summary : accounts });
  const now = Date.UTC(2026, 9, 17, 12);

  it('auto-discovered slug is saved (saved), the reading stays ok, the next run uses it and saves nothing', async () => {
    const file = join(tempDir(), 'usage-readers.json');
    writeFileSync(file, JSON.stringify({ zai: { MODE: 'x' }, fireworks: { FIREWORKS_API_KEY: 'fk-1' } }));
    const env = { OCLI_USAGE_READERS_CONFIG: file };
    const first = await readPluginUsage('fireworks', { env, transport: fixture(handler).transport, now });
    expect(first.reading.status).toBe('ok');
    expect(first.reading.cost).toMatchObject({ used: 3.5, currency: 'USD' });
    expect(first.sourceLabel).toBe('api · fixture-acct (auto-discovered)');
    expect(first.settingsSave).toBe('saved');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc).toEqual({ zai: { MODE: 'x' }, fireworks: { FIREWORKS_API_KEY: 'fk-1', ACCOUNT_SLUG: 'fixture-acct' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = fixture(handler);
    const again = await readPluginUsage('fireworks', { env, transport: second.transport, now });
    expect(again.sourceLabel).toBe('api · fixture-acct');
    expect(again.settingsSave).toBeUndefined();
    expect(second.requests.map(r => new URL(r.url).pathname)).toEqual(['/v1/accounts/fixture-acct/billing/summary']);
  });

  it('a section edited during the fetch is stale and left as the user wrote it', async () => {
    const file = join(tempDir(), 'usage-readers.json');
    writeFileSync(file, JSON.stringify({ fireworks: { FIREWORKS_API_KEY: 'fk-1' } }));
    const edit = (req: Req) => {
      if (req.url.includes('/billing/summary')) writeFileSync(file, JSON.stringify({ fireworks: { FIREWORKS_API_KEY: 'fk-2' } }));
      return handler(req);
    };
    const result = await readPluginUsage('fireworks', { env: { OCLI_USAGE_READERS_CONFIG: file }, transport: fixture(edit).transport, now });
    expect(result.reading.status).toBe('ok');
    expect(result.settingsSave).toBe('stale');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fireworks: { FIREWORKS_API_KEY: 'fk-2' } });
  });

  it('a failed save never fails the reading', async () => {
    const asDir = join(tempDir(), 'usage-readers.json');
    mkdirSync(asDir);
    const result = await readPluginUsage('fireworks', {
      env: { OCLI_USAGE_READERS_CONFIG: asDir, FIREWORKS_API_KEY: 'fk-env' }, transport: fixture(handler).transport, now });
    expect(result.reading.status).toBe('ok');
    expect(result.settingsSave).toBe('failed');
  });
});

// ---------------------------------------------------------------- persistent storage

describe('A3 persistent storage (ProviderPluginStorage)', () => {
  const src = (body: string, caps = '["persistent-storage"]') => `defineProvider({ id: "storefix", name: "S",
    endpoints: ["https://s.test"], settings: [], capabilities: ${caps},
    async fetchUsage(ctx) { ${body} } });`;
  const counter = src(`
    const n = Number(ctx.storage.get("count") || "0") + 1;
    ctx.storage.set("count", String(n));
    if (n === 2) ctx.storage.remove("gone");
    if (n === 1) ctx.storage.set("gone", "x");
    return { primary: { usedPercent: n } };`);

  it('values survive a fresh runtime; file is {version:1,values}, 0600, directory 0700', async () => {
    const storageDirectory = join(tempDir(), 'plugin-storage');
    const opts = { transport: fixture(() => ({ body: '{}' })).transport, storageDirectory };
    expect((await loadPlugin(counter, opts).read({})).reading.windows[0].usedPercent).toBe(1);
    const file = join(storageDirectory, 'storefix.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, values: { count: '1', gone: 'x' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(storageDirectory).mode & 0o777).toBe(0o700);
    expect((await loadPlugin(counter, opts).read({})).reading.windows[0].usedPercent).toBe(2);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, values: { count: '2' } });
  });

  it('get of a missing key is null; set of an equal value does not rewrite', async () => {
    const storageDirectory = join(tempDir(), 'plugin-storage');
    const probe = src(`
      const missing = ctx.storage.get("nope");
      ctx.storage.set("k", "v"); ctx.storage.set("k", "v"); ctx.storage.remove("absent");
      return { primary: { usedPercent: missing === null ? 1 : 99 } };`);
    const { reading } = await loadPlugin(probe, { transport: fixture(() => ({ body: '{}' })).transport, storageDirectory }).read({});
    expect(reading.windows[0].usedPercent).toBe(1);
  });

  // Lead pin (A3 survivor): every save is temp + rename (new inode), so an equal set must leave the inode alone.
  it('an equal-value set does not rewrite the storage file', async () => {
    const storageDirectory = join(tempDir(), 'plugin-storage');
    const run = () => loadPlugin(src('ctx.storage.set("k", "v"); return { primary: { usedPercent: 1 } };'),
      { transport: fixture(() => ({ body: '{}' })).transport, storageDirectory }).read({});
    await run();
    const [name] = readdirSync(storageDirectory).filter(f => f.endsWith('.json'));
    const before = statSync(join(storageDirectory, name)).ino;
    await run();
    expect(statSync(join(storageDirectory, name)).ino).toBe(before);
  });

  it('refused without the capability; key/value types and bounds enforced', async () => {
    const storageDirectory = join(tempDir(), 'plugin-storage');
    const run = async (body: string, caps?: string) => (await loadPlugin(src(body, caps), {
      transport: fixture(() => ({ body: '{}' })).transport, storageDirectory }).read({})).error?.message;
    expect(await run('ctx.storage.get("a"); return {};', '[]')).toContain('persistent storage is unavailable or not declared');
    expect(await run('ctx.storage.get(5); return {};')).toContain('storage key must be a string');
    expect(await run('ctx.storage.get(""); return {};')).toContain('storage key must contain 1-128 UTF-8 bytes');
    expect(await run(`ctx.storage.get("${'k'.repeat(129)}"); return {};`)).toContain('storage key must contain 1-128 UTF-8 bytes');
    expect(await run('ctx.storage.set("a", 5); return {};')).toContain('storage value must be a string');
    expect(await run('ctx.storage.set("a", "x".repeat(16385)); return {};')).toContain('storage exceeds its entry or UTF-8 byte limits');
    expect(await run('for (let i = 0; i < 65; i++) ctx.storage.set("k" + i, "v"); return {};')).toContain('storage exceeds its entry or UTF-8 byte limits');
    writeFileSync(join(storageDirectory, 'storefix.json'), '{"version":2,"values":{}}');
    expect(await run('ctx.storage.get("a"); return {};')).toContain('invalid or incompatible plugin storage');
  });
});

// ---------------------------------------------------------------- costUsage

describe('A3 costUsage (ProviderPluginSnapshotMapper.costUsage)', () => {
  const base = { currency: 'USD', historyDays: 30, historyLabel: 'Last 30 days (UTC)', windowEnd: '2026-08-17' };
  const map = (costUsage: unknown) => mapPluginResult({ costUsage });
  it('aggregates by day and model, sorted, with provenance', () => {
    const { usage } = map({ ...base, entries: [
      { date: '2026-08-17', model: 'm-b', inputTokens: 10, outputTokens: 5, requests: 1, cost: 2, estimatedCost: 1 },
      { date: '2026-08-16', inputTokens: 1, outputTokens: 1, requests: 1, cost: 0.5 },
      { date: '2026-08-17', model: 'm-a', inputTokens: 100, outputTokens: 50, reasoningTokens: 80, requests: 2, cost: 1 },
      { date: '2026-08-17', model: 'm-a', inputTokens: 1, outputTokens: 0, requests: 1, cost: 0 },
    ] });
    const cu = usage.costUsage;
    expect(cu).toMatchObject({ currencyCode: 'USD', historyDays: 30, historyLabel: 'Last 30 days (UTC)',
      last30DaysTokens: 168, last30DaysCostUSD: 3.5, last30DaysRequests: 5, meteredCostUSD: 2.5, costProvenance: 'mixed',
      updatedAt: Date.UTC(2026, 7, 17, 12) });
    expect(cu.daily.map((d: { date: string }) => d.date)).toEqual(['2026-08-16', '2026-08-17']);
    expect(cu.daily[0]).toEqual({ date: '2026-08-16', inputTokens: 1, outputTokens: 1, totalTokens: 2, requestCount: 1, costUSD: 0.5 });
    expect(cu.daily[1]).toMatchObject({ inputTokens: 111, outputTokens: 55, reasoningTokens: 80, totalTokens: 166, requestCount: 4,
      costUSD: 3, modelsUsed: ['m-a', 'm-b'], estimatedRequestCount: 1 });
    expect(cu.daily[1].modelBreakdowns).toEqual([
      { modelName: 'm-a', costUSD: 1, totalTokens: 151, requestCount: 3, inputTokens: 101, outputTokens: 50, reasoningTokens: 80 },
      { modelName: 'm-b', costUSD: 2, totalTokens: 15, requestCount: 1, inputTokens: 10, outputTokens: 5 },
    ]);
    expect(map({ ...base, entries: [] }).usage.costUsage).toMatchObject({ last30DaysTokens: 0, costProvenance: 'vendorMetered', daily: [] });
    expect(map({ ...base, entries: [{ date: '2026-08-17', inputTokens: 0, outputTokens: 0, requests: 0, cost: 1, estimatedCost: 1 }] })
      .usage.costUsage).toMatchObject({ costProvenance: 'listPriceEstimate', meteredCostUSD: null });
  });
  it('validates exactly CodexBar\'s bounds', () => {
    const entry = { date: '2026-08-17', inputTokens: 1, outputTokens: 1, requests: 1, cost: 1 };
    const cases: Array<[unknown, string]> = [
      [[], 'costUsage must be an object'],
      [{ ...base, currency: 'usd', entries: [] }, 'costUsage.currency must be a three-letter uppercase currency literal'],
      [{ ...base, historyDays: 0, entries: [] }, 'costUsage.historyDays must be a positive integer'],
      [{ ...base, historyDays: 367, entries: [] }, 'costUsage.historyDays exceeds 366'],
      [{ ...base, windowEnd: '2026-02-30', entries: [] }, 'costUsage.windowEnd must be a valid YYYY-MM-DD date'],
      [{ ...base, entries: 'x' }, 'costUsage.entries must be an array'],
      [{ ...base, entries: [{ ...entry, date: '2026-07-18' }] }, 'costUsage.entries[0].date falls outside the declared history window'],
      [{ ...base, entries: [{ ...entry, date: '2026-08-18' }] }, 'costUsage.entries[0].date falls outside the declared history window'],
      [{ ...base, entries: [{ ...entry, inputTokens: 1.5 }] }, 'costUsage.entries[0].inputTokens must be a nonnegative integer'],
      [{ ...base, entries: [{ ...entry, requests: undefined }] }, 'costUsage.entries[0].requests is required'],
      [{ ...base, entries: [{ ...entry, cost: -1 }] }, 'costUsage.entries[0].cost must be nonnegative'],
      [{ ...base, entries: [{ ...entry, estimatedCost: 2 }] }, 'costUsage.entries[0].estimatedCost must be nonnegative and no greater than cost'],
      [{ ...base, entries: [{ ...entry, inputTokens: Number.MAX_SAFE_INTEGER }] }, 'costUsage token total overflowed'],
    ];
    for (const [value, message] of cases) expect(() => map(value), message).toThrow(message);
    expect(map({ ...base, entries: [{ ...entry, date: '2026-07-19' }] }).usage.costUsage.daily[0].date).toBe('2026-07-19');
  });
  it('the reading carries costUsage (and a costUsage-only snapshot is meaningful)', () => {
    const result = mapPluginResult({ costUsage: { ...base, entries: [] } });
    expect(result.usage.costUsage).not.toBeNull();
  });
});

// ---------------------------------------------------------------- OpenAI card

describe('A3 OpenAI card (OpenAIAPIProviderDescriptor.mapPluginCard)', () => {
  const manifest = parseManifest({ id: 'openai', name: 'OpenAI', endpoints: ['https://api.openai.com'], settings: [] });
  const day = { startTime: 1786924800, endTime: 1787011200, costUSD: 1.25, requests: 3, inputTokens: 10, cachedInputTokens: 2,
    outputTokens: 5, totalTokens: 15, lineItems: [{ name: 'Responses', costUSD: 1.25 }],
    models: [{ name: 'gpt-x', requests: 3, inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15 }] };
  const map = (card: unknown) => mapPluginResult({ usage: { cost: { used: 1.25, currency: 'USD' } }, card }, { manifest, now: Date.UTC(2026, 7, 18) });
  it('maps the history and keeps projectID out of the reading', () => {
    const result = map({ openAIAPIUsage: { historyDays: 30, projectID: 'proj-secret', daily: [day], live: { bogus: true } } });
    expect(result.usage.openAIAPIUsage).toMatchObject({ historyDays: 30, projectID: 'proj-secret' });
    expect(result.usage.openAIAPIUsage.daily[0]).toMatchObject({ day: '2026-08-17', costUSD: 1.25, requests: 3, totalTokens: 15,
      lineItems: [{ name: 'Responses', costUSD: 1.25 }], models: [{ name: 'gpt-x', requests: 3 }] });
  });
  it('validates like CodexBar; other providers may not send a card', () => {
    const cases: Array<[unknown, string]> = [
      [{ other: 1 }, 'card contains unknown keys'],
      [{}, 'card.openAIAPIUsage is required'],
      [{ openAIAPIUsage: { historyDays: 0, daily: [] } }, 'historyDays must be positive'],
      [{ openAIAPIUsage: { historyDays: 366, daily: [] } }, 'card.historyDays must be a bounded nonnegative integer'],
      [{ openAIAPIUsage: { historyDays: 1, daily: [], extra: 1 } }, 'card.openAIAPIUsage contains unknown keys'],
      [{ openAIAPIUsage: { historyDays: 1, daily: [{ ...day, endTime: day.startTime }] } }, 'invalid card bucket interval'],
      [{ openAIAPIUsage: { historyDays: 1, daily: [{ ...day, requests: -1 }] } }, 'card.requests must be a bounded nonnegative integer'],
      [{ openAIAPIUsage: { historyDays: 1, daily: Array.from({ length: 367 }, () => day) } }, 'card.daily must be a bounded array'],
    ];
    for (const [card, message] of cases) expect(() => map(card), message).toThrow(message);
    const fw = parseManifest({ id: 'fireworks', name: 'F', endpoints: ['https://api.fireworks.ai'], settings: [] });
    expect(() => mapPluginResult({ usage: { empty: true }, card: { openAIAPIUsage: {} } }, { manifest: fw })).toThrow('card is not allowed for this provider');
  });
});

// ---------------------------------------------------------------- OpenRouter management auth

describe('A3 openRouterManagementAuth (ProviderPluginManagementAuthTests + OpenRouterManagementActivityTests)', () => {
  const orManifest = (id = 'openrouter', kind = 'secure') => parseManifest({ id, name: 'Fixture', endpoints: ['https://openrouter.ai'],
    auth: { type: 'bearer', secret: 'OPENROUTER_API_KEY' },
    settings: [{ key: 'OPENROUTER_API_KEY', title: 'Key', type: 'secure' }, { key: 'OPENROUTER_MANAGEMENT_API_KEY', title: 'M', type: kind }] });
  const secrets = { OPENROUTER_API_KEY: 'primary-fixture', OPENROUTER_MANAGEMENT_API_KEY: 'separate-fixture' };
  const build = (url: string, method = 'GET', m = orManifest(), opts: Record<string, unknown> = { openRouterManagementAuth: true }) =>
    buildRequest(m, url, method === 'POST' ? { ...opts, bodyJSON: '{}' } : opts, method, {}, secrets);

  it('pinned to the declared secret and the official read endpoint', () => {
    expect(build('https://openrouter.ai/api/v1/activity?date=2026-09-12').headers.Authorization).toBe('Bearer separate-fixture');
    expect(build('https://openrouter.ai/api/v1/activity').headers.Authorization).toBe('Bearer separate-fixture');
    expect(() => build('https://openrouter.ai/api/v1/activity', 'GET', orManifest('synthetic'))).toThrow('OpenRouter management auth is unavailable');
    expect(() => build('https://openrouter.ai/api/v1/activity', 'GET', orManifest('openrouter', 'plain'))).toThrow('OpenRouter management auth is unavailable');
    expect(() => build('https://openrouter.ai/api/v1/activity', 'POST')).toThrow('OpenRouter management auth is unavailable');
    for (const flag of [false, 'true', 1, null])
      expect(() => build('https://openrouter.ai/api/v1/activity', 'GET', orManifest(), { openRouterManagementAuth: flag })).toThrow('OpenRouter management auth is unavailable');
    expect(build('https://openrouter.ai/api/v1/key', 'GET', orManifest(), {}).headers.Authorization).toBe('Bearer primary-fixture');
  });

  it.each([
    'https://openrouter.ai:443/api/v1/activity',
    'https://user@openrouter.ai/api/v1/activity',
    'https://openrouter.ai/api/v1/keys',
    'https://openrouter.ai/api/v1/activity#fragment',
    'https://openrouter.ai/api/v1/./activity',
  ])('rejects endpoint variation %s', url => {
    expect(() => build(url)).toThrow(/OpenRouter management auth is unavailable|not declared|endpoint policy/);
  });

  const now = 1_787_079_600_000;
  const handler = (activityStatus: number, managementFlag: string) => (req: Req) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/v1/activity') return { status: activityStatus, body: '{"data":[{"date":"2026-08-17","model":"example-model","prompt_tokens":100,"completion_tokens":50,"reasoning_tokens":80,"requests":2,"usage":1}]}' };
    if (path.endsWith('/key')) return { body: `{"data":{"limit":20,"usage":5,"is_management_key":${managementFlag}}}` };
    return { body: '{"data":{"total_credits":100,"total_usage":40}}' };
  };
  const read = async (opts: { separate?: boolean; flag?: string; status?: number }) => {
    const { transport, requests } = fixture(handler(opts.status ?? 200, opts.flag ?? 'true'));
    const env: Record<string, string> = { OCLI_USAGE_READERS_CONFIG: join(tempDir(), 'none.json'), OPENROUTER_API_KEY: 'primary-fixture' };
    if (opts.separate) env.OPENROUTER_MANAGEMENT_API_KEY = 'separate-fixture';
    return { result: await readPluginUsage('openrouter', { env, transport, now }), requests };
  };

  it('separate management credential wins on activity only; the regular key never rides that request', async () => {
    const { result, requests } = await read({ separate: true });
    expect(result.reading.status).toBe('ok');
    const activity = requests.filter(r => new URL(r.url).pathname === '/api/v1/activity');
    expect(activity).toHaveLength(2);
    for (const r of requests) {
      const isActivity = new URL(r.url).pathname === '/api/v1/activity';
      expect(header(r, 'Authorization')).toBe(isActivity ? 'Bearer separate-fixture' : 'Bearer primary-fixture');
      if (isActivity) expect(JSON.stringify(r.headers)).not.toContain('primary-fixture');
    }
    const section = result.reading.details.find((d: { title?: string }) => d.title === 'Activity (last 30 completed UTC days)');
    expect(section.rows.map((r: { value: string }) => r.value)).toEqual(['150', '2', '1']);
    expect(result.reading.costUsage.last30DaysTokens).toBe(150);
    expect(result.reading.costUsage.daily[0].reasoningTokens).toBe(80);
    expect(result.reading.costUsage.daily[0].modelBreakdowns).toHaveLength(1);
    expect(result.reading.cost).toBeUndefined();
    expect(result.reading.windows[0]).toMatchObject({ limitId: 'openrouter-primary', usedPercent: 25 });
  });

  it('official base promotes the primary management key (no management option sent)', async () => {
    const { result, requests } = await read({});
    const activity = requests.filter(r => new URL(r.url).pathname === '/api/v1/activity');
    expect(activity).toHaveLength(2);
    expect(activity.every(r => header(r, 'Authorization') === 'Bearer primary-fixture')).toBe(true);
    expect(result.reading.costUsage).toBeDefined();
  });

  it('unrecognized metadata preserves quota without activity; a 403 activity preserves quota and balance', async () => {
    for (const flag of ['false', '"true"', 'null', '42']) {
      const { result, requests } = await read({ flag });
      expect(result.reading.windows[0].usedPercent).toBe(25);
      expect(result.reading.costUsage).toBeUndefined();
      expect(requests).toHaveLength(2);
    }
    const { result } = await read({ separate: true, status: 403 });
    expect(result.reading.windows[0].usedPercent).toBe(25);
    expect(result.reading.costUsage).toBeUndefined();
    const rows = result.reading.details.flatMap((d: { rows: Array<{ label: string }> }) => d.rows);
    expect(rows.find((r: { label: string }) => r.label === 'Remaining').value).toBe('$60.00');
    expect(rows.find((r: { label: string }) => r.label === 'Last 30 days').secondaryValue).toBe('Management API key required');
  });
});
