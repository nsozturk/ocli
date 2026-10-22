import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Slice D: usage-readers/index.mjs is the one entry point. Every reader here runs against fixtures (temp homes, stub
// transports, a stub ps/lsof runner): no network, no real ~/.codex / ~/.claude / ~/.config/ocli, no keychain, no
// process scan. child_process is a spy so any spawn at all — codexbar above all — fails the test.

const spawned = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  spawn: vi.fn((command: string) => { spawned.push(command); throw new Error(`spawn refused in test: ${command}`); }),
  spawnSync: vi.fn((command: string) => { spawned.push(command); throw new Error(`spawnSync refused in test: ${command}`); }),
  execFile: vi.fn((command: string) => { spawned.push(command); throw new Error(`execFile refused in test: ${command}`); }),
}));

// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { readProviderUsage, toTreeReading, USAGE_PROVIDERS, PLUGIN_FOR } from '../dispatcher/usage-readers/index.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { readAll, ROUTE_LIMIT_IDS } from '../dispatcher/usage.mjs';

type Req = { url: string; method: string; headers: Record<string, string>; body?: string };
type Res = { status: number; body: string; headers?: Record<string, string> };
function transportFor(route: (req: Req) => Res) {
  const requests: Req[] = [];
  const transport = vi.fn(async (req: Req) => {
    requests.push(req);
    const r = route(req);
    return { status: r.status, headers: r.headers ?? { 'content-type': 'application/json' }, body: Buffer.from(r.body) };
  });
  return { transport, requests };
}

let dirs: string[] = [];
const temp = (prefix = 'd-index-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; spawned.length = 0; });

const WINDOW_KEYS = ['limitId', 'resetsAt', 'usedPercent', 'windowDurationMins'];
const READING_KEYS = new Set(['status', 'source', 'updatedAt', 'windows', 'reason', 'ordinaryUsageAllowed']);
function expectTreeShape(reading: Record<string, unknown>) {
  for (const k of Object.keys(reading)) expect(READING_KEYS.has(k), `reading key ${k}`).toBe(true);
  for (const w of reading.windows as Record<string, unknown>[]) expect(Object.keys(w).sort()).toEqual(WINDOW_KEYS);
}

// ---------------------------------------------------------------- codex fixture (N1 /wham/usage)
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'none' })}.${b64url(payload)}.c2ln`;
const NOW = Date.parse('2026-10-18T12:00:00Z');
const NOW_S = NOW / 1000;
const CODEX_EMAIL = 'person-d41@example.invalid';
const CODEX_ACCOUNT = 'acct-d41-workspace';
const CODEX_ACCESS = jwt({ exp: NOW_S + 3600, sub: 'access-tok-SECRET-d41' });
const CODEX_ID = jwt({ email: CODEX_EMAIL, 'https://api.openai.com/auth': { chatgpt_plan_type: 'enterprise', chatgpt_account_id: CODEX_ACCOUNT } });
const WHAM = 'https://chatgpt.com/backend-api/wham/usage';
function codexOpts() {
  const home = temp('d-codex-home-');
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { access_token: CODEX_ACCESS, refresh_token: 'refresh-tok-SECRET-d41', id_token: CODEX_ID, account_id: CODEX_ACCOUNT } }));
  const { transport, requests } = transportFor(req => {
    if (req.url !== WHAM) throw new Error(`unrouted ${req.url}`);
    return { status: 200, body: JSON.stringify({ account_id: CODEX_ACCOUNT, plan_type: 'enterprise', email: CODEX_EMAIL,
      rate_limit: {
        primary_window: { used_percent: 23, reset_at: NOW_S + 3600, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 61, reset_at: NOW_S + 86400, limit_window_seconds: 604800 } } }) };
  });
  return { requests, opts: { env: { CODEX_HOME: home }, homeDir: temp(), now: () => NOW, sleep: async () => {},
    resolveCodexBinary: () => null, sourceMode: 'oauth', transport } };
}

// ---------------------------------------------------------------- claude fixture (N2 OAuth)
const CLAUDE_ACCESS = 'sk-ant-oat01-ACCESS-SECRET-d42xyz';
function claudeOpts() {
  const home = temp('d-claude-home-');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: CLAUDE_ACCESS, refreshToken: 'sk-ant-ort01-REFRESH-SECRET-d42', expiresAt: NOW + 3_600_000,
    scopes: ['user:inference', 'user:profile'], rateLimitTier: 'default_claude_max_5x', subscriptionType: 'max' } }), { mode: 0o600 });
  const { transport, requests } = transportFor(() => ({ status: 200, body: JSON.stringify({
    five_hour: { utilization: 12.5, resets_at: '2025-12-25T12:00:00.000Z' },
    seven_day: { utilization: 30, resets_at: '2025-12-31T00:00:00.000Z' } }) }));
  return { requests, opts: { env: { HOME: home }, now: () => NOW, runtime: 'app', resolveClaudeBinary: () => null,
    configPath: join(home, 'none.json'), credentials: { read: vi.fn(() => ({ ok: false, reason: 'not-found' })) }, transport } };
}

// ---------------------------------------------------------------- antigravity fixture (N5 loopback probe)
const AG_EMAIL = 'person-d43@example.invalid';
const CSRF_APP = 'csrf-SECRET-app-d43';
const QS = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const US = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const UNLEASH = '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const APP_LINE = `  202 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token ${CSRF_APP} --app_data_dir antigravity --extension_server_port 57001 --extension_server_csrf_token csrf-SECRET-ext-d43`;
const LSOF_202 = ['COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'language_ 202 test   12u  IPv4 0x1111      0t0  TCP 127.0.0.1:64440 (LISTEN)'].join('\n');
const QUOTA_SUMMARY = JSON.stringify({ response: { groups: [{ displayName: 'Gemini Models', buckets: [
  { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', remaining: { remainingFraction: 0.82 }, resetTime: '2026-06-19T08:45:39Z' },
  { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', remaining: { remainingFraction: 0.91 }, resetTime: '2026-06-15T11:39:34Z' },
  { bucketId: 'gemini-argon-wtu-weekly', displayName: 'Argon WTU Weekly Limit', remaining: { remainingFraction: 0.56 }, resetTime: '2026-06-21T00:00:00Z' },
] }] } });
function geminiOpts() {
  const runner = vi.fn(async (binary: string, args: string[]) => {
    if (binary === '/bin/ps') return { stdout: `    1 /sbin/launchd\n${APP_LINE}\n`, stderr: '', code: 0 };
    if (binary.endsWith('lsof')) return { stdout: args[args.length - 1] === '202' ? LSOF_202 : '', stderr: '', code: 0 };
    throw new Error(`unexpected binary ${binary}`);
  });
  const { transport, requests } = transportFor(req => {
    const p = new URL(req.url).pathname;
    if (p === UNLEASH) return { status: 200, body: '{}' };
    if (p === US) return { status: 200, body: JSON.stringify({ code: 0, userStatus: { email: AG_EMAIL, planStatus: { planInfo: { planName: 'Pro' } } } }) };
    if (p === QS) return { status: 200, body: QUOTA_SUMMARY };
    throw new Error(`unrouted ${p}`);
  });
  return { requests, opts: { sourceMode: 'auto', env: {}, homeDir: temp(), runner, lsofPath: '/usr/sbin/lsof', transport,
    now: () => Date.parse('2026-06-15T10:00:00Z') } };
}

// ---------------------------------------------------------------- zai fixture (vendored zai.js)
const ZAI_KEY = 'zai-fixture-SECRET-key-d44';
function glmOpts() {
  const dir = temp('d-zai-');
  const quota = `{"code":200,"msg":"success","success":true,"data":{"planName":"Pro","limits":[
    {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},
    {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":9,"nextResetTime":1786291200000}]}}`;
  const analytics = '{"code":200,"msg":"success","success":true,"data":{"x_time":[],"modelDataList":[]}}';
  const { transport, requests } = transportFor(req => ({ status: 200, body: new URL(req.url).pathname.endsWith('/quota/limit') ? quota : analytics }));
  return { requests, opts: { env: { Z_AI_API_KEY: ZAI_KEY, Z_AI_REGION: 'global', Z_AI_USAGE_SCOPE: 'personal' },
    configPath: join(dir, 'usage-readers.json'), now: 1_785_816_000_000, cookieSource: null, transport } };
}

const plansLimitIds: Record<string, string[]> = ROUTE_LIMIT_IDS;

describe('slice D — index.mjs per-provider limitId parity (real readers, fixture inputs)', () => {
  it('codex: the native OAuth reader keeps limitId `codex` (5h + weekly); identity dropped', async () => {
    const { opts, requests } = codexOpts();
    const r = await readProviderUsage('codex', opts);
    expect(requests.map(q => q.url)).toEqual([WHAM]);
    expect(r).toEqual({ status: 'ok', source: 'native:codex', updatedAt: new Date(NOW).toISOString(), windows: [
      { limitId: 'codex', usedPercent: 23, windowDurationMins: 300, resetsAt: new Date((NOW_S + 3600) * 1000).toISOString() },
      { limitId: 'codex', usedPercent: 61, windowDurationMins: 10080, resetsAt: new Date((NOW_S + 86400) * 1000).toISOString() },
    ] });
    for (const id of plansLimitIds.codex) expect(r.windows.map((w: { limitId: string }) => w.limitId)).toContain(id);
    const text = JSON.stringify(r);
    for (const s of [CODEX_EMAIL, CODEX_ACCOUNT, 'enterprise', CODEX_ACCESS]) expect(text).not.toContain(s);
  });

  it('claude: the native OAuth reader keeps "5-hour limit" and "Weekly · all models"; identity dropped', async () => {
    const { opts } = claudeOpts();
    const r = await readProviderUsage('claude', opts);
    expectTreeShape(r);
    expect(r.status).toBe('ok');
    expect(r.source).toBe('native:claude');
    expect(r.windows.map((w: { limitId: string }) => w.limitId).sort()).toEqual([...plansLimitIds.claude].sort());
    expect(r.windows.find((w: { limitId: string }) => w.limitId === '5-hour limit')).toEqual(
      { limitId: '5-hour limit', usedPercent: 12.5, windowDurationMins: 300, resetsAt: '2025-12-25T12:00:00.000Z' });
    expect(JSON.stringify(r)).not.toMatch(/max|ACCESS-SECRET|loginMethod/);
  });

  it('claude: native unavailable falls back to the lead snapshot (claudeUsageFromLead)', async () => {
    const readers = { claude: { read: vi.fn(async () => ({ reading: { status: 'unavailable', reason: 'native:claude:credentials-not-found', windows: [] }, identity: null })) } };
    const snapshot = { windows: [{ label: '5-hour limit', percentUsed: 40, resetsAt: '2026-10-18T15:00:00.000Z' }] };
    const r = await readProviderUsage('claude', { readers, claudeSnapshot: snapshot });
    expect(r).toEqual({ status: 'ok', source: 'lead', updatedAt: null, windows: [
      { limitId: '5-hour limit', usedPercent: 40, windowDurationMins: 300, resetsAt: '2026-10-18T15:00:00.000Z' }] });
    const none = await readProviderUsage('claude', { readers });
    expect(none.status).toBe('unknown');
    expect(none.reason).toMatch(/^native:claude:credentials-not-found; no lead-supplied snapshot/);
  });

  it('gemini: the native Antigravity probe keeps the three antigravity-quota-summary-gemini-* ids; email dropped', async () => {
    const { opts, requests } = geminiOpts();
    const r = await readProviderUsage('gemini', opts);
    expectTreeShape(r);
    expect(r.status).toBe('ok');
    const ids = r.windows.map((w: { limitId: string }) => w.limitId);
    for (const id of plansLimitIds.gemini) expect(ids).toContain(id);
    expect(requests.every(q => new URL(q.url).hostname === '127.0.0.1')).toBe(true);
    expect(JSON.stringify(r)).not.toContain(AG_EMAIL);
    expect(JSON.stringify(r)).not.toContain('csrf-SECRET');
  });

  it('glm: the vendored zai plugin keeps `zai-primary` (the plans id); the plan name stays out', async () => {
    const { opts, requests } = glmOpts();
    const r = await readProviderUsage('glm', opts);
    expectTreeShape(r);
    expect(r.status).toBe('ok');
    expect(r.source).toBe('plugin:zai');
    expect(r.windows.find((w: { limitId: string }) => w.limitId === 'zai-primary')).toMatchObject({ usedPercent: 25, windowDurationMins: 300 });
    for (const id of plansLimitIds.glm) expect(r.windows.map((w: { limitId: string }) => w.limitId)).toContain(id);
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(ZAI_KEY);
  });

  it('muse / cline: routed to the muse / clinepass plugins, limitIds (<plugin>-primary) unchanged, identity dropped', async () => {
    const read = vi.fn(async (provider: string) => ({
      reading: { status: 'ok', source: `plugin:${PLUGIN_FOR[provider]}`, updatedAt: '2026-10-18T12:00:00.000Z', identity: { email: 'leak@example.invalid' },
        windows: [{ limitId: `${PLUGIN_FOR[provider]}-primary`, usedPercent: 12, windowDurationMins: 300, resetsAt: null, title: 'x', accountEmail: 'leak@example.invalid' }] },
      identity: { email: 'leak@example.invalid', organization: 'Leak Org' } }));
    for (const [provider, id] of [['muse', 'muse-primary'], ['cline', 'clinepass-primary']]) {
      const r = await readProviderUsage(provider, { readers: { plugin: { read } } });
      expect(r).toEqual({ status: 'ok', source: `plugin:${PLUGIN_FOR[provider]}`, updatedAt: '2026-10-18T12:00:00.000Z',
        windows: [{ limitId: id, usedPercent: 12, windowDurationMins: 300, resetsAt: null }] });
    }
    expect(read.mock.calls.map(c => c[0])).toEqual(['muse', 'cline']);
    expect(PLUGIN_FOR).toEqual({ glm: 'zai', muse: 'muse', cline: 'clinepass' });
  });

  it('codex keeps its own ordinaryUsageAllowed verdict (dispatch reads it as exhausted)', () => {
    expect(toTreeReading({ status: 'ok', windows: [], ordinaryUsageAllowed: false }).ordinaryUsageAllowed).toBe(false);
    expect(toTreeReading({ status: 'ok', windows: [], ordinaryUsageAllowed: 'no' })).not.toHaveProperty('ordinaryUsageAllowed');
  });

  it('an unknown provider and a throwing reader are unavailable, never a throw, never the error text', async () => {
    expect((await readProviderUsage('openrouter')).status).toBe('unavailable');
    const read = vi.fn(async () => { throw new Error('boom sk-ant-oat01-LEAKED'); });
    const r = await readProviderUsage('codex', { readers: { codex: { read } } });
    expect(r.status).toBe('unavailable');
    expect(JSON.stringify(r)).not.toContain('LEAKED');
  });
});

describe('slice D — readAll goes through index.mjs only', () => {
  const failingTransport = () => vi.fn(async () => { throw new Error('network refused by the test'); });

  it('identity never reaches readAll output; every provider read once, in parallel; no spawn at all', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const gate = () => new Promise<void>(r => release.push(r));
    const stub = (name: string) => vi.fn(async (...args: unknown[]) => {
      started.push(typeof args[0] === 'string' ? args[0] : name);
      await gate();
      return { reading: { status: 'ok', source: `s:${name}`, updatedAt: null, accountEmail: 'leak@example.invalid',
        windows: [{ limitId: `${name}-x`, usedPercent: 1, windowDurationMins: 300, resetsAt: null, accountOrganization: 'Leak Org' }] },
      identity: { email: 'leak@example.invalid', organization: 'Leak Org', accountId: 'acct-leak' } };
    });
    const readers = { codex: { read: stub('codex') }, claude: { read: stub('claude') }, gemini: { read: stub('gemini') }, plugin: { read: stub('plugin') } };
    const pending = readAll({ readers, transport: failingTransport(), env: {}, homeDir: temp(), configPath: join(temp(), 'x.json') });
    for (let i = 0; i < 10 && started.length < 6; i += 1) await new Promise(r => setImmediate(r));
    expect(started.sort()).toEqual(['claude', 'cline', 'codex', 'gemini', 'glm', 'muse']); // all six started before any finished
    release.forEach(r => r());
    const all = await pending;
    expect(Object.keys(all)).toEqual(['codex', 'claude', 'glm', 'gemini', 'muse', 'cline', 'readAt']);
    expect(JSON.stringify(all)).not.toMatch(/leak|Leak|acct-/);
    expect(spawned).toEqual([]);
  });

  it('with the default readers in a test process every reader fails closed: no codexbar, no spawn, no network', async () => {
    const transport = failingTransport();
    const home = temp();
    const all = await readAll({ transport, env: {}, homeDir: home, configPath: join(home, 'usage-readers.json') });
    for (const p of USAGE_PROVIDERS) {
      expect(all[p].status, p).not.toBe('ok');
      expectTreeShape(all[p]);
    }
    expect(spawned).toEqual([]);
    expect(JSON.stringify(all)).not.toMatch(/codexbar/i);
  });
});

// ---------------------------------------------------------------- u4-d-fix: the run's redaction set reaches the raw store
// Each family echoes a secret its reader KNOWS but that is not on the echoing request's own headers (so the header
// strip alone cannot catch it): codex refresh token, claude refresh token, the antigravity extension-server CSRF token,
// muse's device token echoed on a dev.meta.ai (cookie-only) request.
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { openRawStore } from '../dispatcher/usage-readers/raw-store.mjs';
import { gunzipSync } from 'node:zlib';

describe('u4-d-fix — a secret echoed in a response body never reaches raw_usage.sqlite', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); });
  async function store() {
    const s = await openRawStore(join(temp('d-fix-store-'), 'raw_usage.sqlite'));
    stores.push(s);
    return s;
  }
  const bodies = (s: any): string[] => s.db.prepare('SELECT gz FROM blobs').all().map((r: { gz: Uint8Array }) => gunzipSync(r.gz).toString('utf8'));
  // Wraps a fixture transport: every JSON object body gains an `echo` field carrying the secret.
  const echoing = (inner: (r: Req) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>, secret: string) =>
    async (req: Req) => {
      const res = await inner(req);
      const parsed = JSON.parse(res.body.toString('utf8'));
      return { ...res, body: Buffer.from(JSON.stringify({ ...parsed, echo: secret })) };
    };

  it('codex native: the refresh token from auth.json is redacted in the stored usage body', async () => {
    const s = await store();
    const { opts } = codexOpts();
    const r = await readProviderUsage('codex', { ...opts, rawStore: s, transport: echoing(opts.transport, 'refresh-tok-SECRET-d41') });
    expect(r.status).toBe('ok');
    const stored = bodies(s);
    expect(stored.length).toBe(1);
    expect(stored[0]).toContain('<redacted>');
    expect(stored.join('\n')).not.toContain('refresh-tok-SECRET-d41');
  });

  it('claude native: the OAuth refresh token is redacted in the stored usage body', async () => {
    const s = await store();
    const { opts } = claudeOpts();
    const r = await readProviderUsage('claude', { ...opts, rawStore: s, transport: echoing(opts.transport, 'sk-ant-ort01-REFRESH-SECRET-d42') });
    expect(r.status).toBe('ok');
    const stored = bodies(s);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.join('\n')).not.toContain('sk-ant-ort01-REFRESH-SECRET-d42');
  });

  it('antigravity native: the extension-server CSRF token (never a request header here) is redacted', async () => {
    const s = await store();
    const { opts, requests } = geminiOpts();
    const r = await readProviderUsage('gemini', { ...opts, rawStore: s, transport: echoing(opts.transport, 'csrf-SECRET-ext-d43') });
    expect(r.status).toBe('ok');
    expect(JSON.stringify(requests.map(q => q.headers))).not.toContain('csrf-SECRET-ext-d43');
    const stored = bodies(s);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.join('\n')).not.toContain('csrf-SECRET-ext-d43');
  });

  it('plugin host (muse): the device token echoed on a cookie-only dev.meta.ai request is redacted', async () => {
    const s = await store();
    const DEVICE = 'dca:muse-device-SECRET-d45';
    const EMAIL = 'person-d45@example.invalid';
    const { transport, requests } = transportFor(req => {
      const u = new URL(req.url);
      if (u.hostname === 'api.meta.ai') return { status: 200, body: JSON.stringify({ is_subs_active: true, user_email: EMAIL }) };
      if (u.pathname === '/api/auth/me') return { status: 200, body: JSON.stringify({ email: EMAIL, echo: DEVICE }) };
      return { status: 200, body: '{}' };
    });
    await readProviderUsage('muse', { rawStore: s, env: { MUSE_DEVICE_TOKEN: DEVICE }, configPath: join(temp('d-muse-'), 'usage-readers.json'),
      cookieSource: async () => 'session=muse-cookie-SECRET-d45', transport });
    const me = requests.find(q => new URL(q.url).pathname === '/api/auth/me');
    expect(me, 'the plugin reached the cookie-only request').toBeTruthy();
    expect(JSON.stringify(me!.headers)).not.toContain(DEVICE);
    const stored = bodies(s);
    expect(stored.some(b => b.includes(EMAIL) && b.includes('<redacted>'))).toBe(true);
    expect(stored.join('\n')).not.toContain(DEVICE);
    expect(stored.join('\n')).not.toContain('muse-device-SECRET-d45');
  });
});

// ---------------------------------------------------------------- u4-d-rereview pins (surviving mutants R8, R12, R17)
describe('u4-d-rereview — every secret the run knows, and only this run', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); });
  async function store() {
    const s = await openRawStore(join(temp('d-rr-store-'), 'raw_usage.sqlite'));
    stores.push(s);
    return s;
  }
  const bodies = (s: any): string[] => s.db.prepare('SELECT gz FROM blobs').all().map((r: { gz: Uint8Array }) => gunzipSync(r.gz).toString('utf8'));
  const echoBody = (body: string, secret: string) => JSON.stringify({ ...JSON.parse(body), echo: secret });

  it('R8 codex: the id token (never a request header) is redacted in the stored usage body', async () => {
    const s = await store();
    const { opts } = codexOpts();
    const inner = opts.transport;
    const transport = async (req: Req) => { const r = await inner(req); return { ...r, body: Buffer.from(echoBody(r.body.toString('utf8'), CODEX_ID)) }; };
    const r = await readProviderUsage('codex', { ...opts, rawStore: s, transport });
    expect(r.status).toBe('ok');
    const stored = bodies(s);
    expect(stored.length).toBe(1);
    expect(stored[0]).not.toContain(CODEX_ID);
  });

  const ADMIN = 'sk-ant-admin01-ADMIN-SECRET-d46';
  it('R12 claude: an env admin key in oauth mode (never sent) is still redacted in a stored body', async () => {
    const s = await store();
    const { opts } = claudeOpts();
    const inner = opts.transport;
    const transport = async (req: Req) => { const r = await inner(req); return { ...r, body: Buffer.from(echoBody(r.body.toString('utf8'), ADMIN)) }; };
    const r = await readProviderUsage('claude', { ...opts, sourceMode: 'oauth', env: { ...opts.env, ANTHROPIC_ADMIN_KEY: ADMIN }, rawStore: s, transport });
    expect(r.status).toBe('ok');
    const stored = bodies(s);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.join('\n')).not.toContain(ADMIN);
  });

  it('R17 concurrent runs get their own redaction set: no shared mutable set, no cross-run secret', async () => {
    const seen: Array<Set<string>> = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const read = async (o: { redactionSet: Set<string> }) => {
      seen.push(o.redactionSet);
      o.redactionSet.add(`run-${seen.length}-SECRET`);
      await gate;
      return { reading: { status: 'unavailable', reason: 'stub', windows: [] } };
    };
    const a = readProviderUsage('codex', { rawStore: null, readers: { codex: { read } } });
    const b = readProviderUsage('claude', { rawStore: null, readers: { claude: { read } }, claudeSnapshot: null });
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([a, b]);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect([...seen[0]]).toEqual(['run-1-SECRET']);
    expect([...seen[1]]).toEqual(['run-2-SECRET']);
  });
});
