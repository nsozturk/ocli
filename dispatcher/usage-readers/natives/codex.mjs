/**
 * N1 — Codex native usage reader: auth.json credentials, OAuth/PAT usage, token refresh + write-back, strategy chain.
 *
 * Ported from CodexBar @ 6480977 (MIT, © 2026 Peter Steinberger; LICENSE-CodexBar beside the plugins):
 *   Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift (resolveStrategies L151-173, CLI L284-338,
 *     OAuthNativeRefreshCLI L342-377, OAuth L379-527: loadCredentials rereads L392-415, prepareCredentials L466-476,
 *     shouldFallback L490-527, mapCredits L529-547, makeResult L617-671),
 *   CodexOAuth/CodexOAuthCredentials.swift (needsRefresh L51-62, authFilePath L97-112, loadForUsage L161-183,
 *     parse L193-322, save L324-364, external fallback L366-446, JWT claims L483-556),
 *   CodexOAuth/CodexOAuthUsageFetcher.swift (response decoding L6-334, fetch L399-424, URL resolution L564-684),
 *   CodexOAuth/CodexTokenRefresher.swift, CodexRateWindowNormalizer.swift, CodexAdditionalRateLimitMapper.swift,
 *   CodexReconciledState.swift (fromOAuth/fromPAT/identity), CodexAuthenticatedHTTPTransport.swift (status mapping),
 *   CodexSpendControlLimitMapping.swift, CodexSpendControlNumber.swift, CodexHomeScope.swift,
 *   CodexPAT/CodexPATFetchStrategy.swift, CodexPAT/CodexPATUsageFetcher.swift, CodexPAT/CodexCLIUserAgent.swift,
 *   CredentialFileWriter.swift (writePrivate), Providers/ProviderFetchPlan.swift (pipeline L396-463).
 *
 * Refresh: CodexBar DELEGATES it. In 6480977 nothing in Sources calls CodexTokenRefresher.refresh or
 * CodexOAuthCredentialsStore.save; a stale native token makes the OAuth strategy throw nativeRefreshRequired (L466-476)
 * and the chain moves on to the codex CLI (auto: `codex.cli`; oauth mode: `codex.oauth-native-refresh-cli`), whose
 * app-server refreshes and rewrites its own auth.json. The refresher and the writer are ported (exported, exact) but the
 * chain never calls them, so a usage read never writes.
 *
 * Tokens are secrets: never logged, never in an error, a reason or a reading (a per-read redaction set backs that up).
 * Identity (email / plan / account id) is returned beside the reading, never inside it. In a test process the defaults
 * fail closed: no network, no codex binary, nothing under the real home directory (CodexCredentialFileAccess.permits).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, fchmodSync, accessSync, constants } from 'node:fs';
import { homedir, release, arch } from 'node:os';
import { delimiter, isAbsolute, join, dirname, basename, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCodexUsage as readCodexAppServerUsage } from '../../usage.mjs';
import { redirectAllowed, MAX_RESPONSE_BYTES } from '../plugin-host.mjs';

export const CODEX_NATIVE_SOURCE = 'native:codex';
export const CODEX_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/';
const CHATGPT_USAGE_PATH = '/wham/usage';
const CODEX_USAGE_PATH = '/api/codex/usage';
const WHOAMI_URL = 'https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami';
const CLI_ORIGINATOR = 'codex_cli_rs';
const HTTP_TIMEOUT_MS = 30_000;
const STALE_REREAD_MS = 50;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
// Chrono 0.4's UTC range, as CodexOAuthCredentials.swift L94-95.
const JWT_EXP_MIN = -8_334_601_228_800n;
const JWT_EXP_MAX = 8_210_266_876_799n;

/** Every failure carries only a typed reason (`<area>:<code>`), never a token, a body or a path. */
export class CodexNativeError extends Error {
  constructor(reason) {
    super(`codex native: ${reason}`);
    this.name = 'CodexNativeError';
    this.reason = reason;
  }
}
const fail = reason => { throw new CodexNativeError(reason); };
const reasonOf = error => (error instanceof CodexNativeError ? error.reason : 'unexpected');

// ---------------------------------------------------------------- test-process guard (CodexCredentialFileAccess)

const isTestProcess = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
const realHome = homedir();
function permits(path) {
  if (!isTestProcess()) return true;
  const p = resolve(path);
  return p !== realHome && !p.startsWith(realHome + sep);
}

// ---------------------------------------------------------------- small helpers

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const stringValue = (obj, snake, camel) => {
  if (typeof obj[snake] === 'string' && obj[snake]) return obj[snake];
  if (typeof obj[camel] === 'string' && obj[camel]) return obj[camel];
  return null;
};
const isoOrNull = ms => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** ISO8601DateFormatter's default: no fractional seconds. */
const iso8601Seconds = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const raw = jwtPayloadText(parts[1]);
  if (raw === null) return null;
  try { const v = JSON.parse(raw); return isObject(v) ? v : null; } catch { return null; }
}
function jwtPayloadText(part) {
  let encoded = part.replace(/-/g, '+').replace(/_/g, '/');
  encoded += '='.repeat((4 - (encoded.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** expirationFromJWT L516-556: a top-level integer-spelled `exp`, exactly once, within chrono's range. */
function expirationFromJWT(accessToken) {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts.some(p => !p)) return null;
  const text = jwtPayloadText(parts[1]);
  if (text === null) return null;
  try { if (!isObject(JSON.parse(text))) return null; } catch { return null; }
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  let depth = 0;
  let exp = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '{' || t === '[') { depth += 1; continue; }
    if (t === '}' || t === ']') { depth -= 1; continue; }
    let key;
    try { key = JSON.parse(t); } catch { continue; }
    if (depth !== 1 || i + 2 >= tokens.length || tokens[i + 1] !== ':' || key !== 'exp') continue;
    if (exp !== null || !/^[+-]?\d+$/.test(tokens[i + 2])) return null;
    exp = BigInt(tokens[i + 2]);
  }
  if (exp === null || exp < JWT_EXP_MIN || exp > JWT_EXP_MAX) return null;
  return Number(exp) * 1000;
}

/** accountIDFromJWT L483-513. */
function accountIdFromJWT(idToken, accessToken) {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = jwtPayload(token);
    if (!payload) continue;
    const direct = nonEmpty(payload.chatgpt_account_id);
    if (direct) return direct;
    const auth = payload['https://api.openai.com/auth'];
    if (isObject(auth) && nonEmpty(auth.chatgpt_account_id)) return nonEmpty(auth.chatgpt_account_id);
    if (Array.isArray(payload.organizations)) {
      const id = payload.organizations.map(o => (isObject(o) ? nonEmpty(o.id) : null)).find(Boolean);
      if (id) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------- credentials (CodexOAuthCredentials.swift)

/** CodexHomeScope.ambientHomeURL + authFilePath: a non-blank CODEX_HOME (trimmed, as-is) scopes it. */
export function codexHomeDir({ env = process.env, homeDir = realHome } = {}) {
  const raw = nonEmpty(env.CODEX_HOME);
  return raw ?? join(homeDir, '.codex');
}
export function codexAuthFilePath(opts = {}) {
  return join(codexHomeDir(opts), 'auth.json');
}

/** CodexHomeScope.normalizedHomePath L21-40. */
function normalizedHomePath(raw, homeDir) {
  let path = nonEmpty(raw);
  if (!path) return null;
  if (path === '~') path = homeDir;
  else if (path.startsWith('~/')) path = join(homeDir, path.slice(2));
  else if (path.startsWith('~')) return null;
  if (!isAbsolute(path)) return null;
  return resolve(path);
}

const defaultReadFile = path => readFileSync(path, 'utf8');
function readAuthText(path, readFile) {
  if (!permits(path)) fail('credentials:not-found');
  try {
    return readFile(path);
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'credentials:not-found' : 'credentials:unreadable');
  }
}
function decodeObject(text) {
  let json;
  try { json = JSON.parse(text); } catch { fail('credentials:decode-failed'); }
  if (!isObject(json)) fail('credentials:decode-failed');
  return json;
}

function tokenCredentials(json, source) {
  const tokens = json.tokens;
  if (!isObject(tokens)) return null;
  const accessToken = stringValue(tokens, 'access_token', 'accessToken');
  const refreshToken = stringValue(tokens, 'refresh_token', 'refreshToken');
  if (!accessToken || !refreshToken) return null;
  const idToken = stringValue(tokens, 'id_token', 'idToken');
  const accountId = nonEmpty(stringValue(tokens, 'account_id', 'accountId')) ?? accountIdFromJWT(idToken, accessToken);
  const lastRefreshMs = typeof json.last_refresh === 'string' && json.last_refresh ? Date.parse(json.last_refresh) : NaN;
  return {
    accessToken, refreshToken, idToken, accountId,
    lastRefresh: Number.isFinite(lastRefreshMs) ? lastRefreshMs : null,
    expiresAt: source === 'codexHome' ? expirationFromJWT(accessToken) : null,
    source, isAPIKey: false,
  };
}

/** parse L193-208: an OPENAI_API_KEY wins, then `tokens`, else missing tokens. */
export function parseCodexCredentials(text, { source = 'codexHome' } = {}) {
  const json = decodeObject(text);
  if (typeof json.OPENAI_API_KEY === 'string' && json.OPENAI_API_KEY.trim()) {
    return { accessToken: json.OPENAI_API_KEY, refreshToken: '', idToken: null, accountId: null, lastRefresh: null,
      expiresAt: null, source, isAPIKey: true };
  }
  return tokenCredentials(json, source) ?? fail('credentials:missing-tokens');
}
function parseOAuthTokens(text, source) {
  return tokenCredentials(decodeObject(text), source) ?? fail('credentials:missing-tokens');
}
function parseOpenCode(text) {
  const auth = decodeObject(text).openai;
  const access = isObject(auth) ? nonEmpty(auth.access) : null;
  if (!isObject(auth) || nonEmpty(auth.type)?.toLowerCase() !== 'oauth' || !access) fail('credentials:missing-tokens');
  const expires = typeof auth.expires === 'number' && Number.isFinite(auth.expires) && auth.expires >= 0 ? auth.expires : null;
  return { accessToken: access, refreshToken: nonEmpty(auth.refresh) ?? '', idToken: null, accountId: nonEmpty(auth.accountId),
    lastRefresh: null, expiresAt: expires, source: 'openCode', isAPIKey: false };
}

/** CodexOAuthCredentials.needsRefresh L51-62. */
export function credentialsNeedRefresh(c, nowMs = Date.now()) {
  if (c.isAPIKey) return false;
  if (c.expiresAt !== null && c.expiresAt !== undefined) {
    const windowMs = c.source === 'codexHome' ? 5 * 60_000 : 60_000;
    return c.expiresAt - nowMs <= windowMs;
  }
  if (c.lastRefresh === null || c.lastRefresh === undefined) return true;
  return nowMs - c.lastRefresh > EIGHT_DAYS_MS;
}

/**
 * loadForUsage L161-183: the native home wins; external sources (legacy ~/.config/codex, OpenCode) only on opt-in, only
 * when CODEX_HOME is unset and the native file is missing.
 */
export function loadCodexCredentials({ env = process.env, homeDir = realHome, readFile = defaultReadFile, allowExternalSources = false } = {}) {
  try {
    return parseCodexCredentials(readAuthText(codexAuthFilePath({ env, homeDir }), readFile));
  } catch (error) {
    if (!allowExternalSources || nonEmpty(env.CODEX_HOME) || reasonOf(error) !== 'credentials:not-found') throw error;
    try { return parseOAuthTokens(readAuthText(join(homeDir, '.config', 'codex', 'auth.json'), readFile), 'legacyCodexHome'); } catch { /* next */ }
    try {
      const root = normalizedHomePath(env.XDG_DATA_HOME, homeDir) ?? join(homeDir, '.local', 'share');
      return parseOpenCode(readAuthText(join(root, 'opencode', 'auth.json'), readFile));
    } catch { /* surface the native error */ }
    throw error;
  }
}

function loadPAT(env, homeDir, readFile) {
  const json = decodeObject(readAuthText(codexAuthFilePath({ env, homeDir }), readFile));
  const token = nonEmpty(json.personal_access_token) ?? nonEmpty(json.personalAccessToken);
  return token ? { token, source: 'codexHome' } : fail('credentials:missing-tokens');
}

/** CodexPATFetchStrategy.credentialEnvironment L49-81: a managed / fail-closed or PAT-less CODEX_HOME reads ambient. */
export function patCredentialEnvironment(env, { homeDir = realHome, readFile = defaultReadFile } = {}) {
  if (env.CODEX_HOME === undefined) return env;
  const normalized = resolve(env.CODEX_HOME);
  const managed = basename(normalized) === 'managed-store-unreadable' || normalized.split('/').includes('managed-codex-homes');
  if (!managed) {
    try { loadPAT(env, homeDir, readFile); return env; } catch { /* ambient */ }
  }
  const ambient = { ...env };
  const home = nonEmpty(env.HOME);
  if (home) ambient.CODEX_HOME = resolve(home, '.codex');
  else delete ambient.CODEX_HOME;
  return ambient;
}

// ---------------------------------------------------------------- write-back (save L324-364 + CredentialFileWriter)

/** Recursively sorted keys — JSONSerialization `.sortedKeys`. */
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys)
  : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);

/** CredentialFileWriter.writePrivate: a 0700 staging dir beside the target, O_EXCL 0600 file, fsync, rename(2). */
export function writePrivateFile(path, text) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const staging = join(directory, `.codexbar-staged-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const staged = join(staging, basename(path));
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * CodexOAuthCredentialsStore.save: only the native home is writable; the existing JSON is kept, `tokens` is replaced
 * whole, `last_refresh` is the credential's own timestamp (never "now"). CodexBar's usage path never calls this.
 */
export function saveCodexCredentials(credentials, { env = process.env, homeDir = realHome, readFile = defaultReadFile } = {}) {
  if (credentials.source !== 'codexHome') fail('credentials:read-only-source');
  const path = codexAuthFilePath({ env, homeDir });
  if (!permits(path)) fail('credentials:not-found');
  let json = {};
  try { const existing = JSON.parse(readFile(path)); if (isObject(existing)) json = existing; } catch { /* start fresh */ }
  const tokens = { access_token: credentials.accessToken, refresh_token: credentials.refreshToken };
  if (credentials.idToken !== null && credentials.idToken !== undefined) tokens.id_token = credentials.idToken;
  if (credentials.accountId !== null && credentials.accountId !== undefined) tokens.account_id = credentials.accountId;
  json.tokens = tokens;
  if (credentials.lastRefresh !== null && credentials.lastRefresh !== undefined) json.last_refresh = iso8601Seconds(credentials.lastRefresh);
  writePrivateFile(path, JSON.stringify(sortKeys(json), null, 2));
}

// ---------------------------------------------------------------- HTTP (CodexAuthenticatedHTTPTransport)

/** Default transport: fetch with CodexBar's redirect guard (same-origin HTTPS only). Refused in a test process. */
export async function defaultCodexTransport({ url, method, headers, body, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = HTTP_TIMEOUT_MS }) {
  if (isTestProcess()) throw new Error('network refused in a test process');
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, current);
      if (!redirectAllowed(current, next)) return { status: res.status, headers: {}, body: Buffer.alloc(0) };
      current = next.href;
      continue;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) { await res.body.cancel?.().catch(() => {}); throw new Error('response too large'); }
      chunks.push(chunk);
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}

const bodyText = body => (typeof body === 'string' ? body : Buffer.from(body ?? []).toString('utf8'));

/** perform L18-40: 2xx ⇒ body, 401 ⇒ unauthorized, else server error (the body is dropped: it can echo a token). */
async function perform(transport, request, area = 'oauth') {
  let res;
  try { res = await transport(request); } catch { fail(`${area}:network-error`); }
  if (res.status >= 200 && res.status <= 299) return bodyText(res.body);
  if (res.status === 401) fail(`${area}:unauthorized`);
  fail(`${area}:server-error:${res.status}`);
}
const parseJSONOr = (text, reason) => { try { return JSON.parse(text); } catch { return fail(reason); } };

// ---------------------------------------------------------------- usage URL (L564-684)

function parseChatGPTBaseURL(contents) {
  for (const rawLine of contents.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.split('#')[0].trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0 || at === trimmed.length - 1) continue;
    if (trimmed.slice(0, at).trim() !== 'chatgpt_base_url') continue;
    let value = trimmed.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value.trim();
  }
  return null;
}
function normalizeChatGPTBaseURL(value) {
  let trimmed = value.trim() || DEFAULT_CHATGPT_BASE_URL;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  if ((trimmed.startsWith('https://chatgpt.com') || trimmed.startsWith('https://chat.openai.com')) && !trimmed.includes('/backend-api')) {
    trimmed += '/backend-api';
  }
  return trimmed;
}
/** `chatgpt_base_url` from <CODEX_HOME or ~/.codex>/config.toml; a /backend-api base uses /wham/usage. */
export function resolveCodexUsageURL({ env = process.env, homeDir = realHome, readFile = defaultReadFile } = {}) {
  let contents = null;
  const configPath = join(codexHomeDir({ env, homeDir }), 'config.toml');
  if (permits(configPath)) { try { contents = readFile(configPath); } catch { /* default */ } }
  const normalized = normalizeChatGPTBaseURL((contents !== null && parseChatGPTBaseURL(contents)) || DEFAULT_CHATGPT_BASE_URL);
  const full = normalized + (normalized.includes('/backend-api') ? CHATGPT_USAGE_PATH : CODEX_USAGE_PATH);
  try { new URL(full); return full; } catch { return DEFAULT_CHATGPT_BASE_URL.slice(0, -1) + CHATGPT_USAGE_PATH; }
}

// ---------------------------------------------------------------- response decoding (CodexUsageResponse)

const hasValue = (obj, key) => Object.hasOwn(obj, key) && obj[key] !== null;
const isInt = v => typeof v === 'number' && Number.isSafeInteger(v);
function decodeDouble(obj, key) {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.trim()))) return Number(v.trim());
  return null;
}
function decodeInteger(obj, key) {
  const v = obj[key];
  if (isInt(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isSafeInteger(Math.trunc(v)) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
/** SpendControlLimitSnapshot L279-306: `wham/usage` spells the reset `reset_at`, other shapes `resetsAt` / `resets_at`. */
function decodeLimit(v) {
  if (!isObject(v)) return null;
  return {
    limit: decodeDouble(v, 'limit'),
    used: decodeDouble(v, 'used'),
    remainingPercent: decodeDouble(v, 'remainingPercent') ?? decodeDouble(v, 'remaining_percent'),
    resetsAt: decodeInteger(v, 'resetsAt') ?? decodeInteger(v, 'resets_at') ?? decodeInteger(v, 'reset_at'),
  };
}
const decodeLimitPair = v => (isObject(v) ? decodeLimit(v.individual_limit) ?? decodeLimit(v.individualLimit) : null);
function decodeWindow(v) {
  if (!isObject(v) || !isInt(v.used_percent) || !isInt(v.reset_at) || !isInt(v.limit_window_seconds)) return null;
  return { usedPercent: v.used_percent, resetAt: v.reset_at, limitWindowSeconds: v.limit_window_seconds };
}
function decodeRateLimit(v) {
  if (!isObject(v)) return null;
  const primaryWindow = hasValue(v, 'primary_window') ? decodeWindow(v.primary_window) : null;
  const secondaryWindow = hasValue(v, 'secondary_window') ? decodeWindow(v.secondary_window) : null;
  const primaryFailed = hasValue(v, 'primary_window') && !primaryWindow;
  const secondaryFailed = hasValue(v, 'secondary_window') && !secondaryWindow;
  return { primaryWindow, secondaryWindow, individualLimit: decodeLimitPair(v),
    hasWindowDecodeFailure: primaryFailed || secondaryFailed };
}
function decodeAdditional(v) {
  if (!isObject(v)) return null;
  const rateLimit = hasValue(v, 'rate_limit') ? decodeRateLimit(v.rate_limit) : null;
  const rateLimitFailed = hasValue(v, 'rate_limit') && !rateLimit;
  return {
    limitName: typeof v.limit_name === 'string' ? v.limit_name : null,
    meteredFeature: typeof v.metered_feature === 'string' ? v.metered_feature : null,
    rateLimit,
    hasWindowDecodeFailure: rateLimitFailed || rateLimit?.hasWindowDecodeFailure === true,
  };
}
function decodeCredits(v) {
  if (!isObject(v)) return null;
  let balance = null;
  if (typeof v.balance === 'number' && Number.isFinite(v.balance)) balance = v.balance;
  else if (typeof v.balance === 'string' && v.balance && Number.isFinite(Number(v.balance))) balance = Number(v.balance);
  return { hasCredits: v.has_credits === true, unlimited: v.unlimited === true, balance };
}

/** CodexUsageResponse.init(from:) — every optional part decodes on its own; one bad part never discards the rest. */
export function decodeCodexUsageResponse(json) {
  if (!isObject(json)) fail('oauth:invalid-response');
  const rateLimit = decodeRateLimit(json.rate_limit);
  const individualLimit = decodeLimit(json.individual_limit) ?? decodeLimit(json.individualLimit);
  const spendControlIndividualLimit = decodeLimitPair(json.spend_control) ?? decodeLimitPair(json.spendControl);
  let additionalRateLimits = null;
  let additionalRateLimitsDecodeFailed = false;
  if (Array.isArray(json.additional_rate_limits)) {
    const decoded = json.additional_rate_limits.map(decodeAdditional);
    additionalRateLimits = decoded.filter(Boolean);
    additionalRateLimitsDecodeFailed = decoded.some(d => !d) || additionalRateLimits.some(d => d.hasWindowDecodeFailure);
  } else if (hasValue(json, 'additional_rate_limits')) {
    additionalRateLimitsDecodeFailed = true;
  }
  return {
    accountId: typeof json.account_id === 'string' ? json.account_id : typeof json.accountId === 'string' ? json.accountId : null,
    planType: typeof json.plan_type === 'string' ? json.plan_type : null,
    rateLimit,
    credits: decodeCredits(json.credits),
    individualLimit,
    spendControlIndividualLimit,
    spendControlPresent: Object.hasOwn(json, 'spend_control') || Object.hasOwn(json, 'spendControl'),
    additionalRateLimits,
    additionalRateLimitsDecodeFailed,
    // L72-75: root, then rate_limit, then spend_control.
    resolvedIndividualLimit: individualLimit ?? rateLimit?.individualLimit ?? spendControlIndividualLimit,
  };
}

// ---------------------------------------------------------------- mapping (ReconciledState, normalizer, extras)

/** CodexReconciledState.makeWindow: reset_at is always a date; minutes = seconds / 60 (integer division). */
const makeWindow = w => (w ? { usedPercent: w.usedPercent, windowMinutes: Math.trunc(w.limitWindowSeconds / 60), resetsAtMs: w.resetAt * 1000 } : null);
const role = w => (w.windowMinutes === 300 ? 'session' : w.windowMinutes === 10080 ? 'weekly' : 'unknown');

/** CodexRateWindowNormalizer.normalize. */
export function normalizeCodexWindows(primary, secondary) {
  if (primary && secondary) {
    const pair = `${role(primary)}/${role(secondary)}`;
    return pair === 'weekly/session' || pair === 'weekly/unknown' ? [secondary, primary] : [primary, secondary];
  }
  if (primary) return role(primary) === 'weekly' ? [null, primary] : [primary, null];
  if (secondary) return role(secondary) === 'weekly' ? [null, secondary] : [secondary, null];
  return [null, null];
}

function slug(value) {
  let out = '';
  let lastDash = false;
  for (const ch of value.toLowerCase()) {
    if (/[\p{L}\p{N}\p{M}]/u.test(ch)) { out += ch; lastDash = false; } else if (!lastDash) { out += '-'; lastDash = true; }
  }
  return out.replace(/^-+|-+$/g, '');
}
const firstNonEmpty = (...values) => values.map(nonEmpty).find(Boolean) ?? null;
function namedWindow(id, w) {
  return { limitId: id, usedPercent: w.usedPercent,
    windowDurationMins: w.limitWindowSeconds > 0 ? Math.trunc(w.limitWindowSeconds / 60) : null,
    resetsAt: w.resetAt > 0 ? isoOrNull(w.resetAt * 1000) : null };
}

/** CodexAdditionalRateLimitMapper.extraRateWindows: Spark gets stable 5h/weekly ids, others `codex-<slug>`, ids unique. */
export function codexExtraWindows(additional) {
  if (!additional?.length) return [];
  const used = new Set();
  const out = [];
  for (const entry of additional) {
    const isSpark = [entry.limitName, entry.meteredFeature].some(v => typeof v === 'string' && v.toLowerCase().includes('spark'));
    if (isSpark) {
      for (const [w, fallback] of [[entry.rateLimit?.primaryWindow, 'codex-spark'], [entry.rateLimit?.secondaryWindow, 'codex-spark-weekly']]) {
        if (!w) continue;
        const minutes = w.limitWindowSeconds > 0 ? Math.trunc(w.limitWindowSeconds / 60) : 0;
        const id = minutes > 0 && minutes <= 360 ? 'codex-spark' : minutes >= 8640 ? 'codex-spark-weekly' : fallback;
        if (used.has(id)) continue;
        used.add(id);
        out.push(namedWindow(id, w));
      }
      continue;
    }
    const w = entry.rateLimit?.primaryWindow ?? entry.rateLimit?.secondaryWindow;
    if (!w) continue;
    const source = firstNonEmpty(entry.meteredFeature, entry.limitName);
    const s = source ? slug(source) : '';
    if (!s || used.has(`codex-${s}`)) continue;
    used.add(`codex-${s}`);
    out.push(namedWindow(`codex-${s}`, w));
  }
  return out;
}

/** SpendControlLimitSnapshot.codexCreditLimitSnapshot. */
function creditLimitSnapshot(l) {
  if (!l || l.limit === null || !(l.limit > 0)) return null;
  const used = l.used ?? (l.remainingPercent !== null ? l.limit * Math.max(0, Math.min(100, 100 - l.remainingPercent)) / 100 : 0);
  const remainingPercent = l.remainingPercent ?? Math.max(0, Math.min(100, 100 - (used / l.limit) * 100));
  return { used, limit: l.limit, remainingPercent, resetsAt: l.resetsAt !== null && l.resetsAt > 0 ? isoOrNull(l.resetsAt * 1000) : null };
}
/**
 * OAuth mapCredits L529-547 with includeCredits = false (no enrichment fetches here): availability only alongside a
 * balance. The PAT mapCredits (CodexPATFetchStrategy L132-148) reports availability unconditionally.
 */
function mapCredits(response, strategy) {
  const balance = response.credits?.balance ?? null;
  const codexCreditLimit = creditLimitSnapshot(response.resolvedIndividualLimit);
  const creditsAvailable = response.credits ? response.credits.hasCredits && !response.credits.unlimited : null;
  if (balance === null && !codexCreditLimit && creditsAvailable !== true) return null;
  const credits = { remaining: balance ?? 0, balanceReadSucceeded: balance !== null,
    creditsAvailable: strategy === 'codex.pat' || balance !== null ? creditsAvailable : null };
  if (codexCreditLimit) credits.codexCreditLimit = codexCreditLimit;
  return credits;
}

function idTokenIdentity(credentials) {
  const payload = credentials?.idToken ? jwtPayload(credentials.idToken) : null;
  const profile = isObject(payload?.['https://api.openai.com/profile']) ? payload['https://api.openai.com/profile'] : null;
  const auth = isObject(payload?.['https://api.openai.com/auth']) ? payload['https://api.openai.com/auth'] : null;
  const email = typeof payload?.email === 'string' ? payload.email : typeof profile?.email === 'string' ? profile.email : null;
  const plan = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type
    : typeof payload?.chatgpt_plan_type === 'string' ? payload.chatgpt_plan_type : null;
  return { email: email?.trim() ?? null, plan: plan?.trim() ?? null };
}

/**
 * makeResult L617-671 → our reading. limitIds stay compatible with the app-server reading: the session and weekly
 * windows are both `codex` (as `rateLimitsByLimitId.codex` primary/secondary); extras keep CodexBar's ids. Identity is
 * returned beside the reading. No windows and no credits ⇒ usage:no-rate-limits.
 */
export function mapCodexUsage(response, { credentials = null, whoami = null, nowMs = Date.now(), strategy = 'codex.oauth' } = {}) {
  const [session, weekly] = normalizeCodexWindows(makeWindow(response.rateLimit?.primaryWindow), makeWindow(response.rateLimit?.secondaryWindow));
  const credits = mapCredits(response, strategy);
  if (!session && !weekly && !credits) fail('usage:no-rate-limits');
  const windows = [];
  for (const w of [session, weekly]) {
    if (w) windows.push({ limitId: 'codex', usedPercent: w.usedPercent, windowDurationMins: w.windowMinutes, resetsAt: isoOrNull(w.resetsAtMs) });
  }
  if (session || weekly) windows.push(...codexExtraWindows(response.additionalRateLimits));
  const reading = { status: 'ok', source: CODEX_NATIVE_SOURCE, strategy, updatedAt: isoOrNull(nowMs), windows,
    dataConfidence: response.rateLimit?.hasWindowDecodeFailure || response.additionalRateLimitsDecodeFailed ? 'unknown' : 'exact' };
  if (credits) reading.credits = credits;
  const fromToken = idTokenIdentity(credentials);
  const identity = whoami
    ? { email: whoami.email, plan: nonEmpty(response.planType) ?? whoami.planType, accountId: whoami.accountId }
    : { email: fromToken.email, plan: nonEmpty(response.planType) ?? fromToken.plan, accountId: credentials?.accountId ?? null };
  return { reading, identity };
}

// ---------------------------------------------------------------- fetchers

/** CodexOAuthUsageFetcher.fetchUsage L399-424. */
export async function fetchCodexOAuthUsage({ accessToken, accountId, url, transport = defaultCodexTransport }) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'CodexBar', Accept: 'application/json' };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const text = await perform(transport, { url, method: 'GET', headers, timeoutMs: HTTP_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
  return decodeCodexUsageResponse(parseJSONOr(text, 'oauth:invalid-response'));
}

/** CodexCLIUserAgent.make. */
export function codexCLIUserAgent(cliVersion, { platform = process.platform, osVersion = release(), architecture = arch() } = {}) {
  const parts = nonEmpty(cliVersion)?.split(/\s+/) ?? [];
  const version = parts.length >= 2 && parts[0].toLowerCase() === 'codex-cli' ? parts[1] : parts[0] ?? null;
  const name = platform === 'darwin' ? 'Mac OS' : platform === 'linux' ? 'Linux' : 'Darwin';
  const archName = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'x86_64' : 'unknown';
  return `${CLI_ORIGINATOR}${version ? `/${version}` : ''} (${name} ${osVersion}; ${archName})`;
}

/** CodexPATUsageFetcher.fetchUsage: whoami first, then usage scoped to the whoami account. */
async function fetchPATUsage({ token, cliVersion, url, transport }) {
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': codexCLIUserAgent(cliVersion), Accept: 'application/json', originator: CLI_ORIGINATOR };
  const whoamiText = await perform(transport, { url: WHOAMI_URL, method: 'GET', headers, timeoutMs: HTTP_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
  const w = parseJSONOr(whoamiText, 'oauth:invalid-response');
  if (!isObject(w) || ['chatgpt_account_id', 'chatgpt_plan_type', 'email'].some(k => hasValue(w, k) && typeof w[k] !== 'string')) fail('oauth:invalid-response');
  const whoami = { accountId: nonEmpty(w.chatgpt_account_id), email: nonEmpty(w.email), planType: nonEmpty(w.chatgpt_plan_type) };
  const usageHeaders = { ...headers };
  if (whoami.accountId) usageHeaders['ChatGPT-Account-Id'] = whoami.accountId;
  const text = await perform(transport, { url, method: 'GET', headers: usageHeaders, timeoutMs: HTTP_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
  return { usage: decodeCodexUsageResponse(parseJSONOr(text, 'oauth:invalid-response')), whoami };
}

/** CodexTokenRefresher.refresh — ported exactly; CodexBar's usage path never calls it (refresh is delegated). */
export async function refreshCodexToken(credentials, { transport = defaultCodexTransport, now = Date.now } = {}) {
  if (!credentials.refreshToken) return credentials;
  const body = JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: credentials.refreshToken, scope: 'openid profile email' });
  let res;
  try {
    res = await transport({ url: CODEX_REFRESH_ENDPOINT, method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      timeoutMs: HTTP_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
  } catch {
    fail('refresh:network-error');
  }
  const text = bodyText(res.body);
  if (res.status !== 200) fail(refreshFailureReason(res.status, text));
  let json;
  try { json = JSON.parse(text); } catch { /* below */ }
  if (!isObject(json)) fail('refresh:invalid-response');
  return {
    accessToken: typeof json.access_token === 'string' ? json.access_token : credentials.accessToken,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : credentials.refreshToken,
    idToken: typeof json.id_token === 'string' ? json.id_token : credentials.idToken,
    accountId: credentials.accountId,
    lastRefresh: now(),
    expiresAt: null,
    source: credentials.source,
    isAPIKey: credentials.isAPIKey,
  };
}
function refreshFailureReason(status, text) {
  let code = null;
  try {
    const json = JSON.parse(text);
    if (isObject(json)) {
      if (isObject(json.error) && typeof json.error.code === 'string') code = json.error.code;
      else if (typeof json.error === 'string') code = json.error;
      else if (typeof json.code === 'string') code = json.code;
    }
  } catch { /* no code */ }
  switch (code?.toLowerCase()) {
    case 'refresh_token_expired': return 'refresh:expired';
    case 'refresh_token_reused': return 'refresh:reused';
    case 'invalid_grant': case 'refresh_token_invalidated': return 'refresh:revoked';
    default: return status === 401 ? 'refresh:expired' : 'refresh:invalid-response';
  }
}

// ---------------------------------------------------------------- strategies (CodexProviderDescriptor.swift)

/** resolveStrategies L151-173. */
export function resolveCodexStrategies({ sourceMode = 'auto', workspaceId = null } = {}) {
  switch (sourceMode) {
    case 'oauth': return ['codex.oauth', 'codex.oauth-native-refresh-cli'];
    case 'web': return ['codex.web'];
    case 'cli': return ['codex.cli'];
    case 'api': return ['codex.pat'];
    case 'auto': return workspaceId ? ['codex.pat', 'codex.oauth'] : ['codex.pat', 'codex.oauth', 'codex.cli'];
    default: return fail(`config:unknown-source-mode`);
  }
}

/** CodexOAuthFetchStrategy.shouldFallback L490-527. */
export function oauthShouldFallback(error, { sourceMode }) {
  const reason = reasonOf(error);
  const explicitNativeRefresh = reason === 'credentials:native-refresh-required';
  if (!(sourceMode === 'auto' || (sourceMode === 'oauth' && explicitNativeRefresh))) return false;
  if (reason.startsWith('oauth:')) return reason === 'oauth:unauthorized';
  if (reason.startsWith('credentials:')) {
    return ['credentials:not-found', 'credentials:unreadable', 'credentials:missing-tokens', 'credentials:native-refresh-required'].includes(reason);
  }
  return ['refresh:expired', 'refresh:revoked', 'refresh:reused'].includes(reason);
}
/** CodexPATFetchStrategy.shouldFallback L24-43. */
function patShouldFallback(error, { sourceMode }) {
  if (sourceMode !== 'auto') return false;
  const reason = reasonOf(error);
  if (reason.startsWith('oauth:')) return reason === 'oauth:unauthorized';
  return ['credentials:not-found', 'credentials:unreadable', 'credentials:missing-tokens'].includes(reason);
}

/** BinaryLocator stand-in: `codex` on PATH. Refused in a test process. */
export function defaultResolveCodexBinary(env = process.env) {
  if (isTestProcess()) return null;
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'codex');
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}
const defaultReadCodexUsage = isTestProcess()
  ? async () => ({ status: 'unavailable', reason: 'codex app-server refused in a test process', windows: [] })
  : readCodexAppServerUsage;

function redactor(secrets) {
  return text => {
    let out = String(text);
    for (const v of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
    return out;
  };
}

/**
 * Read Codex usage through CodexBar's strategy chain (ProviderFetchPipeline.fetch L396-463): an unavailable strategy is
 * skipped, the first success wins, a failure falls through only when that strategy's shouldFallback says so; the
 * surfaced error is the last available one. Returns `{ reading, identity, attempts }`; identity is never in `reading`.
 *
 * Options (all injectable; tests inject every one): sourceMode 'auto'|'oauth'|'cli'|'api'|'web', workspaceId (managed
 * workspace account id), env, homeDir, readFile, transport, readCodexUsage (the app-server reader from usage.mjs — the
 * `cli` strategy), resolveCodexBinary, cliVersion, allowExternalSources, sleep, now, log, timeoutMs.
 */
export async function readCodexNativeUsage(options = {}) {
  const {
    sourceMode = 'auto', workspaceId = null, env = process.env, homeDir = realHome, readFile = defaultReadFile,
    transport = defaultCodexTransport, readCodexUsage = defaultReadCodexUsage, resolveCodexBinary = defaultResolveCodexBinary,
    cliVersion = null, allowExternalSources = false, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
    log = () => {}, timeoutMs, redactionSet,
  } = options;
  const secrets = redactionSet ?? new Set(); // shared with the raw store (index.mjs) when injected
  const redact = redactor(secrets);
  const track = c => { for (const v of [c?.accessToken, c?.refreshToken, c?.idToken, c?.token]) if (v) secrets.add(v); return c; };
  const loadForUsage = () => track(loadCodexCredentials({ env, homeDir, readFile, allowExternalSources }));
  const usageURL = e => resolveCodexUsageURL({ env: e, homeDir, readFile });

  /** loadCredentials L392-415: reread (never redeem) while the owner may be publishing a replacement. */
  async function loadCredentials(retryStale) {
    let retries = 2;
    for (;;) {
      try {
        const c = loadForUsage();
        if (!retryStale || c.source !== 'codexHome' || !credentialsNeedRefresh(c, now()) || retries === 0) return c;
      } catch (error) {
        if (retries <= 0) throw error;
      }
      retries -= 1;
      await sleep(STALE_REREAD_MS);
    }
  }

  async function cliFetch(strategy) {
    let r;
    try { r = await readCodexUsage(timeoutMs ? { timeoutMs } : undefined); } catch { fail('cli:failed'); }
    if (r?.status !== 'ok') fail('cli:unavailable');
    if (!Array.isArray(r.windows) || !r.windows.length) fail('usage:no-rate-limits');
    const reading = { status: 'ok', source: CODEX_NATIVE_SOURCE, strategy, updatedAt: isoOrNull(now()), windows: r.windows };
    if (r.ordinaryUsageAllowed !== undefined) reading.ordinaryUsageAllowed = r.ordinaryUsageAllowed;
    return { reading, identity: null };
  }

  const strategies = {
    'codex.pat': {
      async isAvailable() {
        try { track(loadPAT(patCredentialEnvironment(env, { homeDir, readFile }), homeDir, readFile)); return true; } catch { return false; }
      },
      async fetch() {
        const credentialEnv = patCredentialEnvironment(env, { homeDir, readFile });
        const pat = track(loadPAT(credentialEnv, homeDir, readFile));
        const { usage, whoami } = await fetchPATUsage({ token: pat.token, cliVersion, url: usageURL(credentialEnv), transport });
        return mapCodexUsage(usage, { whoami, nowMs: now(), strategy: 'codex.pat' });
      },
      shouldFallback: patShouldFallback,
    },
    'codex.oauth': {
      async isAvailable() {
        try { await loadCredentials(false); return true; } catch { return false; }
      },
      async fetch() {
        let c = await loadCredentials(true);
        // prepareCredentialsForUsage L466-476: the owner holds the refresh token; never redeem it from here.
        if (credentialsNeedRefresh(c, now())) fail(c.source === 'codexHome' ? 'credentials:native-refresh-required' : 'credentials:read-only-source');
        if (workspaceId) c = { ...c, accountId: workspaceId };
        const usage = await fetchCodexOAuthUsage({ accessToken: c.accessToken, accountId: c.accountId, url: usageURL(env), transport });
        return mapCodexUsage(usage, { credentials: c, nowMs: now(), strategy: 'codex.oauth' });
      },
      shouldFallback: oauthShouldFallback,
    },
    'codex.cli': {
      async isAvailable() { return resolveCodexBinary(env) !== null; },
      fetch: () => cliFetch('codex.cli'),
      shouldFallback: () => false,
    },
    'codex.oauth-native-refresh-cli': {
      async isAvailable() {
        if (workspaceId || sourceMode !== 'oauth' || resolveCodexBinary(env) === null) return false;
        let c;
        try { c = loadForUsage(); } catch { return false; }
        return c.source === 'codexHome' && credentialsNeedRefresh(c, now());
      },
      fetch: () => cliFetch('codex.oauth-native-refresh-cli'),
      shouldFallback: () => false,
    },
    // CodexWebDashboardStrategy needs the browser-cookie stack (B2+), not wired in this slice.
    'codex.web': {
      async isAvailable() { return true; },
      async fetch() { fail('web:not-ported'); },
      shouldFallback: () => false,
    },
  };

  const attempts = [];
  let lastError = null;
  const failed = error => {
    const reason = redact(reasonOf(error));
    log({ category: 'codex-native', message: redact(`codex usage failed (${sourceMode}): ${attempts.map(a => `${a.strategy}=${a.available ? a.reason ?? 'ok' : 'unavailable'}`).join(', ')}`) });
    return { reading: { status: 'unavailable', source: CODEX_NATIVE_SOURCE, reason, windows: [] }, identity: null, attempts };
  };
  let ids;
  try { ids = resolveCodexStrategies({ sourceMode, workspaceId }); } catch (error) { return failed(error); }
  for (const id of ids) {
    const strategy = strategies[id];
    if (!(await strategy.isAvailable())) {
      attempts.push({ strategy: id, available: false, reason: null });
      continue;
    }
    try {
      const result = await strategy.fetch();
      attempts.push({ strategy: id, available: true, reason: null });
      return { ...result, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ strategy: id, available: true, reason: redact(reasonOf(error)) });
      if (strategy.shouldFallback(error, { sourceMode })) continue;
      return failed(error);
    }
  }
  return failed(lastError ?? new CodexNativeError('no-available-strategy'));
}
