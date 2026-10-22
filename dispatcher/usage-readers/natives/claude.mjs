/**
 * N2 — Claude native usage reader, part 1: OAuth usage, read-only credentials, Admin API, source planner.
 *
 * Ported from CodexBar @ 6480977 (MIT, © 2026 Peter Steinberger; LICENSE-CodexBar beside the plugins):
 *   Sources/CodexBarCore/Providers/Claude/ClaudeProviderDescriptor.swift (resolveStrategies L287-345, planning input
 *     L371-414, planned availability L505-543, Admin strategy L545-588, OAuth strategy L590-792),
 *   ClaudeSourcePlanner.swift (whole file), ClaudeCredentialRouting.swift, ClaudeConfigPaths.swift (credentialsURL L87-101),
 *   ClaudeOAuth/ClaudeOAuthCredentialModels.swift (parse L97-123, isExpired L37-40),
 *   ClaudeOAuth/ClaudeOAuthCredentials.swift (service L15, env token L20-21/L2474-2501, load order L336-490, file
 *     L1706-1721, direct-read consent L2907-2929 — Claude Code owns and rewrites that item, L2922: it is NEVER written),
 *   ClaudeOAuth/ClaudeOAuthCredentials+SecurityCLIReader.swift (argv L258-266 via B1's credential store),
 *   ClaudeOAuth/ClaudeOAuthUsageFetcher.swift (request L69-138, decoding L281-429),
 *   ClaudeUsageFetcher.swift (OAuth executor L436-468, mapOAuthUsage L955-1083), ClaudeScopedWeeklyLimitMapper.swift,
 *   ClaudePlan.swift, ClaudeAdminAPISettingsReader.swift, ClaudeAdminAPIUsageFetcher.swift, ClaudeAdminAPIUsageSnapshot.swift,
 *   Providers/ProviderFetchPlan.swift (pipeline L396-463).
 *
 * Not in this slice: the delegated refresh (N3 — an expired token is `native:claude:needs-refresh`), the web and cli
 * strategies (N4 — planned, but `unavailable: not-yet-ported`), CodexBar's own keychain cache and memory cache, the
 * OAuth rate-limit gate, prompt-mode policy and cooldowns.
 *
 * Tokens are secrets: never logged, never in an error, a reason or a reading. Identity (email / organization / plan) is
 * returned beside the reading, never inside it. Nothing here writes a file or a keychain item. In a test process the
 * defaults fail closed: no network, no claude binary, nothing under the real home directory, no real keychain.
 */
import { readFileSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { createCredentialStore, USAGE_READERS_KEYCHAIN_SERVICE } from '../credentials.mjs';
import { redirectAllowed, MAX_RESPONSE_BYTES, readProviderSection } from '../plugin-host.mjs';

export const CLAUDE_NATIVE_SOURCE = 'native:claude';
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const CLAUDE_OAUTH_TOKEN_ENV = 'CODEXBAR_CLAUDE_OAUTH_TOKEN';
export const CLAUDE_OAUTH_SCOPES_ENV = 'CODEXBAR_CLAUDE_OAUTH_SCOPES';
export const ADMIN_KEY_ENV_KEYS = ['ANTHROPIC_ADMIN_KEY', 'ANTHROPIC_ADMIN_API_KEY'];
export const ADMIN_WORKSPACE_SPEND_ENV = 'ANTHROPIC_ADMIN_WORKSPACE_SPEND';
// limitIds compatible with today's claude rows (dispatcher/usage.mjs ROUTE_LIMIT_IDS.claude, provider-plans).
export const CLAUDE_FIVE_HOUR_LIMIT_ID = '5-hour limit';
export const CLAUDE_WEEKLY_LIMIT_ID = 'Weekly · all models';

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_BETA = 'oauth-2025-04-20';
const FALLBACK_CLAUDE_CODE_VERSION = '2.1.0';
const OAUTH_TIMEOUT_MS = 30_000;
const PROFILE_TIMEOUT_MS = 15_000;
const ADMIN_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const ADMIN_MESSAGES_URL = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const ADMIN_VERSION = '2023-06-01';
const ADMIN_TIMEOUT_MS = 20_000;
const ADMIN_MAX_DAILY_BUCKETS = 31;
const WEEK_MINS = 7 * 24 * 60;
const DAY_MS = 86_400_000;

/** Every failure carries only a typed code (reason `native:claude:<code>`), never a token, a body or a path. */
export class ClaudeNativeError extends Error {
  constructor(code) {
    super(`claude native: ${code}`);
    this.name = 'ClaudeNativeError';
    this.code = code;
    this.reason = `${CLAUDE_NATIVE_SOURCE}:${code}`;
  }
}
const fail = code => { throw new ClaudeNativeError(code); };
const codeOf = error => (error instanceof ClaudeNativeError ? error.code : 'unexpected');

// ---------------------------------------------------------------- test-process guard

const isTestProcess = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
const realHome = homedir();
function permits(path) {
  if (!isTestProcess()) return true;
  const p = resolve(path);
  return p !== realHome && !p.startsWith(realHome + sep);
}

// ---------------------------------------------------------------- small helpers

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = v => v === undefined || v === null;
const cleaned = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isoOrNull = ms => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i;
/** ISO8601DateParser: internet date-time, with or without fractional seconds (any precision; ms kept). */
export function parseISODate(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const m = ISO_RE.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', zone] = m;
  const ms = Number((frac + '000').slice(0, 3));
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  if (zone.toUpperCase() !== 'Z') {
    const z = zone.replace(':', '');
    const offset = (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))) * (z[0] === '-' ? -1 : 1);
    t -= offset * 60_000;
  }
  return Number.isFinite(t) ? t : null;
}
const rfc3339 = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function redactor(secrets) {
  return text => {
    let out = String(text);
    for (const v of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
    return out;
  };
}

// ---------------------------------------------------------------- planner (ClaudeSourcePlanner.swift)

function planStep(dataSource, inclusionReason, input) {
  const isPlausiblyAvailable = dataSource === 'oauth' ? input.hasOAuthCredentials
    : dataSource === 'web' ? input.hasWebSession
      : dataSource === 'cli' ? input.hasCLI : false;
  return { dataSource, inclusionReason, isPlausiblyAvailable: Boolean(isPlausiblyAvailable) };
}
function planSteps(input) {
  switch (input.selectedDataSource) {
    case 'auto':
      return input.runtime === 'cli'
        ? [planStep('web', 'cli-auto-preferred-web', input), planStep('cli', 'cli-auto-fallback-cli', input)]
        : [planStep('oauth', 'app-auto-preferred-oauth', input), planStep('cli', 'app-auto-fallback-cli', input),
          planStep('web', 'app-auto-fallback-web', input)];
    case 'api': return [planStep('api', 'explicit-source-selection', input)];
    case 'oauth':
      return input.runtime === 'cli'
        ? [planStep('oauth', 'explicit-source-selection', input)]
        : [planStep('oauth', 'explicit-source-selection', input), planStep('cli', 'explicit-oauth-owner-cli-fallback', input)];
    case 'web': return [planStep('web', 'explicit-source-selection', input)];
    case 'cli': return [planStep('cli', 'explicit-source-selection', input)];
    default: return fail('config-unknown-source-mode');
  }
}

/** ClaudeSourcePlanner.resolve + ClaudeFetchPlan's derived views. */
export function resolveClaudeSourcePlan(input) {
  const orderedSteps = planSteps(input);
  const availableSteps = orderedSteps.filter(s => s.isPlausiblyAvailable);
  const preferredStep = (input.selectedDataSource === 'auto' || (input.selectedDataSource === 'oauth' && input.runtime === 'app')
    ? availableSteps[0] : orderedSteps[0]) ?? null;
  const executionSteps = input.selectedDataSource === 'auto' ? availableSteps : orderedSteps;
  const compatibilityStrategy = preferredStep
    ? { dataSource: preferredStep.dataSource,
      useWebExtras: input.runtime === 'app' && preferredStep.dataSource === 'cli' && Boolean(input.webExtrasEnabled) }
    : null;
  const orderLabel = orderedSteps.map(s => s.dataSource).join('→');
  return {
    input, orderedSteps, availableSteps, isNoSourceAvailable: availableSteps.length === 0, preferredStep, executionSteps,
    compatibilityStrategy, orderLabel,
    debugLines() {
      return [`planner_order=${orderLabel}`, `planner_selected=${preferredStep?.dataSource ?? 'none'}`,
        `planner_no_source=${availableSteps.length === 0}`,
        ...orderedSteps.map(s => `planner_step.${s.dataSource}=${s.isPlausiblyAvailable ? 'available' : 'unavailable'} reason=${s.inclusionReason}`)];
    },
  };
}

/**
 * ClaudeCLIResolver.resolvedBinaryPath: an executable CLAUDE_CLI_PATH wins, else `claude` on PATH (then login PATH and
 * any well-known paths passed in). BinaryLocator's `command -v` / alias probing is not ported (N4 owns the CLI path).
 */
export function claudeCLIResolvedBinaryPath(env = process.env, { loginPATH = null, wellKnownPaths = [], isExecutable = defaultIsExecutable } = {}) {
  const override = typeof env.CLAUDE_CLI_PATH === 'string' ? env.CLAUDE_CLI_PATH.trim() : '';
  if (override && isExecutable(override)) return override;
  const dirs = [...String(env.PATH ?? '').split(delimiter), ...(loginPATH ?? [])].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return wellKnownPaths.find(p => isExecutable(p)) ?? null;
}
function defaultIsExecutable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
/** The reader's default: refused in a test process. */
export function defaultResolveClaudeBinary(env = process.env) {
  return isTestProcess() ? null : claudeCLIResolvedBinaryPath(env);
}

// ---------------------------------------------------------------- credential routing (ClaudeCredentialRouting.swift)

const normalizeCookie = raw => {
  const t = cleaned(raw);
  if (!t) return null;
  const stripped = t.replace(/^cookie:\s*/i, '').trim();
  return stripped || null;
};
function bearerStripped(raw, prefix) {
  const trimmed = cleaned(raw);
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.includes('cookie:') || trimmed.includes('=')) return null;
  if (lower.startsWith('bearer ')) {
    const inner = trimmed.slice('bearer '.length).trim();
    return inner && inner.toLowerCase().startsWith(prefix) ? inner : null;
  }
  return lower.startsWith(prefix) ? trimmed : null;
}
/** resolve(tokenAccountToken:manualCookieHeader:) for a token account: admin key, then OAuth token, then a web cookie. */
export function resolveClaudeCredentialRouting(token, manualCookieHeader = null) {
  const admin = bearerStripped(token, 'sk-ant-admin');
  if (admin) return { kind: 'adminAPIKey', value: admin };
  const oauth = bearerStripped(token, 'sk-ant-oat');
  if (oauth) return { kind: 'oauth', value: oauth };
  for (const raw of [token, manualCookieHeader]) {
    const cookie = normalizeCookie(raw);
    if (cookie) return { kind: 'webCookie', value: cookie.includes('=') ? cookie : `sessionKey=${cookie}` };
  }
  return { kind: 'none', value: null };
}

/**
 * A selected token account (environmentScrubber + environmentOverride + selectedAccountSourceModeResolver): ambient
 * OAuth / admin env credentials are removed, the account's own credential is projected, the source follows the route.
 */
function applySelectedAccount(env, baseSourceMode, account) {
  const scrubbed = { ...env };
  delete scrubbed[CLAUDE_OAUTH_TOKEN_ENV];
  for (const key of ADMIN_KEY_ENV_KEYS) delete scrubbed[key];
  const route = resolveClaudeCredentialRouting(account?.token ?? null);
  switch (route.kind) {
    case 'adminAPIKey': return { env: { ...scrubbed, [ADMIN_KEY_ENV_KEYS[0]]: route.value }, sourceMode: 'api', cookieSource: 'off', manualCookieHeader: null };
    case 'oauth': return { env: { ...scrubbed, [CLAUDE_OAUTH_TOKEN_ENV]: route.value }, sourceMode: 'oauth', cookieSource: 'off', manualCookieHeader: null };
    case 'webCookie': return { env: scrubbed, sourceMode: 'web', cookieSource: 'manual', manualCookieHeader: route.value };
    default: return { env: scrubbed, sourceMode: baseSourceMode, cookieSource: 'manual', manualCookieHeader: null };
  }
}

const envAdminKey = env => ADMIN_KEY_ENV_KEYS.map(k => cleaned(env?.[k])).find(Boolean) ?? null;
const envOAuthToken = env => cleaned(env?.[CLAUDE_OAUTH_TOKEN_ENV]);
const hasSessionKey = header => typeof header === 'string' && /(?:^|;\s*)sessionKey=[^;\s]+/.test(header);

/** hasPlausibleWebSession L388-414. */
function hasPlausibleWebSession(ctx) {
  switch (ctx.sourceMode) {
    case 'api': case 'oauth': case 'cli': return false;
    case 'web': return ctx.cookieSource !== 'off';
    default: break;
  }
  if (!(ctx.platform === 'darwin' || ctx.cookieSource === 'manual')) return false;
  if (ctx.cookieSource === 'off') return false;
  if (ctx.cookieSource === 'manual') return hasSessionKey(ctx.manualCookieHeader);
  return true;
}

/**
 * resolveStrategies L287-345 → `[{ id, plannedStep }]`. A selected account is an authority boundary: only its own
 * credential's strategy, or nothing — never the ambient CLI, browser session or a global admin key.
 * `ctx`: runtime, sourceMode, env, adminKey (ambient, already resolved), hasCLI, selectedAccount, cookieSource,
 * manualCookieHeader, webExtrasEnabled, platform.
 */
export function resolveClaudeStrategies(ctx) {
  const c = { cookieSource: 'auto', manualCookieHeader: null, webExtrasEnabled: false, platform: process.platform, ...ctx };
  if (c.selectedAccount) {
    const sel = { ...c, ...applySelectedAccount(c.env ?? {}, c.sourceMode, c.selectedAccount) };
    if (envAdminKey(sel.env)) return [{ id: 'claude.admin-api', plannedStep: null }];
    if (sel.sourceMode === 'oauth' && envOAuthToken(sel.env)) return [{ id: 'claude.oauth', plannedStep: null }];
    if (sel.sourceMode === 'web' && sel.cookieSource === 'manual' && normalizeCookie(sel.manualCookieHeader)) {
      return [{ id: 'claude.web', plannedStep: null }];
    }
    return [];
  }
  if (c.sourceMode === 'api' || (c.sourceMode === 'auto' && c.adminKey)) return [{ id: 'claude.admin-api', plannedStep: null }];
  const plan = resolveClaudeSourcePlan(planningInput(c));
  return plan.orderedSteps.map(step => ({ id: `claude.${step.dataSource === 'api' ? 'admin-api' : step.dataSource}`, plannedStep: step }));
}
function planningInput(c) {
  return {
    runtime: c.runtime, selectedDataSource: c.sourceMode, webExtrasEnabled: Boolean(c.webExtrasEnabled),
    hasWebSession: hasPlausibleWebSession(c), hasCLI: Boolean(c.hasCLI),
    // App Auto and explicit OAuth make one real, noninteractive OAuth attempt (L374-385).
    hasOAuthCredentials: c.runtime === 'app' && (c.sourceMode === 'auto' || c.sourceMode === 'oauth'),
  };
}

// ---------------------------------------------------------------- credentials (read only)

const nonemptyLiteral = raw => (typeof raw === 'string' && raw ? raw : null);
/** directoryURL: only a leading slash is absolute; a relative root resolves against the working directory, `~` literal. */
const directoryPath = (path, workingDirectory) => (path.startsWith('/') ? resolve(path) : resolve(workingDirectory, path));

/** ClaudeConfigPaths.homeDirectory: a non-empty HOME, else the process home. */
export function claudeHomeDirectory({ env = process.env, homeDir = realHome, workingDirectory = process.cwd() } = {}) {
  const raw = nonemptyLiteral(env.HOME);
  return raw ? directoryPath(raw, workingDirectory) : resolve(homeDir);
}
/** ClaudeConfigPaths.credentialsURL: CLAUDE_SECURESTORAGE_CONFIG_DIR (empty ⇒ default root) > CLAUDE_CONFIG_DIR > HOME/.claude. */
export function claudeCredentialsPath({ env = process.env, homeDir = realHome, workingDirectory = process.cwd() } = {}) {
  const defaultRoot = () => join(claudeHomeDirectory({ env, homeDir, workingDirectory }), '.claude');
  let root;
  if (typeof env.CLAUDE_SECURESTORAGE_CONFIG_DIR === 'string') {
    root = env.CLAUDE_SECURESTORAGE_CONFIG_DIR === '' ? defaultRoot() : directoryPath(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, workingDirectory);
  } else {
    const configured = nonemptyLiteral(env.CLAUDE_CONFIG_DIR);
    root = configured ? directoryPath(configured, workingDirectory) : defaultRoot();
  }
  return join(root, '.credentials.json');
}

const optionalOf = (obj, key, type) => {
  const v = obj[key];
  if (absent(v)) return null;
  if (type === 'string' ? typeof v !== 'string' : type === 'number' ? typeof v !== 'number' || !Number.isFinite(v)
    : !Array.isArray(v) || v.some(s => typeof s !== 'string')) fail('credentials-decode-failed');
  return v;
};
/** ClaudeOAuthCredentials.parse: MCP-only payloads, decode failures, a missing block or access token are typed errors. */
export function parseClaudeCredentials(text) {
  let root;
  try { root = JSON.parse(String(text)); } catch { fail('credentials-decode-failed'); }
  if (isObject(root) && !Object.hasOwn(root, 'claudeAiOauth') && Object.hasOwn(root, 'mcpOAuth')) fail('credentials-mcp-only');
  if (!isObject(root)) fail('credentials-decode-failed');
  const oauth = root.claudeAiOauth;
  if (absent(oauth)) fail('credentials-missing-oauth');
  if (!isObject(oauth)) fail('credentials-decode-failed');
  const accessToken = optionalOf(oauth, 'accessToken', 'string');
  const refreshToken = optionalOf(oauth, 'refreshToken', 'string');
  const expiresAt = optionalOf(oauth, 'expiresAt', 'number');
  const scopes = optionalOf(oauth, 'scopes', 'strings');
  const rateLimitTier = optionalOf(oauth, 'rateLimitTier', 'string');
  const subscriptionType = optionalOf(oauth, 'subscriptionType', 'string');
  const access = accessToken?.trim() ?? '';
  if (!access) fail('credentials-missing-access-token');
  return { accessToken: access, refreshToken, expiresAtMs: expiresAt, scopes: scopes ?? [], rateLimitTier, subscriptionType };
}
/** isExpired: no expiry counts as expired. */
export const claudeCredentialsExpired = (c, nowMs) => c.expiresAtMs === null || c.expiresAtMs === undefined || nowMs >= c.expiresAtMs;

function environmentCredentials(env) {
  const token = envOAuthToken(env);
  if (!token) return null;
  const raw = env[CLAUDE_OAUTH_SCOPES_ENV];
  const parsed = typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  return { accessToken: token, refreshToken: null, expiresAtMs: Infinity, scopes: parsed.length ? parsed : ['user:profile'],
    rateLimitTier: null, subscriptionType: null };
}

const defaultReadFile = path => readFileSync(path, 'utf8');

/**
 * ClaudeOAuthCredentialsStore.loadRecord, read-only subset (L336-490): environment token → credentials file (a fresh one
 * wins) → Claude Code's keychain item (only with the user's explicit direct-read consent, L2922-2928; noninteractive
 * `security` read through B1) → the expired record if one was found → typed error. CodexBar's own keychain cache and its
 * memory cache are not ported. Nothing is ever written back.
 */
export function loadClaudeCredentialRecord({
  env = process.env, homeDir = realHome, workingDirectory = process.cwd(), readFile = defaultReadFile, credentials = null,
  keychainReadConsent = false, now = Date.now, log = () => {},
} = {}) {
  const fromEnv = environmentCredentials(env);
  if (fromEnv) return { credentials: fromEnv, owner: 'environment', source: 'environment' };
  const nowMs = now();
  let lastError = null;
  let expired = null;

  const path = claudeCredentialsPath({ env, homeDir, workingDirectory });
  if (permits(path)) {
    let text = null;
    try { text = readFile(path); } catch (error) { if (error?.code !== 'ENOENT') lastError = new ClaudeNativeError('credentials-read-failed'); }
    if (text !== null) {
      try {
        const record = { credentials: parseClaudeCredentials(text), owner: 'claudeCLI', source: 'credentialsFile' };
        if (!claudeCredentialsExpired(record.credentials, nowMs)) return record;
        expired = record;
      } catch (error) { lastError = error; }
    }
  }

  let keychainDenied = false;
  if (keychainReadConsent) {
    const store = credentials ?? createCredentialStore();
    const got = store.read({ service: CLAUDE_KEYCHAIN_SERVICE, account: null, anyAccount: true });
    if (got?.ok && typeof got.value === 'string') {
      // The security CLI path falls back silently on an unparsable / MCP-only payload (SecurityCLIReader L59-71).
      try { return { credentials: parseClaudeCredentials(got.value), owner: 'claudeCLI', source: 'claudeKeychain' }; } catch (error) {
        log({ category: 'claude-native', message: `claude keychain payload unusable: ${codeOf(error)}` });
      }
    } else {
      keychainDenied = got?.reason === 'denied';
      log({ category: 'claude-native', message: `claude keychain read: ${got?.reason ?? 'unavailable'}` });
    }
  }

  if (expired) return expired;
  if (lastError) throw lastError;
  // classifyTerminalMissingCredentialsError L1930-1944: a consented, denied keychain read is a revocation.
  return fail(keychainReadConsent && keychainDenied ? 'credentials-keychain-access-revoked' : 'credentials-not-found');
}

// ---------------------------------------------------------------- plan (ClaudePlan.swift)

const normalizedWords = text => (typeof text === 'string' ? text.trim().toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean) : []);
const BRANDED = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise', ultra: 'Claude Ultra' };
function planFromLoginMethod(text) {
  const words = normalizedWords(text);
  return ['max', 'pro', 'team', 'enterprise', 'ultra'].find(p => words.includes(p)) ?? null;
}
function planFromTier(tier) {
  const t = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  return ['max', 'pro', 'team', 'enterprise'].find(p => t.includes(p)) ?? null;
}
function maxMultiplier(tier) {
  const words = normalizedWords(tier);
  const i = words.indexOf('max');
  const m = i >= 0 ? words[i + 1] : undefined;
  return m && m.endsWith('x') && /^\d+$/.test(m.slice(0, -1)) ? m : null;
}
/** ClaudePlan.oauthLoginMethod(subscriptionType:rateLimitTier:). */
export function claudeOAuthLoginMethod(subscriptionType, rateLimitTier) {
  const plan = planFromLoginMethod(subscriptionType) ?? planFromTier(rateLimitTier);
  if (!plan) return null;
  const multiplier = plan === 'max' ? maxMultiplier(rateLimitTier) : null;
  return multiplier ? `${BRANDED.max} ${multiplier}` : BRANDED[plan];
}

// ---------------------------------------------------------------- OAuth usage response (OAuthUsageResponse)

/** decodeIfPresent(T) with `try?`: null when absent, null, or the wrong shape. */
function decodeWindow(v) {
  if (!isObject(v)) return null;
  const u = v.utilization;
  const r = v.resets_at;
  if (!absent(u) && (typeof u !== 'number' || !Number.isFinite(u))) return null;
  if (!absent(r) && typeof r !== 'string') return null;
  return { utilization: absent(u) ? null : u, resetsAt: absent(r) ? null : r };
}
const firstDecoded = (json, keys, decode) => {
  for (const key of keys) {
    if (!Object.hasOwn(json, key)) continue;
    const value = decode(json[key]);
    if (value) return { value, key };
  }
  return { value: null, key: null };
};
const optional = (v, type) => (absent(v) ? { ok: true, value: null }
  : (type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type) ? { ok: true, value: v } : { ok: false });
function decodeLimitEntry(v) {
  if (!isObject(v)) return null;
  const fields = { kind: optional(v.kind, 'string'), group: optional(v.group, 'string'), percent: optional(v.percent, 'number'),
    resetsAt: optional(v.resets_at, 'string'), isActive: optional(v.is_active, 'boolean') };
  if (Object.values(fields).some(f => !f.ok)) return null;
  let model = null;
  if (!absent(v.scope)) {
    if (!isObject(v.scope)) return null;
    if (!absent(v.scope.model)) {
      if (!isObject(v.scope.model)) return null;
      const id = optional(v.scope.model.id, 'string');
      const name = optional(v.scope.model.display_name, 'string');
      if (!id.ok || !name.ok) return null;
      model = { id: id.value, displayName: name.value };
    }
  }
  return { kind: fields.kind.value, group: fields.group.value, percent: fields.percent.value, resetsAt: fields.resetsAt.value,
    isActive: fields.isActive.value, modelID: model?.id ?? null, modelName: model?.displayName ?? null };
}
function decodeLimits(v) {
  if (!Array.isArray(v)) return null;
  const out = v.map(decodeLimitEntry);
  return out.some(e => !e) ? null : out;
}
function decodeExtraUsage(v) {
  if (!isObject(v)) return null;
  const f = { isEnabled: optional(v.is_enabled, 'boolean'), monthlyLimit: optional(v.monthly_limit, 'number'),
    usedCredits: optional(v.used_credits, 'number'), utilization: optional(v.utilization, 'number'), currency: optional(v.currency, 'string') };
  if (Object.values(f).some(x => !x.ok)) return null;
  return Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]));
}

const ROUTINE_KEYS = ['seven_day_routines', 'seven_day_claude_routines', 'claude_routines', 'routines', 'routine', 'seven_day_cowork', 'cowork'];
/** OAuthUsageResponse.init(from:): every part decodes on its own; a bad part is just absent. */
export function decodeClaudeOAuthUsage(json) {
  if (!isObject(json)) fail('oauth-invalid-response');
  const w = key => firstDecoded(json, [key], decodeWindow).value;
  const routines = firstDecoded(json, ROUTINE_KEYS, decodeWindow);
  return {
    fiveHour: w('five_hour'), sevenDay: w('seven_day'), sevenDayOAuthApps: w('seven_day_oauth_apps'),
    sevenDayOpus: w('seven_day_opus'), sevenDaySonnet: w('seven_day_sonnet'),
    sevenDayRoutines: routines.value, sevenDayRoutinesSourceKey: routines.key,
    extraUsage: firstDecoded(json, ['extra_usage'], decodeExtraUsage).value,
    limits: firstDecoded(json, ['limits'], decodeLimits).value,
  };
}

// ---------------------------------------------------------------- mapping (mapOAuthUsage L955-1083)

function slug(value) {
  let out = '';
  let lastDash = false;
  for (const ch of value.toLowerCase()) {
    if (/[\p{L}\p{N}\p{M}]/u.test(ch)) { out += ch; lastDash = false; } else if (!lastDash) { out += '-'; lastDash = true; }
  }
  return out.replace(/^-+|-+$/g, '');
}
const isAllModelsScope = (modelID, modelName) => {
  if (slug(modelName) === 'all-models') return true;
  const id = cleaned(modelID);
  if (!id) return false;
  const s = slug(id);
  return s === 'all-models' || s.endsWith('-all-models');
};
/** ClaudeScopedWeeklyLimitMapper.extraRateWindows. `is_active` is intentionally not a filter. */
export function claudeScopedWeeklyWindows(limits) {
  if (!limits) return [];
  const seen = new Set();
  const out = [];
  for (const l of limits) {
    if (l.group !== 'weekly' || l.kind !== 'weekly_scoped') continue;
    if (typeof l.percent !== 'number' || !Number.isFinite(l.percent)) continue;
    const name = cleaned(l.modelName);
    if (!name || isAllModelsScope(l.modelID, name)) continue;
    const s = slug(cleaned(l.modelID) ?? name);
    if (!s) continue;
    const id = `claude-weekly-scoped-${s}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ limitId: id, usedPercent: l.percent, windowDurationMins: WEEK_MINS, resetsAt: isoOrNull(parseISODate(l.resetsAt)) });
  }
  return out;
}

const makeWindow = (w, minutes) => (w && w.utilization !== null
  ? { usedPercent: w.utilization, windowDurationMins: minutes, resetsAt: isoOrNull(parseISODate(w.resetsAt)) } : null);

/** oauthExtraUsageCost L1022-1042: OAuth extra usage is always cents. */
function extraUsageCost(extra, loginMethod, treatAsSpendLimit) {
  if (!extra || extra.isEnabled !== true || extra.usedCredits === null || extra.monthlyLimit === null) return null;
  const currency = cleaned(extra.currency) ?? 'USD';
  const spend = treatAsSpendLimit || planFromLoginMethod(loginMethod) === 'enterprise';
  return { used: extra.usedCredits / 100, limit: extra.monthlyLimit / 100, currencyCode: currency, period: spend ? 'Spend limit' : 'Monthly cap' };
}

/**
 * mapOAuthUsage → `{ reading, identity }`. CodexBar's lanes become today's claude limitIds: primary (five_hour) →
 * '5-hour limit', secondary (seven_day) → 'Weekly · all models', tertiary (sonnet ?? opus) → 'claude-tertiary', extras keep
 * CodexBar's ids. When five_hour is missing CodexBar's primary falls back to a weekly window; seven_day is then already
 * the weekly row and is not repeated, any other fallback is 'claude-primary'. Plan / identity never enter the reading.
 */
export function mapClaudeOAuthUsage(usage, { credentials = {}, nowMs = Date.now(), strategy = 'claude.oauth' } = {}) {
  const loginMethod = claudeOAuthLoginMethod(credentials.subscriptionType ?? null, credentials.rateLimitTier ?? null);
  const candidates = [['five_hour', usage.fiveHour, 300], ['seven_day', usage.sevenDay, WEEK_MINS],
    ['seven_day_oauth_apps', usage.sevenDayOAuthApps, WEEK_MINS], ['seven_day_sonnet', usage.sevenDaySonnet, WEEK_MINS],
    ['seven_day_opus', usage.sevenDayOpus, WEEK_MINS]];
  let primary = null;
  let primarySource = null;
  for (const [key, w, minutes] of candidates) {
    primary = makeWindow(w, minutes);
    if (primary) { primarySource = key; break; }
  }
  const cost = extraUsageCost(usage.extraUsage, loginMethod, !primary && usage.extraUsage?.isEnabled === true);
  if (!primary && !(cost && cost.limit > 0)) fail('usage-missing-session-data');

  const windows = [];
  if (primary && primarySource === 'five_hour') windows.push({ limitId: CLAUDE_FIVE_HOUR_LIMIT_ID, ...primary });
  else if (primary && primarySource !== 'seven_day') windows.push({ limitId: 'claude-primary', ...primary });
  const weekly = makeWindow(usage.sevenDay, WEEK_MINS);
  if (weekly) windows.push({ limitId: CLAUDE_WEEKLY_LIMIT_ID, ...weekly });
  const tertiary = makeWindow(usage.sevenDaySonnet ?? usage.sevenDayOpus, WEEK_MINS);
  if (tertiary) windows.push({ limitId: 'claude-tertiary', ...tertiary });
  windows.push(...claudeScopedWeeklyWindows(usage.limits));
  const routines = makeWindow(usage.sevenDayRoutines, WEEK_MINS);
  if (routines) windows.push({ limitId: 'claude-routines', ...routines });

  const reading = { status: 'ok', source: CLAUDE_NATIVE_SOURCE, strategy, updatedAt: isoOrNull(nowMs), windows };
  if (cost) reading.cost = cost;
  return { reading, identity: { email: null, organization: null, accountId: null, plan: loginMethod } };
}

// ---------------------------------------------------------------- HTTP

/** Default transport: fetch with the same-origin HTTPS redirect guard and the 5 MiB cap. Refused in a test process. */
export async function defaultClaudeTransport({ url, method, headers, body, maxBytes = MAX_RESPONSE_BYTES, timeoutMs = OAUTH_TIMEOUT_MS }) {
  if (isTestProcess()) throw new Error('network refused in a test process');
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, { method, headers, body, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
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

/** claudeCodeUserAgent: the first token of the detected version, else 2.1.0. */
const claudeCodeUserAgent = version => `claude-code/${cleaned(version)?.split(/\s+/)[0] || FALLBACK_CLAUDE_CODE_VERSION}`;

/**
 * ClaudeOAuthUsageFetcher.fetchUsage L69-138: `?cedar_ember=1` with the `claude-cli/<v> (external, cli)` agent; a 400 or a
 * 403 that does not name user:profile is retried once without the query and with `claude-code/<v>`. Bodies are dropped.
 */
export async function fetchClaudeOAuthUsage({ accessToken, transport = defaultClaudeTransport, claudeVersion = null }) {
  const userAgent = claudeCodeUserAgent(claudeVersion);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json',
    'anthropic-beta': OAUTH_BETA, 'User-Agent': `${userAgent.replace('claude-code/', 'claude-cli/')} (external, cli)` };
  const send = async (url, h) => {
    try { return await transport({ url, method: 'GET', headers: h, timeoutMs: OAUTH_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES }); } catch {
      return fail('oauth-network-error');
    }
  };
  let res = await send(`${OAUTH_USAGE_URL}?cedar_ember=1`, headers);
  if (res.status === 400 || (res.status === 403 && !bodyText(res.body).includes('user:profile'))) {
    res = await send(OAUTH_USAGE_URL, { ...headers, 'User-Agent': userAgent });
  }
  switch (res.status) {
    case 200: {
      let json;
      try { json = JSON.parse(bodyText(res.body)); } catch { fail('oauth-invalid-response'); }
      return decodeClaudeOAuthUsage(json);
    }
    case 401: return fail('oauth-unauthorized');
    case 429: return fail('oauth-rate-limited');
    case 403: if (bodyText(res.body).includes('user:profile')) fail('oauth-scope-rejected'); // falls through
    default: return fail(`oauth-server-error:${res.status}`);
  }
}

/** fetchProfile L149-178 (identity only, opt-in): account / organization ids and the email. */
export async function fetchClaudeOAuthProfile({ accessToken, transport = defaultClaudeTransport }) {
  let res;
  try {
    res = await transport({ url: OAUTH_PROFILE_URL, method: 'GET', timeoutMs: PROFILE_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  } catch { return fail('profile-network-error'); }
  if (res.status !== 200) fail(`profile-server-error:${res.status}`);
  let json;
  try { json = JSON.parse(bodyText(res.body)); } catch { fail('profile-invalid-response'); }
  if (!isObject(json)) fail('profile-invalid-response');
  const pick = (obj, keys) => (isObject(obj) ? keys.map(k => cleaned(obj[k])).find(Boolean) ?? null : null);
  return {
    accountId: pick(json.account, ['uuid']) ?? pick(json, ['accountUuid', 'account_uuid']),
    email: pick(json.account, ['emailAddress', 'email_address', 'email']) ?? pick(json, ['emailAddress', 'email_address', 'email']),
    organization: pick(json.organization, ['uuid']) ?? pick(json, ['organizationUuid', 'organization_uuid']),
  };
}

// ---------------------------------------------------------------- Admin API (ClaudeAdminAPIUsageFetcher.swift)

const displayName = (raw, fallback) => cleaned(raw) ?? fallback;
const usdFromLowestUnit = raw => { const n = Number(raw); return (Number.isFinite(n) && String(raw).trim() !== '' ? n : 0) / 100; };
const isInt = v => typeof v === 'number' && Number.isSafeInteger(v);

function decodeAdmin(json, endpoint, decodeResult) {
  const bad = () => fail(`admin-parse-failed:${endpoint}`);
  if (!isObject(json) || !Array.isArray(json.data)) bad();
  return json.data.map(b => {
    if (!isObject(b) || typeof b.starting_at !== 'string' || typeof b.ending_at !== 'string' || !Array.isArray(b.results)) bad();
    return { startingAt: b.starting_at, endingAt: b.ending_at, results: b.results.map(r => decodeResult(r) ?? bad()) };
  });
}
const decodeCostResult = r => {
  if (!isObject(r) || typeof r.amount !== 'string') return null;
  for (const k of ['currency', 'description', 'cost_type', 'workspace_id']) if (!absent(r[k]) && typeof r[k] !== 'string') return null;
  return { amount: r.amount, description: r.description ?? null, costType: r.cost_type ?? null, workspaceID: r.workspace_id ?? null };
};
const decodeMessagesResult = r => {
  if (!isObject(r)) return null;
  for (const k of ['uncached_input_tokens', 'cache_read_input_tokens', 'output_tokens']) if (!absent(r[k]) && !isInt(r[k])) return null;
  if (!absent(r.model) && typeof r.model !== 'string') return null;
  let cacheCreation = 0;
  if (!absent(r.cache_creation)) {
    if (!isObject(r.cache_creation)) return null;
    for (const k of ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']) {
      if (!absent(r.cache_creation[k]) && !isInt(r.cache_creation[k])) return null;
      cacheCreation += r.cache_creation[k] ?? 0;
    }
  }
  return { input: r.uncached_input_tokens ?? 0, cacheCreation, cacheRead: r.cache_read_input_tokens ?? 0, output: r.output_tokens ?? 0,
    model: r.model ?? null };
};
const byValueThenName = key => (a, b) => (a[key] === b[key] ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : b[key] - a[key]);

/** makeSnapshot L162-235 (parsed JSON in, daily buckets out). */
export function parseClaudeAdminSnapshot(costsJSON, messagesJSON, { nowMs = Date.now(), workspaceSpendEnabled = false } = {}) {
  const costs = decodeAdmin(costsJSON, 'cost_report', decodeCostResult);
  const messages = decodeAdmin(messagesJSON, 'messages', decodeMessagesResult);
  const acc = new Map();
  const bucket = b => {
    if (!acc.has(b.startingAt)) {
      acc.set(b.startingAt, { startingAt: b.startingAt, endingAt: b.endingAt, costUSD: 0, inputTokens: 0, cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0, costItems: new Map(), models: new Map() });
    }
    return acc.get(b.startingAt);
  };
  for (const b of costs) {
    const a = bucket(b);
    for (const r of b.results) {
      const value = usdFromLowestUnit(r.amount);
      a.costUSD += value;
      const item = displayName(r.description ?? r.costType, 'Claude API');
      a.costItems.set(item, (a.costItems.get(item) ?? 0) + value);
    }
  }
  for (const b of messages) {
    const a = bucket(b);
    for (const r of b.results) {
      const total = r.input + r.cacheCreation + r.cacheRead + r.output;
      a.inputTokens += r.input; a.cacheCreationInputTokens += r.cacheCreation; a.cacheReadInputTokens += r.cacheRead;
      a.outputTokens += r.output; a.totalTokens += total;
      const name = displayName(r.model, 'Claude API');
      const m = a.models.get(name) ?? { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 };
      m.inputTokens += r.input; m.cacheCreationInputTokens += r.cacheCreation; m.cacheReadInputTokens += r.cacheRead;
      m.outputTokens += r.output; m.totalTokens += total;
      a.models.set(name, m);
    }
  }
  const daily = [...acc.values()].map(a => {
    const start = parseISODate(a.startingAt);
    const end = parseISODate(a.endingAt);
    if (start === null || end === null) return null;
    return { day: new Date(start).toISOString().slice(0, 10), startTime: start, endTime: end, costUSD: a.costUSD,
      inputTokens: a.inputTokens, cacheCreationInputTokens: a.cacheCreationInputTokens, cacheReadInputTokens: a.cacheReadInputTokens,
      outputTokens: a.outputTokens, totalTokens: a.totalTokens,
      costItems: [...a.costItems].map(([name, costUSD]) => ({ name, costUSD })).sort(byValueThenName('costUSD')),
      models: [...a.models].map(([name, m]) => ({ name, ...m })).sort(byValueThenName('totalTokens')) };
  }).filter(d => d && d.startTime <= nowMs).sort((x, y) => x.startTime - y.startTime);
  let workspaceCosts = null;
  if (workspaceSpendEnabled) {
    const included = new Set(daily.slice(-30).map(d => d.startTime));
    const totals = new Map();
    for (const b of costs) {
      const start = parseISODate(b.startingAt);
      if (start === null || !included.has(start)) continue;
      for (const r of b.results) {
        const name = displayName(r.workspaceID, 'Default');
        totals.set(name, (totals.get(name) ?? 0) + usdFromLowestUnit(r.amount));
      }
    }
    workspaceCosts = [...totals].map(([name, costUSD]) => ({ name, costUSD })).sort(byValueThenName('costUSD'));
  }
  return { daily, updatedAt: nowMs, workspaceCosts };
}

const sumOf = (days, key) => days.reduce((s, d) => s + d[key], 0);
/** ClaudeAdminAPIUsageSnapshot.toUsageSnapshot → a cost-only reading (no rate windows); identity "Admin API". */
export function mapClaudeAdminUsage(snapshot) {
  const last = n => snapshot.daily.slice(-Math.max(1, n));
  const today = snapshot.daily.filter(d => d.startTime <= snapshot.updatedAt && snapshot.updatedAt < d.endTime);
  const total = last(30);
  const models = new Map();
  const items = new Map();
  for (const d of snapshot.daily) {
    for (const m of d.models) models.set(m.name, (models.get(m.name) ?? 0) + m.totalTokens);
    for (const i of d.costItems) items.set(i.name, (items.get(i.name) ?? 0) + i.costUSD);
  }
  const topModels = [...models].map(([name, totalTokens]) => ({ name, totalTokens })).sort(byValueThenName('totalTokens'));
  const details = {
    todayCostUSD: sumOf(today, 'costUSD'), last7DaysCostUSD: sumOf(last(7), 'costUSD'), last30DaysCostUSD: sumOf(total, 'costUSD'),
    todayTokens: sumOf(today, 'totalTokens'), last30DaysTokens: sumOf(total, 'totalTokens'), cacheReadTokens: sumOf(total, 'cacheReadInputTokens'),
  };
  if (topModels.length) details.topModel = topModels[0].name;
  const costItems = [...items].map(([name, costUSD]) => ({ name, costUSD })).sort(byValueThenName('costUSD')).slice(0, 20);
  if (costItems.length) details.costItems = costItems;
  if (snapshot.workspaceCosts && snapshot.workspaceCosts.length > 1) details.workspaceCosts = snapshot.workspaceCosts.slice(0, 20);
  const reading = { status: 'ok', source: CLAUDE_NATIVE_SOURCE, strategy: 'claude.admin-api', updatedAt: isoOrNull(snapshot.updatedAt),
    windows: [], cost: { used: sumOf(total, 'costUSD'), limit: 0, currencyCode: 'USD', period: 'Last 30 days' }, details };
  return { reading, identity: { email: null, organization: null, accountId: null, plan: 'Admin API' } };
}

/** fetchUsage L35-68: cost_report then messages, 31 daily UTC buckets ending tomorrow. */
export async function fetchClaudeAdminUsage({ apiKey, workspaceSpendEnabled = false, transport = defaultClaudeTransport, nowMs = Date.now() }) {
  const key = cleaned(apiKey);
  if (!key) fail('admin-missing-key');
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const range = { start: today - (ADMIN_MAX_DAILY_BUCKETS - 1) * DAY_MS, end: today + DAY_MS };
  const url = (base, groups) => {
    const q = new URLSearchParams([['starting_at', rfc3339(range.start)], ['ending_at', rfc3339(range.end)], ['bucket_width', '1d'],
      ['limit', String(ADMIN_MAX_DAILY_BUCKETS)], ...groups.map(g => ['group_by[]', g])]);
    return `${base}?${q}`;
  };
  const get = async (target, endpoint) => {
    let res;
    try {
      res = await transport({ url: target, method: 'GET', timeoutMs: ADMIN_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
        headers: { 'anthropic-version': ADMIN_VERSION, 'x-api-key': key, Accept: 'application/json', 'User-Agent': 'CodexBar/1.0' } });
    } catch { return fail('admin-network-error'); }
    if (res.status !== 200) fail(`admin-api-error:${endpoint}:${res.status}`);
    try { return JSON.parse(bodyText(res.body)); } catch { return fail(`admin-parse-failed:${endpoint}`); }
  };
  const costs = await get(url(ADMIN_COST_URL, workspaceSpendEnabled ? ['description', 'workspace_id'] : ['description']), 'cost_report');
  const messages = await get(url(ADMIN_MESSAGES_URL, ['model']), 'messages');
  return parseClaudeAdminSnapshot(costs, messages, { nowMs, workspaceSpendEnabled });
}

// ---------------------------------------------------------------- the reader

/**
 * The ambient admin key as a secure setting of provider `claude` (resolvePluginSettings' order, layer by layer across
 * both CodexBar env names): env → keychain (service ocli-usage-readers, account claude.<KEY>) → config file. A config
 * file under the real home is never read in a test process.
 */
function resolveAmbientAdminSettings({ env, credentials, configPath }) {
  const fromEnv = envAdminKey(env);
  const workspace = cleaned(env[ADMIN_WORKSPACE_SPEND_ENV]);
  if (fromEnv) return { apiKey: fromEnv, workspaceSpend: workspace };
  const store = credentials ?? createCredentialStore();
  for (const key of ADMIN_KEY_ENV_KEYS) {
    const got = store.read({ service: USAGE_READERS_KEYCHAIN_SERVICE, account: `claude.${key}` });
    if (got?.ok && cleaned(got.value)) return { apiKey: cleaned(got.value), workspaceSpend: workspace };
  }
  const file = configPath ?? (cleaned(env.OCLI_USAGE_READERS_CONFIG) ?? join(realHome, '.config', 'ocli', 'usage-readers.json'));
  let section = null;
  if (permits(file)) section = readProviderSection('claude', { env, configPath: file }).section;
  const fromFile = isObject(section) ? ADMIN_KEY_ENV_KEYS.map(k => cleaned(section[k])).find(Boolean) ?? null : null;
  const fileWorkspace = isObject(section) ? cleaned(section[ADMIN_WORKSPACE_SPEND_ENV]) : null;
  return { apiKey: fromFile, workspaceSpend: workspace ?? fileWorkspace };
}

/**
 * Read Claude usage through CodexBar's strategy chain (ProviderFetchPipeline.fetch L396-463): an unavailable strategy is
 * skipped, the first success wins, a failure falls through only when that strategy's shouldFallback says so, the
 * surfaced error is the last available one. Returns `{ reading, identity, attempts }`; identity is never in `reading`.
 *
 * Options (all injectable): sourceMode 'auto'|'api'|'oauth'|'web'|'cli'; runtime 'app' (default — the menu-bar app's
 * plan: oauth → cli → web) | 'cli' (CodexBarCLI: web → cli, no OAuth); selectedAccount `{ token }`; env; homeDir;
 * workingDirectory; readFile; credentials (B1 store); keychainReadConsent (CodexBar's direct-read consent, default
 * false); configPath; transport; claudeVersion; resolveClaudeBinary; cookieSource; manualCookieHeader; webExtrasEnabled;
 * includeAccountIdentity; platform; now; log.
 */
export async function readClaudeNativeUsage(options = {}) {
  const {
    sourceMode = 'auto', runtime = 'app', selectedAccount = null, env: baseEnv = process.env, homeDir = realHome,
    workingDirectory = process.cwd(), readFile = defaultReadFile, credentials = null, keychainReadConsent = false,
    configPath, transport = defaultClaudeTransport, claudeVersion = null, resolveClaudeBinary = defaultResolveClaudeBinary,
    cookieSource = 'auto', manualCookieHeader = null, webExtrasEnabled = false, includeAccountIdentity = false,
    platform = process.platform, now = Date.now, log = () => {}, redactionSet,
  } = options;
  const secrets = redactionSet ?? new Set(); // shared with the raw store (index.mjs) when injected
  const redact = redactor(secrets);
  const track = v => { if (v) secrets.add(v); return v; };

  const selected = selectedAccount ? applySelectedAccount(baseEnv, sourceMode, selectedAccount) : null;
  const env = selected?.env ?? baseEnv;
  const mode = selected?.sourceMode ?? sourceMode;
  for (const k of [CLAUDE_OAUTH_TOKEN_ENV, ...ADMIN_KEY_ENV_KEYS]) track(cleaned(env[k]));
  if (selected) track(cleaned(selectedAccount.token));

  let admin;
  const adminSettings = () => {
    if (admin === undefined) {
      admin = selected ? { apiKey: envAdminKey(env), workspaceSpend: cleaned(env[ADMIN_WORKSPACE_SPEND_ENV]) }
        : resolveAmbientAdminSettings({ env, credentials, configPath });
      track(admin.apiKey);
    }
    return admin;
  };
  const ctx = {
    runtime, sourceMode: mode, env, selectedAccount, platform, webExtrasEnabled,
    cookieSource: selected?.cookieSource ?? cookieSource, manualCookieHeader: selected?.manualCookieHeader ?? manualCookieHeader,
    hasCLI: false, adminKey: null,
  };

  const loadRecord = () => {
    const record = loadClaudeCredentialRecord({ env, homeDir, workingDirectory, readFile, credentials, keychainReadConsent, now, log });
    track(record.credentials.accessToken);
    track(record.credentials.refreshToken);
    return record;
  };

  const strategies = {
    'claude.admin-api': {
      async isAvailable() { return Boolean(adminSettings().apiKey); },
      async fetch() {
        const { apiKey, workspaceSpend } = adminSettings();
        if (!apiKey) fail('admin-missing-key');
        return mapClaudeAdminUsage(await fetchClaudeAdminUsage({ apiKey, workspaceSpendEnabled: workspaceSpend === 'true', transport, nowMs: now() }));
      },
      shouldFallback: () => runtime === 'app' && mode === 'auto' && !selected,
    },
    'claude.oauth': {
      // isPlausiblyAvailable L652-713, noninteractive subset: an env token or explicit OAuth always runs once.
      async isAvailable() {
        if (envOAuthToken(env) || mode !== 'auto') return true;
        try {
          const r = loadRecord();
          return r.credentials.scopes.includes('user:profile') && !claudeCredentialsExpired(r.credentials, now());
        } catch { return false; }
      },
      async fetch() {
        const record = loadRecord();
        const c = record.credentials;
        // The refresh chain belongs to Claude Code (owner claudeCLI); CodexBar delegates it — N3. Never redeemed here.
        if (claudeCredentialsExpired(c, now())) fail('needs-refresh');
        if (!c.scopes.includes('user:profile')) fail('oauth-missing-scope');
        const usage = await fetchClaudeOAuthUsage({ accessToken: c.accessToken, transport, claudeVersion: runtime === 'app' ? claudeVersion : null });
        const result = mapClaudeOAuthUsage(usage, { credentials: c, nowMs: now() });
        if (includeAccountIdentity) {
          try { Object.assign(result.identity, await fetchClaudeOAuthProfile({ accessToken: c.accessToken, transport })); } catch (error) {
            log({ category: 'claude-native', message: `claude profile skipped: ${codeOf(error)}` });
          }
        }
        return result;
      },
      // shouldFallback L769-792.
      shouldFallback(error) {
        const code = codeOf(error);
        if (runtime === 'app' && code === 'credentials-unreadable') return true;
        if (runtime === 'app' && mode === 'oauth' && ['credentials-not-found', 'credentials-changed', 'needs-refresh'].includes(code)) return true;
        return runtime === 'app' && mode === 'auto';
      },
    },
    // N4 ports these (browser cookies / the Claude PTY). Planned, never run here.
    'claude.web': { notPorted: true },
    'claude.cli': { notPorted: true },
  };

  const attempts = [];
  let lastError = null;
  const failed = error => {
    const reason = redact(error ? error.reason ?? `${CLAUDE_NATIVE_SOURCE}:${codeOf(error)}` : `${CLAUDE_NATIVE_SOURCE}:no-available-strategy`);
    log({ category: 'claude-native', message: redact(`claude usage failed (${mode}/${runtime}): ${attempts.map(a => `${a.strategy}=${a.available ? a.reason ?? 'ok' : a.reason ?? 'unavailable'}`).join(', ') || 'no strategy'}`) });
    return { reading: { status: 'unavailable', source: CLAUDE_NATIVE_SOURCE, reason, windows: [] }, identity: null, attempts };
  };

  let planned;
  try {
    if (!selected) {
      ctx.hasCLI = resolveClaudeBinary(env) !== null;
      if (mode === 'auto') ctx.adminKey = adminSettings().apiKey;
    }
    planned = resolveClaudeStrategies(ctx);
  } catch (error) { return failed(error); }

  for (const { id, plannedStep } of planned) {
    const strategy = strategies[id];
    if (strategy.notPorted) {
      attempts.push({ strategy: id, available: false, reason: 'not-yet-ported' });
      continue;
    }
    // ClaudePlannedFetchStrategy.isAvailable L517-534.
    let available;
    if (plannedStep && runtime === 'app' && mode === 'oauth' && plannedStep.dataSource === 'oauth') available = true;
    else if (plannedStep && mode === 'auto') available = plannedStep.isPlausiblyAvailable;
    else available = await strategy.isAvailable();
    if (!available) {
      attempts.push({ strategy: id, available: false, reason: null });
      continue;
    }
    try {
      const result = await strategy.fetch();
      attempts.push({ strategy: id, available: true, reason: null });
      return { ...result, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ strategy: id, available: true, reason: redact(error?.reason ?? `${CLAUDE_NATIVE_SOURCE}:${codeOf(error)}`) });
      if (strategy.shouldFallback(error)) continue;
      return failed(error);
    }
  }
  if (!lastError && attempts.some(a => a.reason === 'not-yet-ported')) return failed(new ClaudeNativeError('not-yet-ported'));
  return failed(lastError);
}
