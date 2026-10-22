import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTIGRAVITY_NATIVE_SOURCE, AntigravityNativeError, QUOTA_SUMMARY_PREFIX,
  antigravityProcessKind, resolvedCSRFToken, processInfosFromProcessList, detectProcessInfos,
  parseLsofListeningPorts, listeningPorts, connectionCandidates, requestEndpoints, resolveWorkingEndpoint,
  isReachableProbeError, fallbackProbePort, sendAntigravityRequest, defaultAntigravityTransport, defaultAntigravityRunner,
  parseQuotaSummaryResponse, quotaSummaryWindows, fetchSnapshot, localSnapshotScore, preferredLocalSnapshot,
  mapAntigravityUsage, resolveAntigravityStrategies, hasSharedOAuthCredentials, resolveFallbackError,
  readAntigravityNativeUsage,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/natives/antigravity.mjs';

// No real process scan (the ps / lsof runner is a stub), no network (the transport is a stub), no real home.

const EMAIL = 'person-a9f@example.invalid';
const CSRF_APP = 'csrf-SECRET-app-71';
const CSRF_EXT = 'csrf-SECRET-ext-72';
const CSRF_IDE = 'csrf-SECRET-ide-73';
const SECRETS = [EMAIL, CSRF_APP, CSRF_EXT, CSRF_IDE, 'csrf-SECRET'];
const QS = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const US = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const UNLEASH = '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const ARGON = 'antigravity-quota-summary-gemini-argon-wtu-weekly';

// Ported from Tests/CodexBarTests/AntigravityQuotaSummaryTests.swift `antigravityQuotaSummaryJSON` (L410-461).
function quotaSummaryJSON({ geminiSession = 0.91, geminiWeekly = 0.82, claudeSession = 0.73, claudeWeekly = 0.64, argon = null as number | null } = {}) {
  const geminiBuckets: unknown[] = [
    { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remaining: { remainingFraction: geminiWeekly },
      description: 'You have used some of your weekly limit, it will fully refresh in 5 days, 11 hours.', resetTime: '2026-06-19T08:45:39Z' },
    { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', remaining: { remainingFraction: geminiSession },
      description: 'You have used some of your 5-hour limit, it will fully refresh in 4 hours.', resetTime: '2026-06-15T11:39:34Z' },
  ];
  // Not in CodexBar's fixtures: built from QuotaSummaryBucketPayload (Parser L140-151), the bucket our plans read.
  if (argon !== null) {
    geminiBuckets.push({ bucketId: 'gemini-argon-wtu-weekly', displayName: 'Argon WTU Weekly Limit',
      remaining: { remainingFraction: argon }, resetTime: '2026-06-21T00:00:00Z' });
  }
  return JSON.stringify({ response: {
    description: 'Within each group, models share a weekly limit and a 5-hour limit.',
    groups: [
      { displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro', buckets: geminiBuckets },
      { displayName: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit', remaining: { remainingFraction: claudeWeekly },
          description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.', resetTime: '2026-06-20T00:39:54Z' },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit', remaining: { remainingFraction: claudeSession },
          description: 'You have used some of your 5-hour limit, it will fully refresh in 3 hours, 38 minutes.', resetTime: '2026-06-15T12:52:10Z' },
      ] },
    ],
  } });
}
// Ported (`antigravityQuotaSummaryWithoutKnownUsageJSON` L463-487).
const QUOTA_SUMMARY_NO_KNOWN = JSON.stringify({ response: { groups: [{ displayName: 'Gemini Models', buckets: [
  { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', description: 'Refreshes later.' },
  { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', disabled: true, remaining: { remainingFraction: 0.5 } },
] }] } });
// Ported (`antigravityUserStatusJSON` L489-511), the address swapped for a reserved one.
const USER_STATUS = JSON.stringify({ code: 0, userStatus: { email: EMAIL, planStatus: { planInfo: { planName: 'Pro' } },
  cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3 Pro Low', modelOrAlias: { model: 'gemini-3-pro-low' },
    quotaInfo: { remainingFraction: 0.9, resetTime: '2025-12-24T10:00:00Z' } }] } } });

const single = (bucket: Record<string, unknown>) => JSON.stringify({ groups: [{ displayName: 'Gemini Models', buckets: [bucket] }] });
const windowsOf = (json: string) => quotaSummaryWindows(parseQuotaSummaryResponse(JSON.parse(json)).quotaSummary);

const ep = (scheme: string, port: number, csrfToken: string, source: string) => ({ scheme, port, csrfToken, source });

// ------------------------------------------------------------------- process listing (ps -ax -o pid=,command=)

const APP_LINE = `  202 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token ${CSRF_APP} --app_data_dir antigravity --extension_server_port 57001 --extension_server_csrf_token ${CSRF_EXT}`;
const IDE_LINE = `  303 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token ${CSRF_IDE} --app_data_dir antigravity-ide`;
const CLI_LINE = '  404 /Users/test/.local/bin/agy -p hello';
const HELPER_LINE = '  505 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=renderer';
const PS_LISTING = ['    1 /sbin/launchd', HELPER_LINE, CLI_LINE, IDE_LINE, APP_LINE, ''].join('\n');
const LSOF_202 = [
  'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'language_ 202 test   12u  IPv4 0x1111      0t0  TCP 127.0.0.1:64440 (LISTEN)',
  'language_ 202 test   13u  IPv4 0x1112      0t0  TCP 127.0.0.1:57001 (LISTEN)',
  'language_ 202 test   14u  IPv6 0x1113      0t0  TCP [::1]:64440 (LISTEN)',
].join('\n');
const LSOF_303 = 'language_ 303 test   12u  IPv4 0x2111      0t0  TCP 127.0.0.1:64550 (LISTEN)';

type RunCall = { binary: string; args: string[]; timeoutMs: number };
function runnerFor(listing: string, lsof: Record<string, { stdout?: string; stderr?: string; code?: number }>) {
  const calls: RunCall[] = [];
  const runner = vi.fn(async (binary: string, args: string[], opts: { timeoutMs: number }) => {
    calls.push({ binary, args, timeoutMs: opts.timeoutMs });
    if (binary === '/bin/ps') return { stdout: listing, stderr: '', code: 0 };
    if (binary.endsWith('lsof')) {
      const r = lsof[args[args.length - 1]] ?? { stdout: '', stderr: '', code: 1 };
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
    }
    throw new Error(`unexpected binary ${binary}`);
  });
  return { runner, calls };
}

type Req = { url: string; method: string; headers: Record<string, string>; body: string; timeoutMs: number };
function transportFor(route: (req: Req) => { status: number; body: string }) {
  const requests: Req[] = [];
  const transport = vi.fn(async (req: Req) => {
    requests.push(req);
    const res = route(req);
    return { status: res.status, body: Buffer.from(res.body) };
  });
  return { transport, requests };
}
const pathOf = (url: string) => new URL(url).pathname;

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
function fakeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'n5-home-'));
  dirs.push(dir);
  return dir;
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of SECRETS) expect(text).not.toContain(s);
}

describe('N5 process detection (AntigravityStatusProbe L1110-1314, ported from AntigravityStatusProbeTests)', () => {
  it('classifies app, ide and cli command lines; helpers and look-alikes are ignored', () => {
    expect(antigravityProcessKind('/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --override_ide_version 2.0.0 --csrf_token token --app_data_dir antigravity')).toBe('app');
    expect(antigravityProcessKind('/Applications/Google Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --csrf_token token --app_data_dir antigravity')).toBe('app');
    expect(antigravityProcessKind('/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos --csrf_token token --app_data_dir antigravity')).toBe('app');
    expect(antigravityProcessKind(IDE_LINE.trim().replace(/^\d+ /, ''))).toBe('ide');
    expect(antigravityProcessKind('/Users/test/.local/bin/agy -p hi')).toBe('cli');
    expect(antigravityProcessKind('node /x/.gemini/antigravity-cli/build/mcp-server.cjs --app_data_dir /x/.gemini/antigravity')).toBe('cli');
    expect(antigravityProcessKind('/usr/local/bin/agy --app_data_dir /Users/test/.gemini/antigravity_cli')).toBe('cli');
    expect(antigravityProcessKind(HELPER_LINE.trim().replace(/^\d+ /, ''))).toBeNull();
    expect(antigravityProcessKind('/usr/bin/legacy --run')).toBeNull();
    expect(antigravityProcessKind('/opt/imagymagic/bin/tool')).toBeNull();
    expect(antigravityProcessKind('/usr/bin/node /tmp/not-antigravity-cli/build/server.js')).toBeNull();
    expect(antigravityProcessKind('/usr/bin/helper --workspace antigravity-cli')).toBeNull();
  });

  it('csrf token: required for app / ide, optional for cli', () => {
    expect(resolvedCSRFToken('app', '/Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token ide-token --app_data_dir antigravity')).toBe('ide-token');
    expect(resolvedCSRFToken('app', '/Applications/Antigravity.app/Contents/Resources/bin/language_server --app_data_dir antigravity')).toBeNull();
    expect(resolvedCSRFToken('cli', '/Users/test/.local/bin/agy -p hi')).toBe('');
    expect(resolvedCSRFToken('cli', '/Users/test/.local/bin/agy --csrf_token=cli-token')).toBe('cli-token');
  });

  it('parses a process listing per scope: pid, tokens, extension port; tokenless skipped; typed not-running / missing-csrf', () => {
    const app = processInfosFromProcessList(PS_LISTING, 'appOnly');
    expect(app.map((p: { pid: number }) => p.pid)).toEqual([202]);
    expect(app[0]).toMatchObject({ csrfToken: CSRF_APP, extensionPort: 57001, extensionServerCSRFToken: CSRF_EXT });
    expect(processInfosFromProcessList(PS_LISTING, 'ideOnly').map((p: { pid: number }) => p.pid)).toEqual([303]);
    expect(processInfosFromProcessList(PS_LISTING, 'ideAndCLI').map((p: { pid: number }) => p.pid)).toEqual([404, 303, 202]);
    expect(processInfosFromProcessList(CLI_LINE, 'ideAndCLI')[0]).toMatchObject({ pid: 404, csrfToken: '' });

    const tokenless = '  100 /Applications/Antigravity.app/Contents/Resources/bin/language_server --app_data_dir antigravity';
    const valid = '  101 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token ide-token --app_data_dir antigravity --extension_server_port 64432 --extension_server_csrf_token extension-token';
    expect(processInfosFromProcessList(`${tokenless}\n${valid}`, 'ideAndCLI')[0]).toMatchObject({ pid: 101, csrfToken: 'ide-token', extensionPort: 64432 });
    expect(() => processInfosFromProcessList(tokenless, 'ideAndCLI')).toThrow(expect.objectContaining({ reason: 'probe:missing-csrf-token' }));
    expect(() => processInfosFromProcessList(CLI_LINE, 'ideOnly')).toThrow(expect.objectContaining({ reason: 'probe:not-running' }));
    expect(() => processInfosFromProcessList(APP_LINE, 'ideOnly')).toThrow(expect.objectContaining({ reason: 'probe:not-running' }));
  });

  it('runs /bin/ps and lsof as argv arrays through the injected runner (no shell); parses LISTEN ports', async () => {
    const { runner, calls } = runnerFor(PS_LISTING, { 202: { stdout: LSOF_202 } });
    const infos = await detectProcessInfos({ runner, timeoutMs: 8000, scope: 'appOnly' });
    expect(infos.map((p: { pid: number }) => p.pid)).toEqual([202]);
    expect(await listeningPorts(202, { runner, timeoutMs: 3000, lsofPath: '/usr/sbin/lsof' })).toEqual([57001, 64440]);
    expect(calls).toEqual([
      { binary: '/bin/ps', args: ['-ax', '-o', 'pid=,command='], timeoutMs: 8000 },
      { binary: '/usr/sbin/lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', '202'], timeoutMs: 3000 },
    ]);
    expect(parseLsofListeningPorts('x TCP 127.0.0.1:1 (ESTABLISHED)\ny TCP *:9 (LISTEN)')).toEqual([9]);
    // lsof exit 1 with empty stderr = no listening ports (PortDetection L118-121).
    await expect(listeningPorts(999, { runner, timeoutMs: 3000, lsofPath: '/usr/sbin/lsof' })).rejects.toMatchObject({ reason: 'probe:port-detection-failed' });
  });
});

describe('N5 endpoints + deadlines (L1316-1493, +Deadline L124-129)', () => {
  it('connection candidates: https language server first, then http extension server with each token, no duplicates', () => {
    expect(connectionCandidates({ listeningPorts: [64440], languageServerCSRFToken: 'lt', extensionServerPort: 64432, extensionServerCSRFToken: 'et' })).toEqual([
      ep('https', 64440, 'lt', 'language-server'), ep('http', 64432, 'et', 'extension-server'), ep('http', 64432, 'lt', 'extension-server')]);
    expect(connectionCandidates({ listeningPorts: [64440, 64441], languageServerCSRFToken: 'lt', extensionServerPort: 64432, extensionServerCSRFToken: null })).toEqual([
      ep('https', 64440, 'lt', 'language-server'), ep('https', 64441, 'lt', 'language-server'), ep('http', 64432, 'lt', 'extension-server')]);
    expect(connectionCandidates({ listeningPorts: [64432], languageServerCSRFToken: 'lt', extensionServerPort: 64432, extensionServerCSRFToken: null })).toEqual([
      ep('https', 64432, 'lt', 'language-server'), ep('http', 64432, 'lt', 'extension-server')]);
  });

  it('request endpoints keep the resolved endpoint first and retry the alternates', () => {
    const ls = ep('https', 64440, 'lt', 'language-server');
    expect(requestEndpoints({ resolvedEndpoint: ls, listeningPorts: [64440], languageServerCSRFToken: 'lt', extensionServerPort: 64432, extensionServerCSRFToken: 'et' })).toEqual([
      ls, ep('http', 64432, 'et', 'extension-server'), ep('http', 64432, 'lt', 'extension-server')]);
    const ext = ep('http', 64432, 'et', 'extension-server');
    expect(requestEndpoints({ resolvedEndpoint: ext, listeningPorts: [64440], languageServerCSRFToken: 'lt', extensionServerPort: 64432, extensionServerCSRFToken: 'et' })).toEqual([
      ext, ep('http', 64432, 'lt', 'extension-server'), ep('https', 64440, 'lt', 'language-server')]);
  });

  it('endpoint resolver: first reachable wins; none ⇒ the first language-server candidate; an exhausted deadline ⇒ timed-out', async () => {
    const candidates = connectionCandidates({ listeningPorts: [64440, 64441], languageServerCSRFToken: 'lt', extensionServerPort: 64432, extensionServerCSRFToken: 'et' });
    const tried: unknown[] = [];
    const got = await resolveWorkingEndpoint(candidates, { timeoutMs: 1000, testConnectivity: async (e: { source: string }) => { tried.push(e); return e.source === 'extension-server'; } });
    expect(got).toEqual(candidates[2]);
    expect(tried).toEqual(candidates.slice(0, 3));
    expect(await resolveWorkingEndpoint(candidates, { timeoutMs: 1000, testConnectivity: async () => false })).toEqual(candidates[0]);
    // timeoutForEndpointAttempt: remaining / attempts left.
    let t = 0;
    const budgets: number[] = [];
    await resolveWorkingEndpoint(candidates.slice(0, 2), { timeoutMs: 8000, deadline: 1000, now: () => t,
      testConnectivity: async (_e: unknown, ms: number) => { budgets.push(ms); t += 100; return false; } });
    expect(budgets).toEqual([500, 900]);
    await expect(resolveWorkingEndpoint(candidates, { timeoutMs: 1000, deadline: 0, now: () => 5, testConnectivity: async () => true }))
      .rejects.toMatchObject({ reason: 'probe:timed-out' });
    expect(isReachableProbeError(new AntigravityNativeError('probe:http-403'))).toBe(true);
    expect(isReachableProbeError(new AntigravityNativeError('probe:network-error'))).toBe(false);
    expect(fallbackProbePort([51170, 61775], 61775)).toBe(51170);
    expect(fallbackProbePort([61775], 61775)).toBe(61775);
  });
});

describe('N5 local transport — loopback only, CSRF is a secret (L1711-1741, LocalhostSession)', () => {
  it('posts JSON to 127.0.0.1 with Connect-Protocol-Version and the CSRF header only where required', async () => {
    const { transport, requests } = transportFor(() => ({ status: 200, body: '{}' }));
    await sendAntigravityRequest({ path: QS, body: { forceRefresh: true } }, ep('https', 64440, CSRF_APP, 'language-server'), 2000, { transport });
    await sendAntigravityRequest({ path: QS, body: { forceRefresh: true } }, ep('https', 64441, '', 'cli-https'), 2000, { transport });
    expect(requests[0]).toMatchObject({ url: `https://127.0.0.1:64440${QS}`, method: 'POST', body: '{"forceRefresh":true}', timeoutMs: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '21', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': CSRF_APP } });
    expect(requests[1].headers).not.toHaveProperty('X-Codeium-Csrf-Token');
  });

  it('a non-200 is probe:http-<status>; the body (which can echo the token) never reaches the error', async () => {
    const { transport } = transportFor(req => ({ status: 403, body: `bad token ${req.headers['X-Codeium-Csrf-Token']}` }));
    const err = await sendAntigravityRequest({ path: US, body: {} }, ep('https', 64440, CSRF_APP, 'language-server'), 2000, { transport }).catch((e: Error) => e);
    expect(err).toMatchObject({ reason: 'probe:http-403' });
    assertNoSecrets(`${err.message} ${err.stack}`);
  });

  it('the default transport refuses any non-loopback host, and in a test process refuses loopback too', async () => {
    for (const url of ['https://10.0.0.5:64440/x', 'https://localhost.example.com:64440/x', 'http://192.168.1.2:1/x']) {
      await expect(defaultAntigravityTransport({ url, method: 'POST', headers: {}, body: '{}', timeoutMs: 100 })).rejects.toMatchObject({ reason: 'probe:non-loopback' });
    }
    await expect(defaultAntigravityTransport({ url: 'https://127.0.0.1:64440/x', method: 'POST', headers: {}, body: '{}', timeoutMs: 100 }))
      .rejects.toMatchObject({ reason: 'probe:refused-in-test-process' });
    await expect(defaultAntigravityRunner('/bin/ps', ['-ax'], { timeoutMs: 100 })).rejects.toMatchObject({ reason: 'probe:refused-in-test-process' });
  });
});

describe('N5 quota summary parser → windows (AntigravityQuotaSummaryParser, StatusProbe L197-404)', () => {
  it('ported fixture: ids, titles, 5h before weekly, durations, used %, resets', () => {
    const w = windowsOf(quotaSummaryJSON());
    expect(w.map((x: { id: string }) => x.id)).toEqual([
      'antigravity-quota-summary-gemini-5h', 'antigravity-quota-summary-gemini-weekly',
      'antigravity-quota-summary-3p-5h', 'antigravity-quota-summary-3p-weekly']);
    expect(w.map((x: { title: string }) => x.title)).toEqual(['Gemini 5-hour', 'Gemini weekly', 'Claude/GPT 5-hour', 'Claude/GPT weekly']);
    expect(w.map((x: { windowMinutes: number }) => x.windowMinutes)).toEqual([300, 10080, 300, 10080]);
    expect(w.map((x: { usedPercent: number }) => Math.round(x.usedPercent))).toEqual([9, 18, 27, 36]);
    expect(w.map((x: { resetsAt: string }) => x.resetsAt)).toEqual([
      '2026-06-15T11:39:34.000Z', '2026-06-19T08:45:39.000Z', '2026-06-15T12:52:10.000Z', '2026-06-20T00:39:54.000Z']);
    expect(w.every((x: { usageKnown: boolean }) => x.usageKnown)).toBe(true);
  });

  it('the Argon WTU weekly bucket: plans id byte-for-byte, weekly (10080), used = 100 − remaining', () => {
    const w = windowsOf(quotaSummaryJSON({ argon: 0.56 })).find((x: { id: string }) => x.id === ARGON);
    expect(w).toMatchObject({ id: ARGON, windowMinutes: 10080, title: 'Gemini weekly', resetsAt: '2026-06-21T00:00:00.000Z' });
    expect(w.usedPercent).toBeCloseTo(44, 10);
  });

  it('oneof remaining shape; cadence aliases, underscore and " limit" suffix; embedded words stay unclassified; window field wins', () => {
    expect(windowsOf(single({ bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remaining: { case: 'remainingFraction', value: 0.5 } }))[0].usedPercent).toBe(50);
    for (const alias of ['session', '5h', '5-hour', 'five hour', 'five-hour']) {
      const [w] = windowsOf(single({ bucketId: `gemini-${alias}`, displayName: alias, remaining: { remainingFraction: 0.75 } }));
      expect(w).toMatchObject({ id: `${QUOTA_SUMMARY_PREFIX}gemini-${alias}`, title: 'Gemini 5-hour', windowMinutes: 300, usedPercent: 25 });
    }
    expect(windowsOf(single({ bucketId: 'gemini_session', displayName: 'Gemini', remaining: { remainingFraction: 0.75 } }))[0])
      .toMatchObject({ id: 'antigravity-quota-summary-gemini_session', windowMinutes: 300 });
    expect(windowsOf(single({ bucketId: 'gemini-5h limit', displayName: 'Gemini quota', remaining: { remainingFraction: 0.75 } }))[0])
      .toMatchObject({ id: 'antigravity-quota-summary-gemini-5h limit', windowMinutes: 300 });
    expect(windowsOf(single({ bucketId: 'gemini-session-history', displayName: 'Session History', remaining: { remainingFraction: 0.75 } }))[0])
      .toMatchObject({ title: 'Gemini Session History', windowMinutes: null });
    expect(windowsOf(single({ bucketId: 'gemini-5h', displayName: 'x', window: 'weekly', remaining: { remainingFraction: 1 } }))[0])
      .toMatchObject({ windowMinutes: 10080 });
    // A disabled bucket or one with no fraction is not known usage.
    expect(windowsOf(QUOTA_SUMMARY_NO_KNOWN).map((x: { usageKnown: boolean }) => x.usageKnown)).toEqual([false, false]);
  });

  it('typed parse failures: a non-OK code, no payload, no groups', () => {
    expect(() => parseQuotaSummaryResponse({ code: 16 })).toThrow(expect.objectContaining({ reason: 'probe:api-error' }));
    expect(() => parseQuotaSummaryResponse({ code: 'OK' })).toThrow(expect.objectContaining({ reason: 'parse:missing-quota-summary' }));
    expect(() => parseQuotaSummaryResponse({ response: { groups: [{ buckets: [] }] } })).toThrow(expect.objectContaining({ reason: 'parse:missing-quota-groups' }));
  });

  it('every gemini limitId in provider-plans.full-roster.json is produced by the reading', () => {
    const plans = JSON.parse(readFileSync(join(__dirname, '..', 'dispatcher', 'provider-plans.full-roster.json'), 'utf8'));
    const ids = plans.providers?.gemini?.limitIds ?? plans.gemini?.limitIds;
    expect(ids).toEqual(['antigravity-quota-summary-gemini-5h', 'antigravity-quota-summary-gemini-weekly', ARGON]);
    const { reading } = mapAntigravityUsage(parseQuotaSummaryResponse(JSON.parse(quotaSummaryJSON({ argon: 0.56 }))), { nowMs: 0, strategy: 'antigravity.app-local' });
    const got = reading.windows.map((w: { limitId: string }) => w.limitId);
    for (const id of ids) expect(got).toContain(id);
  });
});

describe('N5 fetchSnapshot (L1578-1642) + snapshot selection', () => {
  const endpoint = ep('https', 64440, CSRF_APP, 'language-server');

  it('prefers the quota summary and merges identity from GetUserStatus; identity failure keeps the summary', async () => {
    const paths: string[] = [];
    const snap = await fetchSnapshot({ endpoints: [endpoint], timeoutMs: 1000, send: async (p: { path: string }) => { paths.push(p.path); return p.path === US ? USER_STATUS : quotaSummaryJSON(); } });
    expect(paths).toEqual([QS, US]);
    expect(snap).toMatchObject({ accountEmail: EMAIL, accountPlan: 'Pro' });
    expect(quotaSummaryWindows(snap.quotaSummary)).toHaveLength(4);
    const noId = await fetchSnapshot({ endpoints: [endpoint], timeoutMs: 1000, send: async (p: { path: string }) => (p.path === US ? '{"code":16}' : quotaSummaryJSON()) });
    expect(noId.accountEmail).toBeNull();
  });

  it('deadline: the summary gets half the remaining budget, identity at most 1 s; an api-error payload retries the next endpoint', async () => {
    let t = 0;
    const seen: [string, number][] = [];
    await fetchSnapshot({ endpoints: [endpoint], timeoutMs: 8000, deadline: 6000, now: () => t,
      send: async (p: { path: string }, _e: unknown, ms: number) => { seen.push([p.path, ms]); t += 200; return p.path === US ? USER_STATUS : quotaSummaryJSON(); } });
    expect(seen).toEqual([[QS, 3000], [US, 1000]]);
    const second = ep('http', 64432, CSRF_EXT, 'extension-server');
    const tried: unknown[] = [];
    await fetchSnapshot({ endpoints: [endpoint, second], timeoutMs: 1000,
      send: async (p: { path: string }, e: { csrfToken: string }) => { tried.push([p.path, e.csrfToken]); return e.csrfToken === CSRF_APP && p.path === QS ? '{"code":16}' : p.path === US ? USER_STATUS : quotaSummaryJSON(); } });
    expect(tried.slice(0, 2)).toEqual([[QS, CSRF_APP], [QS, CSRF_EXT]]);
  });

  it('a summary with no known bucket stops at compact-fallback:not-yet-ported (the model-quota tiers are N6)', async () => {
    const paths: string[] = [];
    await expect(fetchSnapshot({ endpoints: [endpoint], timeoutMs: 1000, send: async (p: { path: string }) => { paths.push(p.path); return QUOTA_SUMMARY_NO_KNOWN; } }))
      .rejects.toMatchObject({ reason: 'compact-fallback:not-yet-ported' });
    expect(paths).toEqual([QS]);
  });

  it('localSnapshotScore / preferredLocalSnapshot: richer summary wins; an expected email narrows the candidates', () => {
    const rich = { ...parseQuotaSummaryResponse(JSON.parse(quotaSummaryJSON())), accountEmail: 'b@example.invalid', accountPlan: null };
    const lean = { ...parseQuotaSummaryResponse(JSON.parse(single({ bucketId: 'gemini-5h', remaining: { remainingFraction: 1 } }))), accountEmail: 'a@example.invalid', accountPlan: 'Pro' };
    expect(localSnapshotScore(rich)).toBe(1000 + 2 * 10 + 4 + 4 * 20 + 2);
    expect(preferredLocalSnapshot([lean, rich], null)).toBe(rich);
    expect(preferredLocalSnapshot([lean, rich], ' A@EXAMPLE.INVALID ')).toBe(lean);
  });
});

describe('N5 strategy chain (AntigravityProviderDescriptor.resolveStrategies L221-260)', () => {
  it('order per source mode; oauth joins auto only with credentials (env key or ~/.codexbar/antigravity/oauth_creds.json)', () => {
    const home = fakeHome();
    const none = { env: {}, homeDir: home };
    expect(resolveAntigravityStrategies({ sourceMode: 'cli', ...none })).toEqual(['antigravity.app-local', 'antigravity.cli-https', 'antigravity.ide-local', 'antigravity.offline']);
    expect(resolveAntigravityStrategies({ sourceMode: 'oauth', ...none })).toEqual(['antigravity.oauth']);
    expect(resolveAntigravityStrategies({ sourceMode: 'auto', ...none })).toEqual(['antigravity.app-local', 'antigravity.cli-https', 'antigravity.ide-local', 'antigravity.offline']);
    const withOAuth = ['antigravity.app-local', 'antigravity.cli-https', 'antigravity.ide-local', 'antigravity.oauth', 'antigravity.offline'];
    expect(resolveAntigravityStrategies({ sourceMode: 'auto', env: { ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: '{}' }, homeDir: home })).toEqual(withOAuth);
    expect(resolveAntigravityStrategies({ sourceMode: 'auto', selectedTokenAccountId: 'acct', ...none })).toEqual(withOAuth);
    mkdirSync(join(home, '.codexbar', 'antigravity'), { recursive: true });
    writeFileSync(join(home, '.codexbar', 'antigravity', 'oauth_creds.json'), '{}');
    expect(resolveAntigravityStrategies({ sourceMode: 'auto', ...none })).toEqual(withOAuth);
    // HOME wins over homeDir (L246-248).
    expect(resolveAntigravityStrategies({ sourceMode: 'auto', env: { HOME: home }, homeDir: fakeHome() })).toEqual(withOAuth);
    expect(resolveAntigravityStrategies({ sourceMode: 'auto', env: { HOME: fakeHome() }, homeDir: home })).toEqual(['antigravity.app-local', 'antigravity.cli-https', 'antigravity.ide-local', 'antigravity.offline']);
    expect(resolveAntigravityStrategies({ sourceMode: 'web', ...none })).toEqual([]);
    expect(resolveAntigravityStrategies({ sourceMode: 'api', ...none })).toEqual([]);
    // The real home is never probed in a test process.
    expect(hasSharedOAuthCredentials({ env: {}, homeDir: homedir() })).toBe(false);
  });

  it('resolveFallbackError: a later not-running / missing-csrf never hides an earlier real error', () => {
    const e = (r: string) => new AntigravityNativeError(r);
    expect(resolveFallbackError(null, e('probe:not-running')).reason).toBe('probe:not-running');
    expect(resolveFallbackError(e('probe:not-running'), e('probe:missing-csrf-token')).reason).toBe('probe:missing-csrf-token');
    expect(resolveFallbackError(e('probe:http-500'), e('probe:not-running')).reason).toBe('probe:http-500');
    expect(resolveFallbackError(e('probe:http-500'), e('parse:missing-quota-groups')).reason).toBe('parse:missing-quota-groups');
  });

  function liveRoute() {
    return transportFor(req => {
      const p = pathOf(req.url);
      if (p === UNLEASH) return { status: 200, body: '{}' };
      if (p === US) return { status: 200, body: USER_STATUS };
      return { status: 200, body: quotaSummaryJSON({ argon: 0.56 }) };
    });
  }

  it('auto: the app strategy reads the summary over loopback; identity is beside the reading; no secret anywhere', async () => {
    const { runner, calls } = runnerFor(PS_LISTING, { 202: { stdout: LSOF_202 } });
    const { transport, requests } = liveRoute();
    const logs: unknown[] = [];
    const out = await readAntigravityNativeUsage({ sourceMode: 'auto', env: {}, homeDir: fakeHome(), runner, lsofPath: '/usr/sbin/lsof', transport, now: () => Date.parse('2026-06-15T10:00:00Z'), log: (l: unknown) => logs.push(l) });
    expect(out.reading).toMatchObject({ status: 'ok', source: ANTIGRAVITY_NATIVE_SOURCE, strategy: 'antigravity.app-local', dataConfidence: 'exact', updatedAt: '2026-06-15T10:00:00.000Z' });
    expect(out.reading.windows.find((w: { limitId: string }) => w.limitId === ARGON)).toMatchObject({ windowDurationMins: 10080, resetsAt: '2026-06-21T00:00:00.000Z' });
    expect(out.reading.windows.find((w: { limitId: string }) => w.limitId === 'antigravity-quota-summary-gemini-5h')).toMatchObject({ windowDurationMins: 300 });
    expect(out.identity).toEqual({ email: EMAIL, plan: 'Pro' });
    expect(out.attempts).toEqual([{ strategy: 'antigravity.app-local', available: true, reason: null }]);
    expect(requests.every(r => new URL(r.url).hostname === '127.0.0.1')).toBe(true);
    expect(requests.map(r => pathOf(r.url))).toEqual([UNLEASH, QS, US]);
    expect(calls.map(c => c.binary)).toEqual(['/bin/ps', '/usr/sbin/lsof']);
    assertNoSecrets([out.reading, out.attempts, logs]);
  });

  it('auto: app not running ⇒ cli not yet ported (skipped) ⇒ ide wins', async () => {
    const listing = [CLI_LINE, IDE_LINE].join('\n');
    const { runner } = runnerFor(listing, { 303: { stdout: LSOF_303 } });
    const { transport } = liveRoute();
    const out = await readAntigravityNativeUsage({ sourceMode: 'auto', env: {}, homeDir: fakeHome(), runner, lsofPath: '/usr/sbin/lsof', transport });
    expect(out.reading).toMatchObject({ status: 'ok', strategy: 'antigravity.ide-local' });
    expect(out.attempts).toEqual([
      { strategy: 'antigravity.app-local', available: true, reason: 'probe:not-running' },
      { strategy: 'antigravity.cli-https', available: false, reason: 'not-yet-ported' },
      { strategy: 'antigravity.ide-local', available: true, reason: null },
    ]);
  });

  it('nothing usable: the surfaced reason follows resolveFallbackError; oauth mode is not yet ported', async () => {
    const tokenlessIde = '  303 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --app_data_dir antigravity-ide';
    const { runner } = runnerFor(tokenlessIde, {});
    const { transport } = liveRoute();
    const logs: unknown[] = [];
    const out = await readAntigravityNativeUsage({ sourceMode: 'cli', env: {}, homeDir: fakeHome(), runner, lsofPath: '/usr/sbin/lsof', transport, log: (l: unknown) => logs.push(l) });
    expect(out.reading).toEqual({ status: 'unavailable', source: ANTIGRAVITY_NATIVE_SOURCE, reason: 'probe:missing-csrf-token', windows: [] });
    expect(out.identity).toBeNull();
    const oauth = await readAntigravityNativeUsage({ sourceMode: 'oauth', env: {}, homeDir: fakeHome(), runner, transport });
    expect(oauth.reading).toMatchObject({ status: 'unavailable', reason: 'not-yet-ported' });
    expect(transport).not.toHaveBeenCalled();
    assertNoSecrets(logs);
  });

  it('a 401 that echoes the CSRF token: typed reason, token absent from the reading, attempts and logs', async () => {
    const { runner } = runnerFor(APP_LINE, { 202: { stdout: LSOF_202 } });
    const { transport } = transportFor(req => ({ status: 401, body: `token ${req.headers['X-Codeium-Csrf-Token']} rejected` }));
    const logs: unknown[] = [];
    const out = await readAntigravityNativeUsage({ sourceMode: 'cli', env: {}, homeDir: fakeHome(), runner, lsofPath: '/usr/sbin/lsof', transport, log: (l: unknown) => logs.push(l) });
    expect(out.reading).toMatchObject({ status: 'unavailable', reason: 'probe:http-401' });
    assertNoSecrets([out, logs]);
  });

  it('unknown lanes are dropped from the reading and lower dataConfidence; a bad mode is a typed config error', async () => {
    const summary = parseQuotaSummaryResponse(JSON.parse(JSON.stringify({ groups: [{ displayName: 'Gemini Models', buckets: [
      { bucketId: 'gemini-5h', remaining: { remainingFraction: 0.5 } }, { bucketId: 'gemini-weekly', disabled: true, remaining: { remainingFraction: 0.1 } }] }] })));
    const { reading } = mapAntigravityUsage(summary, { nowMs: 0, strategy: 'antigravity.app-local' });
    expect(reading.windows.map((w: { limitId: string }) => w.limitId)).toEqual(['antigravity-quota-summary-gemini-5h']);
    expect(reading.dataConfidence).toBe('unknown');
    const bad = await readAntigravityNativeUsage({ sourceMode: 'nope', env: {}, homeDir: fakeHome(), runner: vi.fn(), transport: vi.fn() });
    expect(bad.reading).toMatchObject({ status: 'unavailable', reason: 'config:unknown-source-mode' });
  });
});

describe('N5 review pins (u3-n5 mutation table)', () => {
  it('the loopback guard accepts localhost (LocalhostTrustPolicy L16): it reaches the test-process refusal, not non-loopback', async () => {
    await expect(defaultAntigravityTransport({ url: 'https://localhost:64440/x', method: 'POST', headers: {}, body: '{}', timeoutMs: 100 }))
      .rejects.toMatchObject({ reason: 'probe:refused-in-test-process' });
  });

  it('a session alias beats weekly when one bucket carries both (quotaBucketKind L356-365 checks session first)', () => {
    const [w] = windowsOf(single({ bucketId: 'gemini-weekly', displayName: 'Five Hour Limit', remaining: { remainingFraction: 0.5 } }));
    expect(w).toMatchObject({ windowMinutes: 300, title: 'Gemini 5-hour' });
  });

  it('a transport that throws a plain error is probe:network-error, with no token in the reason or message', async () => {
    const transport = async () => { throw new Error(`socket closed for ${CSRF_APP}`); };
    const err = await sendAntigravityRequest({ path: QS, body: {} }, ep('https', 64440, CSRF_APP, 'language-server'), 2000, { transport }).catch((e: Error) => e);
    expect(err).toMatchObject({ reason: 'probe:network-error' });
    assertNoSecrets(`${err.message} ${err.reason}`);
  });

  it('the redactor scrubs a token that an injected transport puts into a typed reason', async () => {
    const { runner } = runnerFor(APP_LINE, { 202: { stdout: LSOF_202 } });
    const transport = async () => { throw new AntigravityNativeError(`probe:echo-${CSRF_APP}`); };
    const logs: unknown[] = [];
    const out = await readAntigravityNativeUsage({ sourceMode: 'cli', env: {}, homeDir: fakeHome(), runner, lsofPath: '/usr/sbin/lsof', transport, log: (l: unknown) => logs.push(l) });
    expect(out.reading.status).toBe('unavailable');
    expect(out.reading.reason).toContain('<redacted>');
    assertNoSecrets([out, logs]);
  });

  it('web / api modes have no strategy: no-available-strategy, nothing run', async () => {
    const runner = vi.fn();
    const transport = vi.fn();
    for (const sourceMode of ['web', 'api']) {
      const out = await readAntigravityNativeUsage({ sourceMode, env: {}, homeDir: fakeHome(), runner, transport });
      expect(out.reading).toMatchObject({ status: 'unavailable', reason: 'no-available-strategy' });
      expect(out.attempts).toEqual([]);
    }
    expect(runner).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('every process fails: the last failure in process order surfaces (fetchProcessSnapshots L72-90)', async () => {
    const second = `  206 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token ${CSRF_IDE} --app_data_dir antigravity`;
    const { runner } = runnerFor([APP_LINE, second].join('\n'), { 202: { stdout: '', code: 1 }, 206: { stdout: 'l 206 t 1u IPv4 0 0t0 TCP 127.0.0.1:64660 (LISTEN)' } });
    const { transport } = transportFor(() => ({ status: 401, body: '' }));
    const out = await readAntigravityNativeUsage({ sourceMode: 'cli', env: {}, homeDir: fakeHome(), runner, lsofPath: '/usr/sbin/lsof', transport });
    expect(out.attempts[0]).toEqual({ strategy: 'antigravity.app-local', available: true, reason: 'probe:http-401' });
    expect(out.reading).toMatchObject({ status: 'unavailable', reason: 'probe:http-401' });
  });

  it('preferredLocalSnapshot keeps the first snapshot on an equal score (strict >, Selection L21-27)', () => {
    const a = { ...parseQuotaSummaryResponse(JSON.parse(quotaSummaryJSON())), accountEmail: null, accountPlan: null };
    const b = { ...parseQuotaSummaryResponse(JSON.parse(quotaSummaryJSON())), accountEmail: null, accountPlan: null };
    expect(localSnapshotScore(a)).toBe(localSnapshotScore(b));
    expect(preferredLocalSnapshot([a, b], null)).toBe(a);
  });

  it('the oauth credentials file under the (mocked) real home is never read in a test process', async () => {
    const fake = fakeHome();
    mkdirSync(join(fake, '.codexbar', 'antigravity'), { recursive: true });
    writeFileSync(join(fake, '.codexbar', 'antigravity', 'oauth_creds.json'), '{}');
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal: () => Promise<Record<string, unknown>>) => ({ ...(await importOriginal()), homedir: () => fake }));
    try {
      // @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
      const mod = await import('../dispatcher/usage-readers/natives/antigravity.mjs');
      expect(mod.hasSharedOAuthCredentials({ env: {}, homeDir: fake })).toBe(false);
      expect(mod.hasSharedOAuthCredentials({ env: { HOME: fake }, homeDir: fakeHome() })).toBe(false);
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
    }
  });
});
