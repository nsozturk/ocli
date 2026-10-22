import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPlugin, loadBundledPlugin, PluginError, PLUGIN_DIR,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/plugin-host.mjs';

type Req = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutSeconds: number; signal?: AbortSignal };
type Res = { status?: number; body: string; headers?: Record<string, string> };

/** Fixture transport: never the network. Records every request and the (fake) clock it arrived at. */
function fixture(handler: (req: Req, n: number) => Res | Promise<Res>) {
  const requests: Array<Req & { at: number }> = [];
  const transport = async (req: Req) => {
    requests.push({ ...req, at: Date.now() });
    const res = await handler(req, requests.length);
    return { status: res.status ?? 200, headers: { 'content-type': 'application/json', ...(res.headers ?? {}) }, body: res.body };
  };
  return { transport, requests };
}
const SECRET = 'sk-fixture-SECRET-1234';
const source = (id: string, body: string, policy = 'https') => `defineProvider({
  id: ${JSON.stringify(id)}, name: "Fixture",
  endpoints: ["https://api.fixture.test", { setting: "BASE_URL", policy: ${JSON.stringify(policy)} }],
  auth: { type: "bearer", secret: "API_KEY" },
  settings: [{ key: "API_KEY", title: "Key", type: "secure" }, { key: "BASE_URL", title: "Base", type: "plain" }],
  async fetchUsage(ctx) { ${body} } });`;
const priv = (id: string, body: string) => source(id, body, 'https-or-private-network-http');
type Outcome = {
  reading: { status: string; reason?: string; windows: Array<{ usedPercent: number }>; details?: Array<{ rows: Array<{ label: string; value: string }> }> };
  error: { kind: string; message: string }; // present only on failure

};
const read = (src: string, transport: unknown, settings: Record<string, string> = {}): Promise<Outcome> =>
  loadPlugin(src, { transport }).read({ secrets: { API_KEY: SECRET }, settings, now: Date.UTC(2026, 9, 17, 12) });
/** Fake timers: let the host's retry sleeps, deadlines and optional budget run, then collect the outcome. */
async function settle(promise: Promise<Outcome>, ms = 19_000): Promise<Outcome> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

const pluginFiles = readdirSync(PLUGIN_DIR).filter((f: string) => f.endsWith('.js') && f !== 'provider-plugin-prelude.js').sort();

describe('A2 vendored plugins — attribution pins', () => {
  const attribution = readFileSync(join(PLUGIN_DIR, 'ATTRIBUTION.md'), 'utf8');
  const rows = [...attribution.matchAll(/^\| (\S+) \| (\S+) \| ([0-9a-f]{64}) \|$/gm)].map(m => ({ file: m[1], path: m[2], sha: m[3] }));

  it('70 plugins are vendored (plus the prelude)', () => {
    expect(pluginFiles).toHaveLength(70);
  });

  it('every vendored *.js has an ATTRIBUTION.md row whose sha256 matches, and every row names an existing file', () => {
    let pinned = 0;
    for (const file of [...pluginFiles, 'provider-plugin-prelude.js']) {
      const row = rows.find(r => r.file === file);
      expect(row, file).toBeDefined();
      expect(row!.path, file).toBe(`Sources/CodexBarCore/Resources/Plugins/${file}`);
      expect(createHash('sha256').update(readFileSync(join(PLUGIN_DIR, file))).digest('hex'), file).toBe(row!.sha);
      pinned += 1;
    }
    expect(pinned).toBe(71);
    for (const row of rows) expect(existsSync(join(PLUGIN_DIR, row.file)), row.file).toBe(true);
    expect(attribution).toContain('6480977');
  });
});

describe('A2 vendored plugins — every one loads', () => {
  it.each(pluginFiles)('%s loads and its manifest parses (no request at load)', file => {
    const { transport, requests } = fixture(() => ({ body: '{}' }));
    const rt = loadBundledPlugin(file.replace(/\.js$/, ''), { transport });
    expect(rt.manifest.id).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(rt.manifest.endpoints.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(0);
  });

  it('PARITY.md has one row per plugin', () => {
    const parity = readFileSync(join(PLUGIN_DIR, 'PARITY.md'), 'utf8');
    for (const file of pluginFiles) expect.soft(parity, file).toMatch(new RegExp(`^\\| ${file.replace('.', '\\.')} \\|`, 'm'));
  });
});

describe('A2 https-or-private-network-http', () => {
  const get = 'const r = await ctx.http.get(ctx.settings.get("BASE_URL") + "/usage"); return { primary: { usedPercent: r.status === 200 ? 7 : 1 } };';

  it('a provider on CodexBar\'s bundled list accepts private-network http origins', async () => {
    for (const base of ['http://10.0.0.5:4000', 'http://192.168.1.2', 'http://127.0.0.1:8080', 'http://localhost:4000',
      'http://172.16.0.1', 'http://172.31.255.254', 'http://169.254.10.1', 'http://printer.local', 'http://[::1]:4000',
      'http://[fd00::1]', 'http://[fc12::5]', 'http://[fe80::1]', 'https://public.example.test']) {
      const { transport, requests } = fixture(() => ({ body: '{}' }));
      const { reading, error } = await read(priv('llmproxy', get), transport, { BASE_URL: base });
      expect(reading.status, `${base} ${error?.message}`).toBe('ok');
      expect(requests, base).toHaveLength(1);
    }
  });

  it('a public (or not-quite-private) http host is refused under the private policy', async () => {
    for (const base of ['http://8.8.8.8', 'http://example.test', 'http://172.32.0.1', 'http://172.15.0.1', 'http://11.0.0.1',
      'http://192.169.0.1', 'http://169.255.0.1', 'http://[2001:db8::1]', 'http://[fec0::1]', 'http://local', 'http://.local']) {
      const { transport, requests } = fixture(() => ({ body: '{}' }));
      const { reading } = await read(priv('litellm', get), transport, { BASE_URL: base });
      expect(reading.reason, base).toBe('plugin:network-policy');
      expect(requests, base).toHaveLength(0);
    }
  });

  it('the request must still match the configured private origin', async () => {
    const { transport, requests } = fixture(() => ({ body: '{}' }));
    const { reading } = await read(priv('bifrost', 'await ctx.http.get("http://10.0.0.6:4000/x"); return { primary: { usedPercent: 1 } };'),
      transport, { BASE_URL: 'http://10.0.0.5:4000' });
    expect(reading.reason).toBe('plugin:network-policy');
    expect(requests).toHaveLength(0);
  });

  it('every listed provider id may declare it', () => {
    for (const id of ['llmproxy', 'litellm', 'bifrost', 'aixy', 'llmman'])
      expect(loadPlugin(priv(id, 'return { empty: true };'), {}).manifest.id).toBe(id);
  });

  it('an unlisted provider declaring the policy is an invalid manifest with CodexBar\'s message', () => {
    for (const id of ['fixture', 'zai', 'openrouter']) {
      let caught: unknown;
      try { loadPlugin(priv(id, 'return { empty: true };'), {}); } catch (error) { caught = error; }
      expect(caught, id).toBeInstanceOf(PluginError);
      expect((caught as { kind: string }).kind).toBe('invalid-manifest');
      expect((caught as Error).message).toBe(`Invalid provider plugin manifest: private-network HTTP is not allowed for bundled provider '${id}'`);
    }
  });

  it('the loopback policy is unchanged: a private (non-loopback) http origin stays refused', async () => {
    const { transport, requests } = fixture(() => ({ body: '{}' }));
    const { reading } = await read(source('fixture', get, 'https-or-loopback-http'), transport, { BASE_URL: 'http://10.0.0.5' });
    expect(reading.reason).toBe('plugin:network-policy');
    expect(requests).toHaveLength(0);
  });
});

describe('A2 retryPolicy (transientIdempotent: 1 retry, GET only, 1 s base, Retry-After ≤ 10 s)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  const statusPlugin = (opts = '{ retryPolicy: "transientIdempotent" }', method = 'get') =>
    source('fixture', `const r = await ctx.http.${method}("https://api.fixture.test/u", ${opts}); return { primary: { usedPercent: r.status / 10 } };`);
  it('each retryable status is retried exactly once, 1 s later, and the second response is returned', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const { transport, requests } = fixture((_, n) => (n === 1 ? { status, body: '{}' } : { status: 200, body: '{}' }));
      const { reading } = await settle(read(statusPlugin(), transport));
      expect(reading.windows[0].usedPercent, String(status)).toBe(20);
      expect(requests.map(r => r.at), String(status)).toEqual([requests[0].at, requests[0].at + 1000]);
    }
  });

  it('a status that stays retryable is attempted twice in total, then handed to the plugin', async () => {
    const { transport, requests } = fixture(() => ({ status: 503, body: '{}' }));
    const { reading } = await settle(read(statusPlugin(), transport));
    expect(requests).toHaveLength(2);
    expect(reading.windows[0].usedPercent).toBe(50.3);
  });

  it('a non-retryable status is returned at once', async () => {
    for (const status of [200, 400, 401, 403, 404, 409, 501, 505]) {
      const { transport, requests } = fixture(() => ({ status, body: '{}' }));
      vi.setSystemTime(0);
      const promise = read(statusPlugin(), transport);
      let settledAtOnce = false;
      void promise.then(() => { settledAtOnce = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settledAtOnce, String(status)).toBe(true);
      const { reading } = await settle(promise);
      expect(requests, String(status)).toHaveLength(1);
      expect(reading.status, String(status)).toBe('ok');
    }
  });

  it('Retry-After seconds set the delay (capped at 10 s); an unparseable one falls back to 1 s', async () => {
    for (const [value, delay] of [['3', 3000], [' 2.5 ', 2500], ['30', 10_000], ['0', 0], ['Wed, 21 Oct 2026 07:28:00 GMT', 1000], ['-4', 1000]] as const) {
      vi.setSystemTime(0);
      const { transport, requests } = fixture((_, n) => (n === 1 ? { status: 429, body: '{}', headers: { 'Retry-After': value } } : { body: '{}' }));
      const { reading } = await settle(read(statusPlugin(), transport));
      expect(reading.status, value).toBe('ok');
      expect(requests.map(r => r.at - requests[0].at), value).toEqual([0, delay]);
    }
  });

  it('without retryPolicy nothing is retried', async () => {
    const { transport, requests } = fixture(() => ({ status: 503, body: '{}' }));
    await settle(read(statusPlugin('{}'), transport));
    expect(requests).toHaveLength(1);
  });

  it('POST is never retried, even with retryPolicy', async () => {
    const { transport, requests } = fixture(() => ({ status: 503, body: '{}' }));
    await settle(read(statusPlugin('{ body: {}, retryPolicy: "transientIdempotent" }', 'post'), transport));
    expect(requests).toHaveLength(1);
  });

  it('retryable transport errors (connection, DNS, timeout) retry once; others do not', async () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      vi.setSystemTime(0);
      const { transport, requests } = fixture((_, n) => {
        if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
        return { body: '{}' };
      });
      const { reading } = await settle(read(statusPlugin(), transport));
      expect(reading.status, code).toBe('ok');
      expect(requests.map(r => r.at), code).toEqual([0, 1000]);
    }
    for (const code of ['CERT_HAS_EXPIRED', 'ENETUNREACH', undefined]) {
      const { transport, requests } = fixture(() => { throw Object.assign(new TypeError('fetch failed'), code ? { cause: Object.assign(new Error(code), { code }) } : {}); });
      const { reading } = await settle(read(statusPlugin(), transport));
      expect(reading.status, String(code)).toBe('unavailable');
      expect(requests, String(code)).toHaveLength(1);
    }
  });

  it('a timed-out attempt is retried with a fresh per-attempt deadline', async () => {
    const { transport, requests } = fixture((req, n) => (n === 1
      ? new Promise<Res>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      : { body: '{}' }));
    const { reading } = await settle(read(statusPlugin('{ timeoutSeconds: 5, retryPolicy: "transientIdempotent" }'), transport));
    expect(reading.status).toBe('ok');
    expect(requests.map(r => r.at)).toEqual([0, 6000]);
  });

  it('a retryable transport failure reaches the plugin as retryable', async () => {
    const { transport } = fixture(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }); });
    const src = source('fixture', `try { await ctx.http.get("https://api.fixture.test/u"); } catch (e) { return { primary: { usedPercent: e.retryable === true && e.transportClass === "connection" ? 9 : 1 } }; }`);
    const { reading } = await settle(read(src, transport));
    expect(reading.windows[0].usedPercent).toBe(9);
  });

  it('retryPolicy must be the string "transientIdempotent"', async () => {
    for (const value of ['"always"', 'null', 'true', '1']) {
      const { transport, requests } = fixture(() => ({ body: '{}' }));
      const { reading, error } = await settle(read(statusPlugin(`{ retryPolicy: ${value} }`), transport));
      expect(reading.reason, value).toBe('plugin:http');
      expect(error.message, value).toContain("retryPolicy must be 'transientIdempotent'");
      expect(requests, value).toHaveLength(0);
    }
  });
});

describe('A2 getWithOptional (optional request: no retry, ≤ 5 s, 2xx only, 200 ms collection budget)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  const delayed = (ms: number, res: Res) => new Promise<Res>(resolve => setTimeout(() => resolve(res), ms));
  const optionalPlugin = (call: string) => source('fixture', `
    const r = await ${call};
    return { primary: { usedPercent: 1 }, details: [{ title: "x", rows: [
      { label: "primary", value: String(r.status) + ":" + r.bodyText },
      { label: "optional", value: r.optional === null ? "null" : r.optional === undefined ? "absent" : String(r.optional.status) + ":" + r.optional.bodyText },
    ] }] };`);
  const rows = (reading: { details?: Array<{ rows: Array<{ label: string; value: string }> }> }) =>
    Object.fromEntries((reading.details?.[0]?.rows ?? []).map(r => [r.label, r.value]));
  const route = (primary: () => Res | Promise<Res>, optional: () => Res | Promise<Res>) =>
    fixture(req => (req.url.endsWith('/opt') ? optional() : primary()));

  it('both succeed: the optional response is attached; the optional request is capped at 5 s and is a GET', async () => {
    const { transport, requests } = route(() => ({ body: 'P' }), () => ({ body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt", { timeoutSeconds: 30 })'), transport));
    expect(rows(reading)).toEqual({ primary: '200:P', optional: '200:O' });
    const opt = requests.find(r => r.url.endsWith('/opt'))!;
    expect(opt.method).toBe('GET');
    expect(opt.timeoutSeconds).toBe(5);
    expect(requests.find(r => r.url.endsWith('/p'))!.timeoutSeconds).toBe(30);
  });

  it('a POST optional request carries its JSON body', async () => {
    const { transport, requests } = route(() => ({ body: 'P' }), () => ({ body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", { url: "https://api.fixture.test/opt", method: "POST", body: { a: 1 } })'), transport));
    expect(rows(reading).optional).toBe('200:O');
    const opt = requests.find(r => r.url.endsWith('/opt'))!;
    expect([opt.method, opt.body]).toEqual(['POST', '{"a":1}']);
  });

  it('a non-2xx optional response becomes null and is never retried', async () => {
    const { transport, requests } = route(() => ({ body: 'P' }), () => ({ status: 503, body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt", { retryPolicy: "transientIdempotent" })'), transport));
    expect(rows(reading)).toEqual({ primary: '200:P', optional: 'null' });
    expect(requests.filter(r => r.url.endsWith('/opt'))).toHaveLength(1);
  });

  it('a non-2xx primary returns at once with optional null (the primary keeps its retry policy)', async () => {
    const { transport, requests } = route(() => ({ status: 503, body: 'P' }), () => delayed(100, { body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt", { retryPolicy: "transientIdempotent" })'), transport));
    expect(rows(reading)).toEqual({ primary: '503:P', optional: 'null' });
    expect(requests.filter(r => r.url.endsWith('/p'))).toHaveLength(2);
  });

  it('an optional response slower than the 200 ms budget is dropped; optionalBudgetSeconds widens it', async () => {
    const slow = route(() => ({ body: 'P' }), () => delayed(1000, { body: 'O' }));
    const dropped = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt")'), slow.transport));
    expect(rows(dropped.reading)).toEqual({ primary: '200:P', optional: 'null' });
    const kept = route(() => ({ body: 'P' }), () => delayed(1000, { body: 'O' }));
    const widened = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt", { optionalBudgetSeconds: 2 })'), kept.transport));
    expect(rows(widened.reading)).toEqual({ primary: '200:P', optional: '200:O' });
  });

  it('an optional result that finished while the primary was still pending is kept even after the budget', async () => {
    const { transport } = route(() => delayed(500, { body: 'P' }), () => delayed(100, { body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt")'), transport));
    expect(rows(reading)).toEqual({ primary: '200:P', optional: '200:O' });
  });

  it('an optional request that fails in transport is null, not an error', async () => {
    const { transport } = route(() => ({ body: 'P' }), () => { throw new TypeError('fetch failed'); });
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt")'), transport));
    expect(rows(reading)).toEqual({ primary: '200:P', optional: 'null' });
  });

  it('plain get has no optional key', async () => {
    const { transport } = route(() => ({ body: 'P' }), () => ({ body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.get("https://api.fixture.test/p")'), transport));
    expect(rows(reading)).toEqual({ primary: '200:P', optional: 'absent' });
  });

  it('an undeclared optional origin fails the whole call before any request', async () => {
    const { transport, requests } = route(() => ({ body: 'P' }), () => ({ body: 'O' }));
    const { reading } = await settle(read(optionalPlugin('ctx.http.getWithOptional("https://api.fixture.test/p", "https://evil.test/opt")'), transport));
    expect(reading.reason).toBe('plugin:network-policy');
    expect(requests).toHaveLength(0);
  });

  it('optionalBudgetSeconds must be a number from 0 through 5; a malformed optionalRequest is refused', async () => {
    for (const opts of ['{ optionalBudgetSeconds: 6 }', '{ optionalBudgetSeconds: -1 }', '{ optionalBudgetSeconds: true }', '{ optionalBudgetSeconds: "1" }']) {
      const { transport, requests } = route(() => ({ body: 'P' }), () => ({ body: 'O' }));
      const { reading, error } = await settle(read(optionalPlugin(`ctx.http.getWithOptional("https://api.fixture.test/p", "https://api.fixture.test/opt", ${opts})`), transport));
      expect(reading.reason, opts).toBe('plugin:http');
      expect(error.message, opts).toContain('optionalBudgetSeconds must be a number from 0 through 5');
      expect(requests, opts).toHaveLength(0);
    }
    const { transport, requests } = route(() => ({ body: 'P' }), () => ({ body: 'O' }));
    const { reading, error } = await settle(read(optionalPlugin('ctx.http.get("https://api.fixture.test/p", { optionalRequest: { url: "https://api.fixture.test/opt", method: "PUT", options: {} } })'), transport));
    expect(reading.reason).toBe('plugin:http');
    expect(error.message).toContain('optional request requires a GET primary and GET or POST options');
    expect(requests).toHaveLength(0);
  });
});
