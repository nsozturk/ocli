import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_NATIVE_SOURCE, CODEX_OAUTH_CLIENT_ID, CODEX_REFRESH_ENDPOINT, CodexNativeError,
  codexAuthFilePath, parseCodexCredentials, credentialsNeedRefresh, loadCodexCredentials,
  resolveCodexUsageURL, decodeCodexUsageResponse, mapCodexUsage, fetchCodexOAuthUsage,
  refreshCodexToken, saveCodexCredentials, resolveCodexStrategies, oauthShouldFallback, readCodexNativeUsage,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/natives/codex.mjs';

// Every HTTP call goes to a stub transport, every auth.json lives in a temp dir, and `readCodexUsage` /
// `resolveCodexBinary` are stubs: no network, no real ~/.codex or CODEX_HOME, no real codex binary.

type Req = { url: string; method: string; headers: Record<string, string>; body?: string };
type Res = { status: number; body: string };
function transportFor(routes: Record<string, Res | ((req: Req) => Res)>) {
  const requests: Req[] = [];
  const transport = vi.fn(async (req: Req) => {
    requests.push(req);
    const route = routes[req.url];
    if (!route) throw new Error(`unrouted ${req.method} ${req.url}`);
    const res = typeof route === 'function' ? route(req) : route;
    return { status: res.status, headers: {}, body: Buffer.from(res.body) };
  });
  return { transport, requests };
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'none' })}.${b64url(payload)}.c2ln`;

const NOW = Date.parse('2026-10-18T12:00:00Z');
const NOW_S = NOW / 1000;
const EMAIL = 'person-7c1@example.invalid';
const ACCOUNT = 'acct-5f3e9a-ws';
const ACCESS = jwt({ exp: NOW_S + 3600, sub: 'access-tok-SECRET-a1' });
const STALE_ACCESS = jwt({ exp: NOW_S + 60, sub: 'access-tok-SECRET-stale' });
const REFRESH = 'refresh-tok-SECRET-b2';
const ID_TOKEN = jwt({ email: EMAIL, 'https://api.openai.com/auth': { chatgpt_plan_type: 'enterprise', chatgpt_account_id: ACCOUNT } });
const PAT = 'pat-tok-SECRET-c3';
const SECRETS = [ACCESS, STALE_ACCESS, REFRESH, ID_TOKEN, PAT, 'access-tok-SECRET', 'refresh-tok-SECRET', 'pat-tok-SECRET'];

const WHAM = 'https://chatgpt.com/backend-api/wham/usage';
const WHOAMI = 'https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami';

const usageFixture = {
  account_id: ACCOUNT,
  plan_type: 'enterprise',
  rate_limit: {
    primary_window: { used_percent: 23, reset_at: NOW_S + 3600, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 61, reset_at: NOW_S + 86400, limit_window_seconds: 604800 },
    // `resets_at` spelling (SpendControlLimitSnapshot accepts resetsAt / resets_at / reset_at).
    individual_limit: { limit: 200, used: 50, resets_at: NOW_S + 7 * 86400 },
  },
  credits: { has_credits: true, unlimited: false, balance: '12.5' },
  additional_rate_limits: [
    { limit_name: 'GPT-5.3-Codex-Spark', rate_limit: {
      primary_window: { used_percent: 4, reset_at: NOW_S + 1000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 9, reset_at: NOW_S + 9000, limit_window_seconds: 604800 } } },
    { metered_feature: 'Image Gen!', rate_limit: { secondary_window: { used_percent: 2, reset_at: 0, limit_window_seconds: 0 } } },
  ],
};

let dirs: string[] = [];
function codexHome(auth: unknown, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'n1-codex-home-'));
  dirs.push(dir);
  if (auth !== undefined) writeFileSync(join(dir, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth, null, 2));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}
function fakeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'n1-home-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

const oauthAuth = (access = ACCESS, more: Record<string, unknown> = {}) => ({
  auth_mode: 'chatgpt', custom_field: { keep: true },
  tokens: { access_token: access, refresh_token: REFRESH, id_token: ID_TOKEN, account_id: ACCOUNT },
  last_refresh: '2026-10-18T11:00:00Z', ...more,
});

function cliStub(windows = [{ limitId: 'codex', model: null, usedPercent: 7, windowDurationMins: 300, resetsAt: '2026-10-18T15:00:00.000Z' }]) {
  return vi.fn(async () => ({ status: 'ok', ordinaryUsageAllowed: true, windows }));
}
const noSleep = vi.fn(async () => {});

function baseOpts(home: string, extra: Record<string, unknown> = {}) {
  return { env: { CODEX_HOME: home }, homeDir: fakeHome(), now: () => NOW, sleep: noSleep,
    resolveCodexBinary: () => '/stub/bin/codex', readCodexUsage: cliStub(), ...extra };
}
const assertNoSecrets = (text: string) => { for (const s of SECRETS) expect(text).not.toContain(s); };

describe('N1 credentials — auth.json resolution and parsing (CodexOAuthCredentials.swift)', () => {
  it('CODEX_HOME (trimmed, non-empty) scopes auth.json; otherwise <home>/.codex/auth.json', () => {
    expect(codexAuthFilePath({ env: { CODEX_HOME: '  /x/scoped  ' }, homeDir: '/h' })).toBe('/x/scoped/auth.json');
    expect(codexAuthFilePath({ env: { CODEX_HOME: '   ' }, homeDir: '/h' })).toBe('/h/.codex/auth.json');
    expect(codexAuthFilePath({ env: {}, homeDir: '/h' })).toBe('/h/.codex/auth.json');
  });

  it('parses snake and camel tokens, recovers the account id from the JWT, reads exp only for the native home', () => {
    const access = jwt({ exp: NOW_S + 999, chatgpt_account_id: 'from-jwt' });
    const c = parseCodexCredentials(JSON.stringify({ tokens: { accessToken: access, refreshToken: 'r' } }));
    expect(c).toMatchObject({ accessToken: access, refreshToken: 'r', accountId: 'from-jwt', source: 'codexHome', isAPIKey: false });
    expect(c.expiresAt).toBe((NOW_S + 999) * 1000);
    expect(parseCodexCredentials(JSON.stringify({ tokens: { access_token: access, refresh_token: 'r' } }), { source: 'legacyCodexHome' }).expiresAt).toBeNull();
    const api = parseCodexCredentials(JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: { access_token: 'a', refresh_token: 'r' } }));
    expect(api).toMatchObject({ accessToken: 'sk-x', isAPIKey: true, refreshToken: '' });
  });

  it('typed credential failures: not-found, decode-failed, missing-tokens (an empty refresh token is missing)', () => {
    const missing = () => loadCodexCredentials({ env: { CODEX_HOME: join(tmpdir(), 'n1-does-not-exist-9z') }, homeDir: fakeHome() });
    expect(missing).toThrow(expect.objectContaining({ reason: 'credentials:not-found' }));
    expect(() => parseCodexCredentials('{nope')).toThrow(expect.objectContaining({ reason: 'credentials:decode-failed' }));
    expect(() => parseCodexCredentials('[1]')).toThrow(expect.objectContaining({ reason: 'credentials:decode-failed' }));
    expect(() => parseCodexCredentials(JSON.stringify({ tokens: { access_token: 'a', refresh_token: '' } })))
      .toThrow(expect.objectContaining({ reason: 'credentials:missing-tokens' }));
  });

  it('needsRefresh: 5-minute window on exp for the native home, else 8 days since last_refresh; API keys never', () => {
    const base = { refreshToken: 'r', idToken: null, accountId: null, source: 'codexHome', isAPIKey: false, lastRefresh: null };
    expect(credentialsNeedRefresh({ ...base, expiresAt: NOW + 4 * 60_000 }, NOW)).toBe(true);
    expect(credentialsNeedRefresh({ ...base, expiresAt: NOW + 6 * 60_000 }, NOW)).toBe(false);
    expect(credentialsNeedRefresh({ ...base, source: 'openCode', expiresAt: NOW + 2 * 60_000 }, NOW)).toBe(false);
    expect(credentialsNeedRefresh({ ...base, expiresAt: null, lastRefresh: NOW - 9 * 86_400_000 }, NOW)).toBe(true);
    expect(credentialsNeedRefresh({ ...base, expiresAt: null, lastRefresh: NOW - 86_400_000 }, NOW)).toBe(false);
    expect(credentialsNeedRefresh({ ...base, expiresAt: null }, NOW)).toBe(true);
    expect(credentialsNeedRefresh({ ...base, isAPIKey: true, expiresAt: null }, NOW)).toBe(false);
  });

  it('external sources only on opt-in, only when the native file is missing and CODEX_HOME is unset', () => {
    const home = fakeHome();
    mkdirSync(join(home, '.config', 'codex'), { recursive: true });
    writeFileSync(join(home, '.config', 'codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'legacy-a', refresh_token: 'legacy-r' } }));
    expect(() => loadCodexCredentials({ env: {}, homeDir: home })).toThrow(expect.objectContaining({ reason: 'credentials:not-found' }));
    expect(loadCodexCredentials({ env: {}, homeDir: home, allowExternalSources: true })).toMatchObject({ accessToken: 'legacy-a', source: 'legacyCodexHome' });
    const scoped = join(tmpdir(), 'n1-missing-scoped-home-8q');
    expect(() => loadCodexCredentials({ env: { CODEX_HOME: scoped }, homeDir: home, allowExternalSources: true }))
      .toThrow(expect.objectContaining({ reason: 'credentials:not-found' }));
  });
});

describe('N1 OAuth usage — /wham/usage and /api/codex/usage (CodexOAuthUsageFetcher.swift)', () => {
  it('/wham/usage: headers, 5h/weekly windows under limitId codex, Spark + named extras, credits (resets_at)', async () => {
    const { transport, requests } = transportFor({ [WHAM]: { status: 200, body: JSON.stringify(usageFixture) } });
    const home = codexHome(oauthAuth());
    const out = await readCodexNativeUsage({ ...baseOpts(home), transport, sourceMode: 'oauth' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: WHAM, method: 'GET' });
    expect(requests[0].headers).toMatchObject({ Authorization: `Bearer ${ACCESS}`, 'User-Agent': 'CodexBar', Accept: 'application/json', 'ChatGPT-Account-Id': ACCOUNT });
    expect(out.reading).toMatchObject({ status: 'ok', source: CODEX_NATIVE_SOURCE, strategy: 'codex.oauth', dataConfidence: 'exact' });
    expect(out.reading.windows).toEqual([
      { limitId: 'codex', usedPercent: 23, windowDurationMins: 300, resetsAt: new Date((NOW_S + 3600) * 1000).toISOString() },
      { limitId: 'codex', usedPercent: 61, windowDurationMins: 10080, resetsAt: new Date((NOW_S + 86400) * 1000).toISOString() },
      { limitId: 'codex-spark', usedPercent: 4, windowDurationMins: 300, resetsAt: new Date((NOW_S + 1000) * 1000).toISOString() },
      { limitId: 'codex-spark-weekly', usedPercent: 9, windowDurationMins: 10080, resetsAt: new Date((NOW_S + 9000) * 1000).toISOString() },
      { limitId: 'codex-image-gen', usedPercent: 2, windowDurationMins: null, resetsAt: null },
    ]);
    expect(out.reading.credits).toEqual({ remaining: 12.5, balanceReadSucceeded: true, creditsAvailable: true,
      codexCreditLimit: { used: 50, limit: 200, remainingPercent: 75, resetsAt: new Date((NOW_S + 7 * 86400) * 1000).toISOString() } });
  });

  it('spend_control.individual_limit with the reset_at spelling; root individual_limit with resetsAt', () => {
    const viaSpend = decodeCodexUsageResponse({ spend_control: { individual_limit: { limit: 10, remaining_percent: 40, reset_at: 1_800_000_000 } } });
    expect(viaSpend.spendControlPresent).toBe(true);
    expect(viaSpend.resolvedIndividualLimit).toEqual({ limit: 10, used: null, remainingPercent: 40, resetsAt: 1_800_000_000 });
    const viaRoot = decodeCodexUsageResponse({ individualLimit: { limit: '10', used: 2, resetsAt: '1700000000' } });
    expect(viaRoot.resolvedIndividualLimit).toEqual({ limit: 10, used: 2, remainingPercent: null, resetsAt: 1_700_000_000 });
    const mapped = mapCodexUsage(decodeCodexUsageResponse({ spend_control: { individual_limit: { limit: 10, remaining_percent: 40, reset_at: 1_800_000_000 } } }), { nowMs: NOW });
    expect(mapped.reading.credits.codexCreditLimit).toEqual({ used: 6, limit: 10, remainingPercent: 40, resetsAt: new Date(1_800_000_000_000).toISOString() });
  });

  it('a non-chatgpt chatgpt_base_url in config.toml uses /api/codex/usage; weekly-first windows are reordered', async () => {
    const config = '# comment\nmodel = "x"\nchatgpt_base_url = "https://codex.example.invalid/root/" # trailing\n';
    const home = codexHome(oauthAuth(), { 'config.toml': config });
    const url = 'https://codex.example.invalid/root/api/codex/usage';
    expect(resolveCodexUsageURL({ env: { CODEX_HOME: home }, homeDir: fakeHome() })).toBe(url);
    expect(resolveCodexUsageURL({ env: { CODEX_HOME: codexHome(undefined, { 'config.toml': "chatgpt_base_url = 'https://chatgpt.com'" }) }, homeDir: fakeHome() }))
      .toBe(WHAM);
    expect(resolveCodexUsageURL({ env: { CODEX_HOME: codexHome(undefined) }, homeDir: fakeHome() })).toBe(WHAM);
    const body = { rate_limit: {
      primary_window: { used_percent: 30, reset_at: NOW_S + 5000, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 10, reset_at: NOW_S + 50, limit_window_seconds: 18000 } } };
    const { transport } = transportFor({ [url]: { status: 200, body: JSON.stringify(body) } });
    const out = await readCodexNativeUsage({ ...baseOpts(home), transport, sourceMode: 'oauth' });
    expect(out.reading.windows.map((w: { windowDurationMins: number }) => w.windowDurationMins)).toEqual([300, 10080]);
    expect(out.reading.windows.map((w: { usedPercent: number }) => w.usedPercent)).toEqual([10, 30]);
  });

  it('a malformed window is dropped and the reading says dataConfidence unknown', () => {
    const r = decodeCodexUsageResponse({ rate_limit: { primary_window: { used_percent: 'x' }, secondary_window: { used_percent: 5, reset_at: 1, limit_window_seconds: 604800 } } });
    const { reading } = mapCodexUsage(r, { nowMs: NOW });
    expect(reading.dataConfidence).toBe('unknown');
    expect(reading.windows).toEqual([{ limitId: 'codex', usedPercent: 5, windowDurationMins: 10080, resetsAt: new Date(1000).toISOString() }]);
  });

  it('identity (email / plan / account) comes back separately and never inside the reading', async () => {
    const { transport } = transportFor({ [WHAM]: { status: 200, body: JSON.stringify(usageFixture) } });
    const out = await readCodexNativeUsage({ ...baseOpts(codexHome(oauthAuth())), transport, sourceMode: 'oauth' });
    expect(out.identity).toEqual({ email: EMAIL, plan: 'enterprise', accountId: ACCOUNT });
    const text = JSON.stringify(out.reading);
    for (const v of [EMAIL, 'enterprise', ACCOUNT]) expect(text).not.toContain(v);
    assertNoSecrets(text);
  });

  it('401 ⇒ oauth:unauthorized; a 5xx body that echoes the token never reaches the reason or the error', async () => {
    const cases: [number, string][] = [[401, 'oauth:unauthorized'], [503, 'oauth:server-error:503']];
    for (const [status, reason] of cases) {
      const { transport } = transportFor({ [WHAM]: { status, body: `bad token ${ACCESS} ${REFRESH}` } });
      const err = await fetchCodexOAuthUsage({ accessToken: ACCESS, accountId: null, url: WHAM, transport }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodexNativeError);
      expect((err as CodexNativeError).reason).toBe(reason);
      assertNoSecrets(String((err as Error).message) + JSON.stringify(err));
    }
    const { transport } = transportFor({ [WHAM]: { status: 200, body: 'not json' } });
    await expect(fetchCodexOAuthUsage({ accessToken: ACCESS, accountId: null, url: WHAM, transport })).rejects.toMatchObject({ reason: 'oauth:invalid-response' });
    const thrower = vi.fn(async () => { throw new Error(`socket closed for ${ACCESS}`); });
    const net = await fetchCodexOAuthUsage({ accessToken: ACCESS, accountId: null, url: WHAM, transport: thrower }).catch((e: unknown) => e);
    expect((net as CodexNativeError).reason).toBe('oauth:network-error');
    assertNoSecrets(String((net as Error).message));
  });
});

describe('N1 strategy chain (CodexProviderDescriptor.resolveStrategies L151-173)', () => {
  it('resolves strategies per source mode exactly as CodexBar', () => {
    expect(resolveCodexStrategies({ sourceMode: 'auto' })).toEqual(['codex.pat', 'codex.oauth', 'codex.cli']);
    expect(resolveCodexStrategies({ sourceMode: 'auto', workspaceId: 'ws-1' })).toEqual(['codex.pat', 'codex.oauth']);
    expect(resolveCodexStrategies({ sourceMode: 'oauth' })).toEqual(['codex.oauth', 'codex.oauth-native-refresh-cli']);
    expect(resolveCodexStrategies({ sourceMode: 'cli' })).toEqual(['codex.cli']);
    expect(resolveCodexStrategies({ sourceMode: 'api' })).toEqual(['codex.pat']);
    expect(resolveCodexStrategies({ sourceMode: 'web' })).toEqual(['codex.web']);
  });

  it('auto: PAT first — whoami then usage with the codex_cli_rs UA and the whoami account', async () => {
    const whoami = { chatgpt_account_id: 'pat-acct', chatgpt_plan_type: 'pro', email: EMAIL };
    const { transport, requests } = transportFor({
      [WHOAMI]: { status: 200, body: JSON.stringify(whoami) },
      [WHAM]: { status: 200, body: JSON.stringify({ rate_limit: usageFixture.rate_limit }) },
    });
    const home = codexHome({ personal_access_token: PAT, ...oauthAuth() });
    const out = await readCodexNativeUsage({ ...baseOpts(home), transport, cliVersion: 'codex-cli 0.130.0' });
    expect(out.reading).toMatchObject({ status: 'ok', strategy: 'codex.pat' });
    expect(requests.map(r => r.url)).toEqual([WHOAMI, WHAM]);
    expect(requests[1].headers).toMatchObject({ Authorization: `Bearer ${PAT}`, originator: 'codex_cli_rs', 'ChatGPT-Account-Id': 'pat-acct' });
    expect(requests[1].headers['User-Agent']).toMatch(/^codex_cli_rs\/0\.130\.0 \(/);
    expect(out.identity).toEqual({ email: EMAIL, plan: 'pro', accountId: 'pat-acct' });
  });

  it('auto: pat 401 ⇒ oauth 401 ⇒ cli (delegates to readCodexUsage) — first success wins', async () => {
    const { transport, requests } = transportFor({ [WHOAMI]: { status: 401, body: '' }, [WHAM]: { status: 401, body: '' } });
    const readCodexUsage = cliStub();
    const out = await readCodexNativeUsage({ ...baseOpts(codexHome({ personal_access_token: PAT, ...oauthAuth() })), transport, readCodexUsage });
    expect(out.attempts).toEqual([
      { strategy: 'codex.pat', available: true, reason: 'oauth:unauthorized' },
      { strategy: 'codex.oauth', available: true, reason: 'oauth:unauthorized' },
      { strategy: 'codex.cli', available: true, reason: null },
    ]);
    expect(requests.map(r => r.url)).toEqual([WHOAMI, WHAM]);
    expect(readCodexUsage).toHaveBeenCalledTimes(1);
    expect(out.reading).toMatchObject({ status: 'ok', source: CODEX_NATIVE_SOURCE, strategy: 'codex.cli', ordinaryUsageAllowed: true });
    expect(out.reading.windows).toEqual([{ limitId: 'codex', model: null, usedPercent: 7, windowDurationMins: 300, resetsAt: '2026-10-18T15:00:00.000Z' }]);
    expect(out.identity).toBeNull();
  });

  it('auto without a PAT: pat is unavailable (no request), oauth wins', async () => {
    const { transport, requests } = transportFor({ [WHAM]: { status: 200, body: JSON.stringify(usageFixture) } });
    const out = await readCodexNativeUsage({ ...baseOpts(codexHome(oauthAuth())), transport });
    expect(out.attempts).toEqual([
      { strategy: 'codex.pat', available: false, reason: null },
      { strategy: 'codex.oauth', available: true, reason: null },
    ]);
    expect(requests.map(r => r.url)).toEqual([WHAM]);
    expect(out.reading.strategy).toBe('codex.oauth');
  });

  it('auto, expired native token: rereads twice, never redeems the refresh token, never writes, falls to cli', async () => {
    const home = codexHome(oauthAuth(STALE_ACCESS));
    const before = readFileSync(join(home, 'auth.json'));
    const beforeStat = statSync(join(home, 'auth.json'));
    const { transport, requests } = transportFor({});
    const sleep = vi.fn(async () => {});
    const readCodexUsage = cliStub();
    const out = await readCodexNativeUsage({ ...baseOpts(home), transport, sleep, readCodexUsage });
    expect(out.attempts.map((a: { strategy: string; reason: string | null }) => [a.strategy, a.reason])).toEqual([
      ['codex.pat', null], ['codex.oauth', 'credentials:native-refresh-required'], ['codex.cli', null]]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
    expect(requests).toHaveLength(0);
    expect(readCodexUsage).toHaveBeenCalledTimes(1);
    expect(out.reading.status).toBe('ok');
    expect(readFileSync(join(home, 'auth.json')).equals(before)).toBe(true);
    expect(statSync(join(home, 'auth.json')).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(readdirSync(home).sort()).toEqual(['auth.json']);
  });

  it('oauth mode, expired native token: oauth ⇒ native-refresh CLI strategy (delegated refresh), no write', async () => {
    const home = codexHome(oauthAuth(STALE_ACCESS));
    const before = readFileSync(join(home, 'auth.json'));
    const { transport, requests } = transportFor({});
    const readCodexUsage = cliStub();
    const out = await readCodexNativeUsage({ ...baseOpts(home), transport, readCodexUsage, sourceMode: 'oauth' });
    expect(out.attempts.map((a: { strategy: string }) => a.strategy)).toEqual(['codex.oauth', 'codex.oauth-native-refresh-cli']);
    expect(out.reading).toMatchObject({ status: 'ok', strategy: 'codex.oauth-native-refresh-cli' });
    expect(readCodexUsage).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(readFileSync(join(home, 'auth.json')).equals(before)).toBe(true);
  });

  it('oauth mode, fresh token, 401: no fallback — the native-refresh CLI is only for a stale native token', async () => {
    const { transport } = transportFor({ [WHAM]: { status: 401, body: '' } });
    const readCodexUsage = cliStub();
    const out = await readCodexNativeUsage({ ...baseOpts(codexHome(oauthAuth())), transport, readCodexUsage, sourceMode: 'oauth' });
    expect(out.reading).toMatchObject({ status: 'unavailable', source: CODEX_NATIVE_SOURCE, reason: 'oauth:unauthorized', windows: [] });
    expect(out.attempts.map((a: { strategy: string }) => a.strategy)).toEqual(['codex.oauth']);
    expect(readCodexUsage).not.toHaveBeenCalled();
  });

  it('oauth mode: the native-refresh CLI stays unavailable for a fresh token even when oauth was skipped (owner race)', async () => {
    const home = codexHome(oauthAuth());
    let authReads = 0;
    const readFile = (path: string) => {
      if (path.endsWith('auth.json') && ++authReads <= 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return readFileSync(path, 'utf8');
    };
    const readCodexUsage = cliStub();
    const out = await readCodexNativeUsage({ ...baseOpts(home), readFile, transport: transportFor({}).transport, readCodexUsage, sourceMode: 'oauth' });
    expect(out.attempts).toEqual([
      { strategy: 'codex.oauth', available: false, reason: null },
      { strategy: 'codex.oauth-native-refresh-cli', available: false, reason: null },
    ]);
    expect(out.reading.reason).toBe('no-available-strategy');
    expect(readCodexUsage).not.toHaveBeenCalled();
  });

  it('auto with a managed workspace: [pat, oauth] only, workspace account header, cli never spawned', async () => {
    const { transport, requests } = transportFor({ [WHAM]: { status: 401, body: '' } });
    const readCodexUsage = cliStub();
    const out = await readCodexNativeUsage({ ...baseOpts(codexHome(oauthAuth())), transport, readCodexUsage, workspaceId: 'ws-managed-1' });
    expect(requests[0].headers['ChatGPT-Account-Id']).toBe('ws-managed-1');
    expect(out.attempts.map((a: { strategy: string }) => a.strategy)).toEqual(['codex.pat', 'codex.oauth']);
    expect(out.reading.reason).toBe('oauth:unauthorized');
    expect(readCodexUsage).not.toHaveBeenCalled();
  });

  it('a decode-failed auth.json makes oauth unavailable (L383-385): auto falls to cli, oauth mode has no strategy', async () => {
    const readCodexUsage = cliStub();
    const sleep = vi.fn(async () => {});
    const auto = await readCodexNativeUsage({ ...baseOpts(codexHome('{broken')), sleep, transport: transportFor({}).transport, readCodexUsage });
    expect(auto.attempts).toEqual([
      { strategy: 'codex.pat', available: false, reason: null },
      { strategy: 'codex.oauth', available: false, reason: null },
      { strategy: 'codex.cli', available: true, reason: null },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2); // loadCredentials rereads a failing load twice even when not retrying stale
    const oauth = await readCodexNativeUsage({ ...baseOpts(codexHome('{broken')), transport: transportFor({}).transport, readCodexUsage, sourceMode: 'oauth' });
    expect(oauth.reading.reason).toBe('no-available-strategy');
    expect(readCodexUsage).toHaveBeenCalledTimes(1);
  });

  it('cli strategy: unavailable without a binary; typed reasons for an unavailable or empty app-server reading', async () => {
    const home = codexHome(undefined);
    const none = await readCodexNativeUsage({ ...baseOpts(home), sourceMode: 'cli', resolveCodexBinary: () => null, transport: transportFor({}).transport });
    expect(none.reading.reason).toBe('no-available-strategy');
    expect(none.attempts).toEqual([{ strategy: 'codex.cli', available: false, reason: null }]);
    const down = await readCodexNativeUsage({ ...baseOpts(home), sourceMode: 'cli', transport: transportFor({}).transport,
      readCodexUsage: vi.fn(async () => ({ status: 'unavailable', reason: `initialize failed: ${ACCESS}`, windows: [] })) });
    expect(down.reading.reason).toBe('cli:unavailable');
    assertNoSecrets(JSON.stringify(down));
    const empty = await readCodexNativeUsage({ ...baseOpts(home), sourceMode: 'cli', transport: transportFor({}).transport, readCodexUsage: cliStub([]) });
    expect(empty.reading.reason).toBe('usage:no-rate-limits');
    const web = await readCodexNativeUsage({ ...baseOpts(home), sourceMode: 'web', transport: transportFor({}).transport });
    expect(web.reading.reason).toBe('web:not-ported');
  });

  it('oauthShouldFallback mirrors CodexOAuthFetchStrategy.shouldFallback', () => {
    const e = (reason: string) => new CodexNativeError(reason);
    for (const r of ['refresh:expired', 'refresh:revoked', 'refresh:reused', 'oauth:unauthorized', 'credentials:not-found',
      'credentials:unreadable', 'credentials:missing-tokens', 'credentials:native-refresh-required']) {
      expect(oauthShouldFallback(e(r), { sourceMode: 'auto' })).toBe(true);
    }
    for (const r of ['refresh:network-error', 'refresh:invalid-response', 'oauth:server-error:500', 'oauth:network-error',
      'oauth:invalid-response', 'credentials:decode-failed', 'credentials:read-only-source', 'usage:no-rate-limits']) {
      expect(oauthShouldFallback(e(r), { sourceMode: 'auto' })).toBe(false);
    }
    expect(oauthShouldFallback(e('credentials:native-refresh-required'), { sourceMode: 'oauth' })).toBe(true);
    expect(oauthShouldFallback(e('refresh:expired'), { sourceMode: 'oauth' })).toBe(false);
    expect(oauthShouldFallback(e('oauth:unauthorized'), { sourceMode: 'cli' })).toBe(false);
  });

  it('tokens never reach the log, a reason or an attempt across failing chains', async () => {
    const logs: unknown[] = [];
    const log = (entry: unknown) => { logs.push(entry); };
    const { transport } = transportFor({ [WHOAMI]: { status: 500, body: `echo ${PAT}` } });
    const a = await readCodexNativeUsage({ ...baseOpts(codexHome({ personal_access_token: PAT, ...oauthAuth() })), transport, log });
    const { transport: t2 } = transportFor({ [WHAM]: { status: 502, body: `echo ${ACCESS} ${REFRESH} ${ID_TOKEN}` } });
    const b = await readCodexNativeUsage({ ...baseOpts(codexHome(oauthAuth())), transport: t2, log, sourceMode: 'oauth' });
    expect(a.reading.reason).toBe('oauth:server-error:500');
    expect(b.reading.reason).toBe('oauth:server-error:502');
    expect(logs.length).toBeGreaterThan(0);
    assertNoSecrets(JSON.stringify([logs, a, b]));
  });
});

describe('N1 refresh + write-back (CodexTokenRefresher.swift, CodexOAuthCredentialsStore.save L324-363)', () => {
  const creds = (over: Record<string, unknown> = {}) => ({ accessToken: STALE_ACCESS, refreshToken: REFRESH, idToken: ID_TOKEN,
    accountId: ACCOUNT, lastRefresh: NOW - 9 * 86_400_000, expiresAt: null, source: 'codexHome', isAPIKey: false, ...over });

  it('POSTs CodexBar\'s exact body to auth.openai.com/oauth/token and keeps what the response omits', async () => {
    const newAccess = jwt({ exp: NOW_S + 7200, sub: 'access-tok-SECRET-new' });
    const { transport, requests } = transportFor({ [CODEX_REFRESH_ENDPOINT]: { status: 200, body: JSON.stringify({ access_token: newAccess }) } });
    const out = await refreshCodexToken(creds(), { transport, now: () => NOW });
    expect(CODEX_REFRESH_ENDPOINT).toBe('https://auth.openai.com/oauth/token');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(requests[0].body!)).toEqual({ client_id: CODEX_OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: REFRESH, scope: 'openid profile email' });
    expect(CODEX_OAUTH_CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(out).toMatchObject({ accessToken: newAccess, refreshToken: REFRESH, idToken: ID_TOKEN, accountId: ACCOUNT, lastRefresh: NOW, source: 'codexHome' });
    const unchanged = await refreshCodexToken(creds({ refreshToken: '' }), { transport, now: () => NOW });
    expect(unchanged.accessToken).toBe(STALE_ACCESS);
    expect(requests).toHaveLength(1);
  });

  it('maps refresh failures to typed reasons with no token in them', async () => {
    const cases: [number, string, string][] = [
      [400, JSON.stringify({ error: { code: 'refresh_token_expired' } }), 'refresh:expired'],
      [400, JSON.stringify({ error: 'refresh_token_reused' }), 'refresh:reused'],
      [400, JSON.stringify({ code: 'invalid_grant' }), 'refresh:revoked'],
      [400, JSON.stringify({ error: 'refresh_token_invalidated' }), 'refresh:revoked'],
      [401, `nope ${REFRESH}`, 'refresh:expired'],
      [500, `nope ${REFRESH}`, 'refresh:invalid-response'],
      [200, 'not json', 'refresh:invalid-response'],
    ];
    for (const [status, body, reason] of cases) {
      const { transport } = transportFor({ [CODEX_REFRESH_ENDPOINT]: { status, body } });
      const err = await refreshCodexToken(creds(), { transport, now: () => NOW }).catch((e: unknown) => e);
      expect((err as CodexNativeError).reason).toBe(reason);
      assertNoSecrets(String((err as Error).message));
    }
    const net = await refreshCodexToken(creds(), { transport: vi.fn(async () => { throw new Error(REFRESH); }), now: () => NOW }).catch((e: unknown) => e);
    expect((net as CodexNativeError).reason).toBe('refresh:network-error');
    assertNoSecrets(String((net as Error).message));
  });

  it('expired ⇒ refresh ⇒ write-back (0600, atomic, unknown fields kept) ⇒ reload ⇒ OAuth usage ok with the new token', async () => {
    const home = codexHome(oauthAuth(STALE_ACCESS));
    const env = { CODEX_HOME: home };
    const loaded = loadCodexCredentials({ env, homeDir: fakeHome() });
    expect(credentialsNeedRefresh(loaded, NOW)).toBe(true);
    const newAccess = jwt({ exp: NOW_S + 7200, sub: 'access-tok-SECRET-new' });
    const { transport } = transportFor({
      [CODEX_REFRESH_ENDPOINT]: { status: 200, body: JSON.stringify({ access_token: newAccess, refresh_token: 'refresh-tok-SECRET-new' }) },
      [WHAM]: (req: Req) => (req.headers.Authorization === `Bearer ${newAccess}`
        ? { status: 200, body: JSON.stringify(usageFixture) } : { status: 401, body: '' }),
    });
    const refreshed = await refreshCodexToken(loaded, { transport, now: () => NOW });
    saveCodexCredentials(refreshed, { env, homeDir: fakeHome() });
    const file = join(home, 'auth.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).sort()).toEqual(['auth.json']);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toEqual({
      auth_mode: 'chatgpt', custom_field: { keep: true }, last_refresh: '2026-10-18T12:00:00Z',
      tokens: { access_token: newAccess, refresh_token: 'refresh-tok-SECRET-new', id_token: ID_TOKEN, account_id: ACCOUNT },
    });
    const out = await readCodexNativeUsage({ ...baseOpts(home), transport, sourceMode: 'oauth' });
    expect(out.reading).toMatchObject({ status: 'ok', strategy: 'codex.oauth' });
  });

  it('only the native home may be written; external (read-only) sources refuse without touching disk', () => {
    const home = codexHome(oauthAuth());
    const before = readFileSync(join(home, 'auth.json'));
    for (const source of ['legacyCodexHome', 'openCode']) {
      expect(() => saveCodexCredentials({ accessToken: 'a', refreshToken: 'r', idToken: null, accountId: null, lastRefresh: NOW, expiresAt: null, source, isAPIKey: false },
        { env: { CODEX_HOME: home }, homeDir: fakeHome() })).toThrow(expect.objectContaining({ reason: 'credentials:read-only-source' }));
    }
    expect(readFileSync(join(home, 'auth.json')).equals(before)).toBe(true);
  });
});

// Lead pin (N1 survivor): in a test process the default home is never read, even when the caller
// passes no homeDir. readFile is a spy, so even a broken guard cannot read the real ~/.codex.
describe('N1 test-process guard', () => {
  it('never reads auth.json under the real home from a test process', async () => {
    const { homedir } = await import('node:os');
    const readFile = vi.fn(() => '{}');
    expect(() => loadCodexCredentials({ env: {}, homeDir: homedir(), readFile })).toThrow();
    expect(readFile).not.toHaveBeenCalled();
  });
});
