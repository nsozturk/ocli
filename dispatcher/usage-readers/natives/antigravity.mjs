/**
 * N5 — Antigravity native usage reader, part 1: the local language_server probe and the quota-summary buckets.
 *
 * Ported from CodexBar @ 6480977 (MIT, © 2026 Peter Steinberger; LICENSE-CodexBar beside the plugins):
 *   Sources/CodexBarCore/Providers/Antigravity/AntigravityProviderDescriptor.swift (quota-summary prefix L117,
 *     resolveStrategies L221-243, hasSharedOAuthCredentials L245-251, resolveFallbackError L253-260,
 *     AntigravityStatusFetchStrategy L263-313),
 *   AntigravityStatusProbe.swift (snapshot L86-195, quotaSummaryWindows + cadence L197-404, errors L769-831,
 *     paths L847-852, timeout L844, fetch L877-896, localSnapshotScore L923-944, parseUserStatusResponse L975-996,
 *     invalidCode L1038-1042, parseDate L1044-1052, process detection L1110-1314, endpoints L1316-1428,
 *     resolveWorkingEndpoint L1430-1524, request bodies L1549-1576, fetchSnapshot L1578-1642, send L1651-1741),
 *   AntigravityStatusProbe+PortDetection.swift (lsof L104-141), +Deadline.swift (fetchProcessSnapshots L47-92,
 *     fetch L94-122, timeoutForNextAttempt L124-129), +LocalEndpoints.swift (localProbeSchemes L14-22),
 *   +ResponseModels.swift, AntigravityQuotaSummaryParser.swift, AntigravityLocalSnapshotSelection.swift,
 *   AntigravityLocalhostSession.swift (LocalhostTrustPolicy L6-19), AntigravityOAuthCredentialsStore.swift
 *   (environmentCredentialsKey L415, defaultURL L465-474), DarwinProcessEnumerator.swift.
 *
 * Only the `app` and `ide` strategies are ported. `cli` (agy HTTPS / print report), `oauth` and `offline` are N6: they
 * report unavailable with `not-yet-ported`, so the chain skips them. Not ported either (N6): the model-quota tiers of
 * fetchSnapshot (GetUserStatus / GetCommandModelConfigs → the family normalizer and `antigravity-compact-fallback-*`
 * rows, L130-176 + L470-760); a summary without one known bucket stops at `compact-fallback:not-yet-ported`.
 *
 * Process + port discovery: on Darwin CodexBar reads sysctl/libproc (DarwinProcessEnumerator) in-process; Node cannot,
 * so this runs CodexBar's non-Darwin path everywhere: `/bin/ps -ax -o pid=,command=` (L1124-1132) and
 * `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` (PortDetection L114), argv arrays through an injected runner, never a shell.
 *
 * CSRF tokens are secrets: never logged, never in an error, a reason or a reading. Identity (email / plan) is returned
 * beside the reading. Requests go to 127.0.0.1 only, and the default transport refuses any other host. In a test
 * process the defaults fail closed: no process scan, no network, nothing under the real home directory.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { MAX_RESPONSE_BYTES } from '../plugin-host.mjs';

export const ANTIGRAVITY_NATIVE_SOURCE = 'native:antigravity';
/** AntigravityStatusProbe L286 / Descriptor L117: a summary row's id is this prefix + the server's bucketId, as-is. */
export const QUOTA_SUMMARY_PREFIX = 'antigravity-quota-summary-';
const DEFAULT_TIMEOUT_MS = 8_000; // L844
const SESSION_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;
const SERVICE = '/exa.language_server_pb.LanguageServerService';
const GET_USER_STATUS = `${SERVICE}/GetUserStatus`;
const QUOTA_SUMMARY = `${SERVICE}/RetrieveUserQuotaSummary`;
const UNLEASH = `${SERVICE}/GetUnleashData`;
const PS = '/bin/ps';
const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof'];
const OAUTH_ENV_KEY = 'ANTIGRAVITY_OAUTH_CREDENTIALS_JSON';
const NOT_YET_PORTED = 'not-yet-ported';

/** Every failure carries only a typed reason (`<area>:<code>`), never a token, a body, an email or a path. */
export class AntigravityNativeError extends Error {
  constructor(reason) {
    super(`antigravity native: ${reason}`);
    this.name = 'AntigravityNativeError';
    this.reason = reason;
  }
}
const fail = reason => { throw new AntigravityNativeError(reason); };
const reasonOf = error => (error instanceof AntigravityNativeError ? error.reason : 'unexpected');

// ---------------------------------------------------------------- test-process guard

const isTestProcess = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
const realHome = homedir();
function permits(path) {
  if (!isTestProcess()) return true;
  const p = resolve(path);
  return p !== realHome && !p.startsWith(realHome + sep);
}

// ---------------------------------------------------------------- strict decoding (JSONDecoder)

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.hasOwn(o, k) && o[k] !== null && o[k] !== undefined;
const decodeFailed = () => fail('parse:decode-failed');
/** decodeIfPresent: absent / null ⇒ null, the wrong type ⇒ the whole decode fails (as JSONDecoder). */
function opt(o, k, type) {
  if (!has(o, k)) return null;
  const v = o[k];
  const ok = type === 'array' ? Array.isArray(v) : type === 'object' ? isObject(v)
    : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type;
  return ok ? v : decodeFailed();
}
const trimmedOrNull = v => (typeof v === 'string' ? v.trim() : null);
const nonEmpty = v => (typeof v === 'string' && v.length > 0 ? v : null);
function parseJSON(text) {
  try { return JSON.parse(text); } catch { return fail('parse:invalid-json'); }
}

/** CodeValue (ResponseModels L79-111): int or string; OK is 0 / "ok" / "success" / "0". */
function invalidCode(o) {
  if (!has(o, 'code')) return null;
  const c = o.code;
  if (typeof c === 'number' && Number.isInteger(c)) return c === 0 ? null : String(c);
  if (typeof c === 'string') return ['ok', 'success'].includes(c.toLowerCase()) || c === '0' ? null : c;
  return decodeFailed();
}

/** parseDate L1044-1052: ISO-8601 without fractional seconds, else epoch seconds. */
export function parseDate(value) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number(value) * 1000;
  return null;
}
const isoOrNull = ms => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

// ---------------------------------------------------------------- quota summary (AntigravityQuotaSummaryParser.swift)

/** QuotaSummaryRemainingPayload L153-172: `remainingFraction`, or the oneof `{ case: "remainingFraction", value }`. */
function decodeRemaining(v) {
  if (!isObject(v)) return decodeFailed();
  const direct = opt(v, 'remainingFraction', 'number');
  if (direct !== null) return direct;
  return opt(v, 'case', 'string') === 'remainingFraction' ? opt(v, 'value', 'number') : null;
}
function decodeBucket(b) {
  if (!isObject(b)) return decodeFailed();
  const p = {
    bucketId: opt(b, 'bucketId', 'string'), id: opt(b, 'id', 'string'), displayName: opt(b, 'displayName', 'string'),
    name: opt(b, 'name', 'string'), description: opt(b, 'description', 'string'), disabled: opt(b, 'disabled', 'boolean'),
    remainingFraction: opt(b, 'remainingFraction', 'number'), remaining: has(b, 'remaining') ? decodeRemaining(b.remaining) : null,
    resetTime: opt(b, 'resetTime', 'string'), window: opt(b, 'window', 'string'),
  };
  // quotaSummaryBucket L73-86.
  const bucketId = trimmedOrNull(p.bucketId ?? p.id);
  if (!bucketId) return null;
  return {
    bucketId,
    displayName: nonEmpty(trimmedOrNull(p.displayName ?? p.name)) ?? bucketId,
    remainingFraction: p.remainingFraction ?? p.remaining,
    resetTime: p.resetTime === null ? null : parseDate(p.resetTime),
    resetDescription: p.description,
    disabled: p.disabled ?? false,
    window: p.window,
  };
}
function decodeGroup(g) {
  if (!isObject(g)) return decodeFailed();
  const displayName = opt(g, 'displayName', 'string');
  const name = opt(g, 'name', 'string');
  const description = opt(g, 'description', 'string');
  const buckets = (opt(g, 'buckets', 'array') ?? []).map(decodeBucket).filter(Boolean);
  if (!buckets.length) return null;
  return { displayName: nonEmpty(trimmedOrNull(displayName ?? name)) ?? 'Quota', description, buckets };
}
function decodePayload(v) {
  if (!isObject(v)) return decodeFailed();
  return { description: opt(v, 'description', 'string'), groups: opt(v, 'groups', 'array') };
}

/** AntigravityQuotaSummaryResponse.snapshot L111-126: response ?? summary ?? root groups. */
export function parseQuotaSummaryResponse(json) {
  if (!isObject(json)) return decodeFailed();
  if (invalidCode(json) !== null) fail('probe:api-error');
  const rootGroups = opt(json, 'groups', 'array');
  const payload = (has(json, 'response') ? decodePayload(json.response) : null)
    ?? (has(json, 'summary') ? decodePayload(json.summary) : null)
    ?? (rootGroups ? { description: opt(json, 'description', 'string'), groups: rootGroups } : null)
    ?? fail('parse:missing-quota-summary');
  const groups = (payload.groups ?? []).map(decodeGroup).filter(Boolean);
  if (!groups.length) fail('parse:missing-quota-groups');
  return { quotaSummary: { description: payload.description, groups }, accountEmail: null, accountPlan: null };
}

/** hasKnownQuotaSummary L93-97. */
const isKnown = b => !b.disabled && b.remainingFraction !== null;
export const hasKnownQuotaSummary = s => s.quotaSummary?.groups.some(g => g.buckets.some(isKnown)) === true;

const SESSION_ALIASES = ['session', '5h', '5-hour', 'five hour', 'five-hour'];
/** quotaCadenceCandidates L375-404: an explicit `window` wins; else bucketId + displayName; `-<alias>` suffixes count. */
function cadenceCandidates(bucket) {
  const explicit = bucket.window?.trim();
  const values = explicit ? [explicit] : [bucket.bucketId, bucket.displayName];
  const candidates = new Set();
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase().replaceAll('_', '-');
    if (!normalized) continue;
    const forms = [normalized];
    if (normalized.endsWith(' limit')) forms.push(normalized.slice(0, -' limit'.length));
    for (const c of forms) {
      candidates.add(c);
      for (const alias of [...SESSION_ALIASES, 'weekly']) if (c.endsWith(`-${alias}`)) candidates.add(alias);
    }
  }
  return candidates;
}
/** quotaBucketKind L356-365. */
function bucketKind(bucket) {
  const c = cadenceCandidates(bucket);
  if (SESSION_ALIASES.some(a => c.has(a))) return 'session';
  if (c.has('weekly')) return 'weekly';
  return 'other';
}
/** windowMinutes(forQuotaBucket:) L320-329. */
const bucketMinutes = b => ({ session: SESSION_MINUTES, weekly: WEEKLY_MINUTES })[bucketKind(b)] ?? null;
const bucketTitle = b => ({ session: '5-hour', weekly: 'weekly' })[bucketKind(b)] ?? b.displayName;
const bucketRank = b => ({ session: 0, weekly: 1 })[bucketKind(b)] ?? 2;
/** displayTitle(forQuotaGroup:) L297-307. */
function groupTitle(group) {
  const title = group.displayName.trim();
  const lower = title.toLowerCase();
  if (lower.includes('gemini')) return 'Gemini';
  if (lower.includes('claude') || lower.includes('gpt')) return 'Claude/GPT';
  return title || 'Quota';
}
const groupRank = g => ({ Gemini: 0, 'Claude/GPT': 1 })[groupTitle(g)] ?? 2;
const remainingPercent = f => (f === null ? null : Math.max(0, Math.min(100, f * 100)));

/** quotaSummaryWindows L243-280: groups Gemini, Claude/GPT, rest; buckets 5h, weekly, rest; ties keep server order. */
export function quotaSummaryWindows(quotaSummary) {
  const groups = [...quotaSummary.groups].sort((a, b) => groupRank(a) - groupRank(b));
  return groups.flatMap(group => [...group.buckets].sort((a, b) => bucketRank(a) - bucketRank(b)).map(bucket => {
    const remaining = remainingPercent(bucket.remainingFraction);
    return {
      id: QUOTA_SUMMARY_PREFIX + bucket.bucketId,
      title: `${groupTitle(group)} ${bucketTitle(bucket)}`,
      usedPercent: remaining === null ? 0 : 100 - remaining,
      windowMinutes: bucketMinutes(bucket),
      resetsAt: isoOrNull(bucket.resetTime),
      resetDescription: bucket.resetDescription,
      usageKnown: isKnown(bucket),
    };
  }));
}

/**
 * toUsageSnapshot → our reading. Only the `antigravity-quota-summary-*` rows (CodexBar's extraRateWindows): primary /
 * secondary are representatives of the same rows. A lane CodexBar marks usageKnown=false (disabled, or no fraction)
 * would read as 0% used, so it is dropped and the reading says dataConfidence unknown. Identity is returned beside it.
 */
export function mapAntigravityUsage(snapshot, { nowMs = Date.now(), strategy }) {
  const named = quotaSummaryWindows(snapshot.quotaSummary);
  if (!named.length) fail('parse:no-quota-buckets'); // L203-205
  const known = named.filter(w => w.usageKnown);
  const windows = known.map(w => ({ limitId: w.id, usedPercent: w.usedPercent, windowDurationMins: w.windowMinutes, resetsAt: w.resetsAt }));
  const reading = { status: 'ok', source: ANTIGRAVITY_NATIVE_SOURCE, strategy, updatedAt: isoOrNull(nowMs), windows,
    dataConfidence: known.length === named.length ? 'exact' : 'unknown' };
  return { reading, identity: { email: snapshot.accountEmail, plan: snapshot.accountPlan } };
}

// ---------------------------------------------------------------- GetUserStatus identity (L975-996, ResponseModels)

const preferred = values => values.map(trimmedOrNull).find(v => v) ?? null;
function decodeModelConfigs(data) {
  if (data === null) return;
  for (const c of opt(data, 'clientModelConfigs', 'array') ?? []) {
    if (!isObject(c) || typeof c.label !== 'string' || !isObject(c.modelOrAlias) || typeof c.modelOrAlias.model !== 'string') decodeFailed();
    const q = opt(c, 'quotaInfo', 'object');
    if (q) { opt(q, 'remainingFraction', 'number'); opt(q, 'resetTime', 'string'); }
  }
}
/** parseUserStatusResponse, identity half: email, and userTier.name over planInfo (L988-989). */
export function parseUserStatusIdentity(json) {
  if (!isObject(json)) return decodeFailed();
  if (invalidCode(json) !== null) fail('probe:api-error');
  const status = opt(json, 'userStatus', 'object') ?? fail('parse:missing-user-status');
  const email = opt(status, 'email', 'string');
  decodeModelConfigs(opt(status, 'cascadeModelConfigData', 'object'));
  const tier = opt(status, 'userTier', 'object');
  const planInfo = opt(opt(status, 'planStatus', 'object') ?? {}, 'planInfo', 'object');
  const tierName = tier ? preferred([opt(tier, 'name', 'string')]) : null;
  const planName = planInfo ? preferred(['planDisplayName', 'displayName', 'productName', 'planName', 'planShortName'].map(k => opt(planInfo, k, 'string'))) : null;
  return { accountEmail: email, accountPlan: tierName ?? planName };
}
/** withIdentity L179-195. */
const withIdentity = (snapshot, identity) => (identity
  ? { ...snapshot, accountEmail: identity.accountEmail ?? snapshot.accountEmail, accountPlan: identity.accountPlan ?? snapshot.accountPlan }
  : snapshot);

/** localSnapshotScore L923-944 (summary snapshots only: the model-quota tiers are N6). */
export function localSnapshotScore(snapshot) {
  const buckets = snapshot.quotaSummary.groups.flatMap(g => g.buckets);
  return 1000 + snapshot.quotaSummary.groups.length * 10 + buckets.length + buckets.filter(isKnown).length * 20
    + (snapshot.accountEmail !== null ? 2 : 0) + (snapshot.accountPlan !== null ? 1 : 0);
}
/** AntigravityLocalSnapshotSelection.preferredLocalSnapshot: an expected email narrows; the highest score wins (first on ties). */
export function preferredLocalSnapshot(snapshots, expectedAccountEmail = null) {
  const norm = e => nonEmpty(trimmedOrNull(e));
  const expected = norm(expectedAccountEmail);
  let candidates = snapshots;
  if (expected) {
    const matches = snapshots.filter(s => norm(s.accountEmail)?.toLowerCase() === expected.toLowerCase());
    if (matches.length) candidates = matches;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const s of candidates) {
    const score = localSnapshotScore(s);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// ---------------------------------------------------------------- process detection (L1110-1314)

const LANGUAGE_SERVER = /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/;
const CLI_PATH = /(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)/;
const AGY = /(^|[/\\])agy(\s|$)/;
const IDE_MARKERS = ['antigravity ide.app/', 'antigravity ide.app\\', '--app_data_dir antigravity-ide', '--app_data_dir=antigravity-ide',
  '/extensions/antigravity/bin/language_server', '\\extensions\\antigravity\\bin\\language_server'];
function isAntigravityCommandLine(c) {
  if (c.includes('--app_data_dir') && c.includes('antigravity')) return true;
  return ['antigravity.app/', 'antigravity.app\\', '/gemini.app/', '\\gemini.app\\', 'antigravity ide.app/', 'antigravity ide.app\\',
    '/antigravity/', '\\antigravity\\'].some(m => c.includes(m));
}
/** antigravityProcessKind L1226-1235: desktop language servers first (they keep their CSRF requirement), then the CLI. */
export function antigravityProcessKind(command) {
  const lower = command.toLowerCase();
  if (LANGUAGE_SERVER.test(lower) && isAntigravityCommandLine(lower)) return IDE_MARKERS.some(m => lower.includes(m)) ? 'ide' : 'app';
  if (CLI_PATH.test(lower) || AGY.test(lower)) return 'cli';
  return null;
}
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** extractFlag L1302-1309. */
function extractFlag(flag, command) {
  return new RegExp(`${escapeRegExp(flag)}[=\\s]+([^\\s]+)`, 'i').exec(command)?.[1] ?? null;
}
function extractPort(flag, command) {
  const raw = extractFlag(flag, command);
  return raw !== null && /^[+-]?\d+$/.test(raw) ? Number(raw) : null;
}
/** resolvedCSRFToken L1252-1260. */
export function resolvedCSRFToken(kind, command) {
  return extractFlag('--csrf_token', command) ?? (kind === 'cli' ? '' : null);
}
const SCOPE_KINDS = { ideAndCLI: null, appOnly: 'app', ideOnly: 'ide' };

/** processInfos(fromProcessListOutput:) L1147-1194 with matchProcessLine L1201-1207. */
export function processInfosFromProcessList(output, scope = 'ideAndCLI') {
  let sawTokenless = false;
  const results = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    const at = trimmed.indexOf(' ');
    if (at <= 0 || !/^[+-]?\d+$/.test(trimmed.slice(0, at))) continue;
    const command = trimmed.slice(at + 1).replace(/^ +/, '');
    if (!command) continue;
    const kind = antigravityProcessKind(command);
    if (!kind || (SCOPE_KINDS[scope] && SCOPE_KINDS[scope] !== kind)) continue;
    const csrfToken = resolvedCSRFToken(kind, command);
    if (csrfToken === null) { sawTokenless = true; continue; }
    results.push({ pid: Number(trimmed.slice(0, at)), kind, csrfToken, extensionPort: extractPort('--extension_server_port', command),
      extensionServerCSRFToken: extractFlag('--extension_server_csrf_token', command) });
  }
  if (results.length) return results;
  return fail(sawTokenless ? 'probe:missing-csrf-token' : 'probe:not-running');
}

/** Default runner: execFile (argv, no shell). Refused in a test process. Resolves `{ stdout, stderr, code }`. */
export async function defaultAntigravityRunner(binary, args, { timeoutMs }) {
  if (isTestProcess()) fail('probe:refused-in-test-process');
  return new Promise((done, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: MAX_RESPONSE_BYTES, env: process.env }, (error, stdout, stderr) => {
      if (!error) return done({ stdout, stderr, code: 0 });
      if (error.killed || error.signal) return reject(new AntigravityNativeError('probe:timed-out'));
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new AntigravityNativeError('probe:output-too-large'));
      if (typeof error.code === 'number') return done({ stdout, stderr, code: error.code });
      return reject(new AntigravityNativeError('probe:launch-failed'));
    });
  });
}
async function run(runner, binary, args, timeoutMs) {
  try { return await runner(binary, args, { timeoutMs }); } catch (error) { return fail(error instanceof AntigravityNativeError ? error.reason : 'probe:launch-failed'); }
}

/** detectProcessInfos L1110-1134 (the non-Darwin `ps` path). */
export async function detectProcessInfos({ runner = defaultAntigravityRunner, timeoutMs = DEFAULT_TIMEOUT_MS, scope = 'ideAndCLI' } = {}) {
  const r = await run(runner, PS, ['-ax', '-o', 'pid=,command='], timeoutMs);
  if (r.code !== 0) fail('probe:ps-failed');
  return processInfosFromProcessList(r.stdout, scope);
}

/** parseListeningPorts PortDetection L130-141: every `:<port> (LISTEN)`, sorted, unique. */
export function parseLsofListeningPorts(output) {
  return [...new Set([...output.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
}
function defaultLsofPath() {
  return LSOF_CANDIDATES.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } }) ?? null;
}
/** lsofListeningPorts PortDetection L104-128 (exit 1 with empty stderr = nothing listening). */
export async function listeningPorts(pid, { runner = defaultAntigravityRunner, timeoutMs = DEFAULT_TIMEOUT_MS, lsofPath = defaultLsofPath() } = {}) {
  if (!lsofPath) fail('probe:port-detection-failed');
  const r = await run(runner, lsofPath, ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], timeoutMs);
  if (r.code !== 0) fail('probe:port-detection-failed');
  const ports = parseLsofListeningPorts(r.stdout);
  return ports.length ? ports : fail('probe:port-detection-failed');
}

// ---------------------------------------------------------------- endpoints + deadlines

const endpoint = (scheme, port, csrfToken, source) => ({ scheme, port, csrfToken, source });
const sameTarget = (a, b) => a.scheme === b.scheme && a.port === b.port && a.csrfToken === b.csrfToken;
const requiresCSRF = e => e.source !== 'cli-https';
/** languageServerEndpoints L1376-1389 (localProbeSchemes: https on macOS). */
const languageServerEndpoints = (ports, token) => ports.map(port => endpoint('https', port, token, 'language-server'));
/** extensionServerEndpoints L1391-1418. */
function extensionServerEndpoints(port, lsToken, extToken) {
  if (port === null || port === undefined) return [];
  const out = [];
  if (extToken !== null && extToken !== undefined) out.push(endpoint('http', port, extToken, 'extension-server'));
  if (extToken !== lsToken) out.push(endpoint('http', port, lsToken, 'extension-server'));
  return out;
}
function appendUnique(into, from) {
  for (const e of from) if (!into.some(x => sameTarget(x, e))) into.push(e);
  return into;
}
/** connectionCandidates L1316-1336. */
export function connectionCandidates({ listeningPorts: ports, languageServerCSRFToken, extensionServerPort = null, extensionServerCSRFToken = null }) {
  return appendUnique(languageServerEndpoints(ports, languageServerCSRFToken),
    extensionServerEndpoints(extensionServerPort, languageServerCSRFToken, extensionServerCSRFToken));
}
/** requestEndpoints L1338-1374: the resolved endpoint first, then its own kind, then the other. */
export function requestEndpoints({ resolvedEndpoint, listeningPorts: ports, languageServerCSRFToken, extensionServerPort = null, extensionServerCSRFToken = null }) {
  const ls = languageServerEndpoints(ports, languageServerCSRFToken);
  const ext = extensionServerEndpoints(extensionServerPort, languageServerCSRFToken, extensionServerCSRFToken);
  const order = resolvedEndpoint.source === 'extension-server' ? [ext, ls] : [ls, ext];
  return order.reduce(appendUnique, [resolvedEndpoint]);
}

/** timeoutForNextAttempt +Deadline L124-129: null when the deadline has passed. */
function timeoutForNextAttempt(timeoutMs, deadline, now) {
  if (deadline === null || deadline === undefined) return timeoutMs;
  const remaining = deadline - now();
  return remaining > 0 ? Math.min(timeoutMs, remaining) : null;
}
/** isReachableProbeError L1481-1484: any HTTP status means something is listening. */
export const isReachableProbeError = error => reasonOf(error).startsWith('probe:http-');
/** fallbackProbePort L1471-1479. */
export function fallbackProbePort(ports, extensionPort) {
  return ports.find(p => p !== extensionPort) ?? extensionPort ?? ports[0] ?? null;
}

/** resolveWorkingEndpoint L1430-1469: the first reachable candidate, else the first language-server one, else the first. */
export async function resolveWorkingEndpoint(candidates, { timeoutMs = DEFAULT_TIMEOUT_MS, deadline = null, now = Date.now, testConnectivity }) {
  for (let i = 0; i < candidates.length; i += 1) {
    let attempt = timeoutMs;
    if (deadline !== null) {
      const remaining = deadline - now();
      if (!(remaining > 0)) fail('probe:timed-out');
      attempt = Math.min(timeoutMs, remaining / Math.max(1, candidates.length - i));
    }
    if (await testConnectivity(candidates[i], attempt)) return candidates[i];
  }
  return candidates.find(e => e.source === 'language-server') ?? candidates[0] ?? fail('probe:port-detection-failed');
}

// ---------------------------------------------------------------- HTTP (sendRequest L1711-1741, LocalhostTrustPolicy)

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
function assertLoopback(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return fail('probe:invalid-url'); }
  if (!LOOPBACK_HOSTS.has(host)) fail('probe:non-loopback');
}

/**
 * Default transport: node:http(s) to a loopback host only; the language_server's self-signed certificate is trusted
 * only there (LocalhostTrustPolicy L6-19). No redirects are followed. Refused in a test process.
 */
export async function defaultAntigravityTransport({ url, method, headers, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  assertLoopback(url);
  if (isTestProcess()) fail('probe:refused-in-test-process');
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((done, reject) => {
    const req = send(target, { method, headers, timeout: timeoutMs, rejectUnauthorized: false }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); reject(new AntigravityNativeError('probe:response-too-large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', () => reject(new AntigravityNativeError('probe:network-error')));
    });
    req.on('timeout', () => { req.destroy(); reject(new AntigravityNativeError('probe:timed-out')); });
    req.on('error', () => reject(new AntigravityNativeError('probe:network-error')));
    req.end(body);
  });
}

const bodyText = body => (typeof body === 'string' ? body : Buffer.from(body ?? []).toString('utf8'));
/**
 * sendRequest L1711-1741. A non-200 is `probe:http-<status>`: CodexBar puts the body into the message (L1737-1738), but
 * a body can echo the CSRF token, so it is dropped here.
 */
export async function sendAntigravityRequest(payload, ep, timeoutMs, { transport = defaultAntigravityTransport } = {}) {
  const url = `${ep.scheme}://127.0.0.1:${ep.port}${payload.path}`;
  assertLoopback(url);
  const body = JSON.stringify(payload.body);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'Connect-Protocol-Version': '1' };
  if (requiresCSRF(ep)) headers['X-Codeium-Csrf-Token'] = ep.csrfToken;
  let res;
  try { res = await transport({ url, method: 'POST', headers, body, timeoutMs }); } catch (error) { return fail(error instanceof AntigravityNativeError ? error.reason : 'probe:network-error'); }
  if (res.status !== 200) fail(`probe:http-${res.status}`);
  return bodyText(res.body);
}

/** makeParsedRequest L1651-1681: each endpoint in turn while time remains; a parse / API error tries the next. */
async function makeParsedRequest(payload, ctx, send, parse) {
  let lastError = null;
  for (const ep of ctx.endpoints) {
    const timeout = timeoutForNextAttempt(ctx.timeoutMs, ctx.deadline, ctx.now);
    if (timeout === null) { lastError ??= new AntigravityNativeError('probe:timed-out'); break; }
    try {
      return parse(parseJSON(await send(payload, ep, timeout)));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new AntigravityNativeError('probe:api-error');
}

const METADATA = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' } };
const UNLEASH_BODY = { context: { properties: { devMode: 'false', extensionVersion: 'unknown', hasAnthropicModelAccess: 'true', ide: 'antigravity',
  ideVersion: 'unknown', installationId: 'codexbar', language: 'UNSPECIFIED', os: 'macos', requestedModelId: 'MODEL_UNSPECIFIED' } } };

/**
 * fetchSnapshot L1578-1642: the quota summary with half the remaining budget (fallbackReservingRequestContext), then
 * identity from GetUserStatus with at most 1 s (identityRequestContext). A failed summary request surfaces its own
 * error; a summary with no known bucket would fall back to the model-quota tiers, not ported (N6).
 */
export async function fetchSnapshot({ endpoints, timeoutMs = DEFAULT_TIMEOUT_MS, deadline = null, now = Date.now, send }) {
  let reserving = { endpoints, timeoutMs, deadline, now };
  if (deadline !== null) {
    const budget = Math.max(0, deadline - now()) / 2;
    reserving = { endpoints, timeoutMs: Math.min(timeoutMs, budget), deadline: now() + budget, now };
  }
  const summary = await makeParsedRequest({ path: QUOTA_SUMMARY, body: { forceRefresh: true } }, reserving, send, parseQuotaSummaryResponse);
  if (!hasKnownQuotaSummary(summary)) fail('compact-fallback:not-yet-ported');
  let identity = null;
  try {
    identity = await makeParsedRequest({ path: GET_USER_STATUS, body: METADATA }, { endpoints, timeoutMs: Math.min(timeoutMs, 1000), deadline, now }, send, parseUserStatusIdentity);
  } catch { /* identity is optional (try?) */ }
  return withIdentity(summary, identity);
}

/**
 * AntigravityStatusProbe.fetch L877-896 + fetch(processInfo:) +Deadline L94-122: every matching process is probed
 * concurrently; the best snapshot wins, else the last failure (in process order).
 */
async function probeLocal({ scope, timeoutMs, now, runner, lsofPath, send, expectedAccountEmail, track }) {
  const deadline = now() + timeoutMs;
  const infos = await detectProcessInfos({ runner, timeoutMs, scope });
  for (const info of infos) track(info.csrfToken, info.extensionServerCSRFToken);
  const testConnectivity = async (ep, ms) => {
    try { await send({ path: UNLEASH, body: UNLEASH_BODY }, ep, ms); return true; } catch (error) { return isReachableProbeError(error); }
  };
  const outcomes = await Promise.all(infos.map(async info => {
    try {
      const portTimeout = timeoutForNextAttempt(timeoutMs, deadline, now) ?? fail('probe:timed-out');
      const ports = await listeningPorts(info.pid, { runner, timeoutMs: portTimeout, lsofPath });
      const tokens = { listeningPorts: ports, languageServerCSRFToken: info.csrfToken, extensionServerPort: info.extensionPort,
        extensionServerCSRFToken: info.extensionServerCSRFToken };
      const resolved = await resolveWorkingEndpoint(connectionCandidates(tokens), { timeoutMs, deadline, now, testConnectivity });
      return { snapshot: await fetchSnapshot({ endpoints: requestEndpoints({ resolvedEndpoint: resolved, ...tokens }), timeoutMs, deadline, now, send }) };
    } catch (error) {
      return { error };
    }
  }));
  const best = preferredLocalSnapshot(outcomes.filter(o => o.snapshot).map(o => o.snapshot), expectedAccountEmail);
  if (best) return best;
  throw outcomes.filter(o => o.error).at(-1)?.error ?? new AntigravityNativeError('probe:not-running');
}

// ---------------------------------------------------------------- strategies (AntigravityProviderDescriptor.swift)

/** hasSharedOAuthCredentials L245-251: <HOME or home>/.codexbar/antigravity/oauth_creds.json exists. */
export function hasSharedOAuthCredentials({ env = process.env, homeDir = realHome } = {}) {
  const path = join(nonEmpty(env.HOME) ?? homeDir, '.codexbar', 'antigravity', 'oauth_creds.json');
  return permits(path) && existsSync(path);
}

/** resolveStrategies L221-243. */
export function resolveAntigravityStrategies({ sourceMode = 'auto', selectedTokenAccountId = null, env = process.env, homeDir = realHome } = {}) {
  const [app, cli, ide, oauth, offline] = ['antigravity.app-local', 'antigravity.cli-https', 'antigravity.ide-local', 'antigravity.oauth', 'antigravity.offline'];
  switch (sourceMode) {
    case 'cli': return [app, cli, ide, offline];
    case 'oauth': return [oauth];
    case 'auto':
      return selectedTokenAccountId !== null || env[OAUTH_ENV_KEY] !== undefined || hasSharedOAuthCredentials({ env, homeDir })
        ? [app, cli, ide, oauth, offline] : [app, cli, ide, offline];
    case 'web': case 'api': return [];
    default: return fail('config:unknown-source-mode');
  }
}

/** resolveFallbackError L253-260: a later not-running / missing-csrf keeps an earlier real error. */
export function resolveFallbackError(previous, current) {
  if (!previous) return current;
  if (['probe:not-running', 'probe:missing-csrf-token'].includes(reasonOf(current))) {
    return reasonOf(previous) === 'probe:not-running' ? current : previous;
  }
  return current;
}

function redactor(secrets) {
  return text => {
    let out = String(text);
    for (const v of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
    return out;
  };
}

/**
 * Read Antigravity usage through CodexBar's strategy chain (ProviderFetchPipeline.fetch L396-463): an unavailable
 * strategy is skipped, the first success wins, a failure falls through when shouldFallback says so (app / ide: auto
 * and cli modes, L310-312); the surfaced error is combined by resolveFallbackError. Returns `{ reading, identity,
 * attempts }`; identity is never inside `reading`.
 *
 * Options (all injectable; tests inject every one): sourceMode 'auto'|'cli'|'oauth'|'web'|'api', selectedTokenAccountId,
 * expectedAccountEmail, env, homeDir, runner (ps / lsof), lsofPath, transport, timeoutMs, now, log.
 */
export async function readAntigravityNativeUsage(options = {}) {
  const {
    sourceMode = 'auto', selectedTokenAccountId = null, expectedAccountEmail = null, env = process.env, homeDir = realHome,
    runner = defaultAntigravityRunner, lsofPath, transport = defaultAntigravityTransport, timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now, log = () => {}, redactionSet,
  } = options;
  const secrets = redactionSet ?? new Set(); // shared with the raw store (index.mjs) when injected
  const redact = redactor(secrets);
  const track = (...values) => { for (const v of values) if (v) secrets.add(v); };
  const send = (payload, ep, ms) => sendAntigravityRequest(payload, ep, ms, { transport });
  const local = scope => ({
    available: () => true,
    async fetch(id) {
      const snapshot = await probeLocal({ scope, timeoutMs, now, runner, lsofPath: lsofPath === undefined ? defaultLsofPath() : lsofPath, send, expectedAccountEmail, track });
      return mapAntigravityUsage(snapshot, { nowMs: now(), strategy: id });
    },
    shouldFallback: () => sourceMode === 'auto' || sourceMode === 'cli',
  });
  const notYetPorted = { available: () => false, unavailableReason: NOT_YET_PORTED };
  const strategies = {
    'antigravity.app-local': local('appOnly'),
    'antigravity.ide-local': local('ideOnly'),
    'antigravity.cli-https': notYetPorted,
    'antigravity.oauth': notYetPorted,
    'antigravity.offline': notYetPorted,
  };

  const attempts = [];
  const failed = error => {
    const reason = redact(reasonOf(error));
    log({ category: 'antigravity-native', message: redact(`antigravity usage failed (${sourceMode}): ${attempts.map(a => `${a.strategy}=${a.available ? a.reason ?? 'ok' : a.reason ?? 'unavailable'}`).join(', ')}`) });
    return { reading: { status: 'unavailable', source: ANTIGRAVITY_NATIVE_SOURCE, reason, windows: [] }, identity: null, attempts };
  };
  let ids;
  try { ids = resolveAntigravityStrategies({ sourceMode, selectedTokenAccountId, env, homeDir }); } catch (error) { return failed(error); }
  let lastAvailableError = null;
  for (const id of ids) {
    const strategy = strategies[id];
    if (!strategy.available()) {
      attempts.push({ strategy: id, available: false, reason: strategy.unavailableReason ?? null });
      continue;
    }
    try {
      const result = await strategy.fetch(id);
      attempts.push({ strategy: id, available: true, reason: null });
      return { ...result, attempts };
    } catch (error) {
      lastAvailableError = resolveFallbackError(lastAvailableError, error);
      attempts.push({ strategy: id, available: true, reason: redact(reasonOf(error)) });
      if (strategy.shouldFallback()) continue;
      return failed(lastAvailableError);
    }
  }
  const unported = attempts.some(a => a.reason === NOT_YET_PORTED);
  return failed(lastAvailableError ?? new AntigravityNativeError(unported ? NOT_YET_PORTED : 'no-available-strategy'));
}
