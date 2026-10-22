import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlugin, loadBundledPlugin, readPluginUsage, resolvePluginSettings, mapPluginResult, PluginError,
  MAX_RESPONSE_BYTES,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/plugin-host.mjs';

type Req = { url: string; method: string; headers: Record<string, string>; body?: string; timeoutSeconds: number };
type Res = { status?: number; body: string | Uint8Array; headers?: Record<string, string> };

/** Fixture transport: never the network. Records every request it is handed. */
function fixture(handler: (req: Req) => Res | Promise<Res>) {
  const requests: Req[] = [];
  const transport = async (req: Req) => {
    requests.push(req);
    const res = await handler(req);
    return { status: res.status ?? 200, headers: { 'content-type': 'application/json', ...(res.headers ?? {}) }, body: res.body };
  };
  return { transport, requests };
}
const header = (req: Req, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const manifest = (extra = '') => `
  id: "fixture", name: "Fixture",
  endpoints: ["https://api.fixture.test", { setting: "BASE_URL", policy: "https-or-loopback-http" }],
  auth: { type: "bearer", secret: "API_KEY" },
  settings: [
    { key: "API_KEY", title: "Key", type: "secure" },
    { key: "BASE_URL", title: "Base", type: "plain" },
    { key: "MODE", title: "Mode", type: "plain" },
  ],
  capabilities: ["browser-cookies"], cookieDomains: ["fixture.test"],
  ${extra}`;
const plugin = (body: string, extra = '') => `defineProvider({ ${manifest(extra)} async fetchUsage(ctx) { ${body} } });`;
const SECRET = 'sk-fixture-SECRET-1234';
const run = (source: string, transport: unknown, opts: Record<string, unknown> = {}) =>
  loadPlugin(source, { transport, ...opts }).read({ secrets: { API_KEY: SECRET }, now: Date.UTC(2026, 9, 17, 12), ...opts });

describe('A1 plugin host — sandbox', () => {
  it('exposes only ECMAScript built-ins plus defineProvider (no fetch/XHR/timers/require/process)', () => {
    const rt = loadPlugin(plugin('return { primary: { usedPercent: 1 } };'), { transport: fixture(() => ({ body: '{}' })).transport });
    for (const name of ['fetch', 'XMLHttpRequest', 'setTimeout', 'setInterval', 'require', 'process', 'console', 'ctx'])
      expect(rt.globalType(name), name).toBe('undefined');
    expect(rt.globalType('defineProvider')).toBe('function');
    expect(rt.globalType('JSON')).toBe('object');
  });

  it('a plugin cannot climb out of the context to reach process', async () => {
    const src = plugin(`
      let reached = 'blocked';
      try { reached = typeof this.constructor.constructor('return process')(); } catch (e) { reached = 'threw'; }
      let viaCtx = 'blocked';
      try { viaCtx = typeof ctx.http.get.constructor('return process')(); } catch (e) { viaCtx = 'threw'; }
      let viaErr = 'blocked';
      try { ctx.settings.get('NOPE'); } catch (e) { try { viaErr = typeof e.constructor.constructor('return process')(); } catch { viaErr = 'threw'; } }
      return { primary: { usedPercent: 1 }, details: [{ rows: [
        { label: 'this', value: reached }, { label: 'ctx', value: viaCtx }, { label: 'err', value: viaErr } ] }] };`);
    const { reading } = await run(src, fixture(() => ({ body: '{}' })).transport);
    expect(reading.status).toBe('ok');
    for (const row of reading.details[0].rows) expect(row.value).not.toBe('object');
  });

  // Lead pins (A1 mutants F, L, R) + the thenable probe from review.
  it('string code generation is off inside the plugin context (eval / new Function throw)', async () => {
    const src = plugin(`
      let viaEval = 'ran'; try { eval('1'); } catch (e) { viaEval = 'threw'; }
      let viaFn = 'ran'; try { new Function('return 1')(); } catch (e) { viaFn = 'threw'; }
      return { primary: { usedPercent: 1 }, details: [{ rows: [{ label: 'eval', value: viaEval }, { label: 'fn', value: viaFn }] }] };`);
    const { reading } = await run(src, fixture(() => ({ body: '{}' })).transport);
    expect(reading.details[0].rows.map((r: any) => r.value)).toEqual(['threw', 'threw']);
  });

  it('a thenable result cannot reach process through the resolve function', async () => {
    const src = `defineProvider({ ${manifest()} fetchUsage() { return { then(r) {
      let leak = 'blocked'; try { leak = typeof r.constructor('return process')(); } catch (e) { leak = 'threw'; }
      r({ primary: { usedPercent: 1 }, details: [{ rows: [{ label: 'leak', value: leak }] }] }); } }; } });`;
    const { reading } = await run(src, fixture(() => ({ body: '{}' })).transport);
    expect(reading.details[0].rows[0].value).not.toBe('object');
  });

  it('each cookie value is redacted from logs, not only the whole header', async () => {
    const logs: any[] = [];
    const src = plugin('const h = await ctx.browser.cookieHeader("fixture.test"); ctx.log(h.split("; ")[1].split("=")[1]); return { primary: { usedPercent: 1 } };');
    await run(src, fixture(() => ({ body: '{}' })).transport,
      { log: (l: unknown) => logs.push(l), cookieSource: async () => 'a=first-cookie-value; sid=second-cookie-value' });
    expect(JSON.stringify(logs)).not.toContain('second-cookie-value');
  });

  it('ctx.cache TTL is capped at 24 h', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 17, 12));
      const rt = loadPlugin(plugin(`
        if (ctx.settings.get('MODE') === 'set') ctx.cache.set('k', 1, 3 * 86400);
        return { primary: { usedPercent: ctx.cache.get('k') === 1 ? 50 : 0 } };`), { transport: fixture(() => ({ body: '{}' })).transport });
      const read = (mode: string) => rt.read({ secrets: { API_KEY: SECRET }, settings: { MODE: mode } });
      expect((await read('set')).reading.windows[0].usedPercent).toBe(50);
      vi.setSystemTime(Date.UTC(2026, 9, 18, 13)); // +25 h
      expect((await read('get')).reading.windows[0].usedPercent).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A1 plugin host — manifest', () => {
  const bad: Array<[string, string]> = [
    ['id: "Bad_ID", name: "x", endpoints: ["https://a.test"], settings: []', 'provider id'],
    ['id: "x", name: "x", endpoints: ["http://a.test"], settings: []', 'HTTPS origin'],
    ['id: "x", name: "x", endpoints: ["https://a.test/path"], settings: []', 'HTTPS origin'],
    ['id: "x", name: "x", endpoints: [], settings: []', 'endpoints'],
    ['id: "x", name: "x", endpoints: ["https://a.test"], settings: [{ key: "K", title: "k", type: "plain" }], auth: { type: "bearer", secret: "K" }', 'secure setting'],
    ['id: "x", name: "x", endpoints: ["https://a.test"], settings: [{ key: "K", title: "k" }], auth: { type: "magic", secret: "K" }', 'unsupported auth type'],
    ['id: "x", name: "x", endpoints: ["https://a.test", { setting: "U", policy: "https" }], settings: [{ key: "U", title: "u", type: "secure" }]', 'plain setting'],
    ['id: "x", name: "x", endpoints: ["https://a.test"], settings: [], cookieDomains: ["a.test"]', 'browser-cookies'],
    ['id: "x", name: "x", endpoints: ["https://a.test"], settings: [], capabilities: ["browser-cookies"]', 'cookie domain'],
    ['id: "x", name: "x", endpoints: ["https://a.test"], settings: [{ key: "K", title: "k", type: "magic" }]', 'setting type'],
  ];
  it.each(bad)('rejects %s', (def, message) => {
    expect(() => loadPlugin(`defineProvider({ ${def}, async fetchUsage() {} });`, {})).toThrow(message);
  });
  it('a script that never calls defineProvider fails to load', () => {
    expect(() => loadPlugin('1 + 1;', {})).toThrow('defineProvider');
  });
  it('parses auth header kinds', () => {
    const scheme = loadPlugin(`defineProvider({ id: "x", name: "x", endpoints: ["https://a.test"],
      settings: [{ key: "K", title: "k" }], auth: { type: "authorization-scheme", scheme: "Token", secret: "K" },
      async fetchUsage() {} });`, {});
    expect(scheme.manifest.auth).toMatchObject({ type: 'authorization-scheme', header: 'Authorization', scheme: 'Token' });
    const custom = loadPlugin(`defineProvider({ id: "x", name: "x", endpoints: ["https://a.test"],
      settings: [{ key: "K", title: "k" }], auth: { type: "header", header: "X-Key", secret: "K" },
      async fetchUsage() {} });`, {});
    expect(custom.manifest.auth.header).toBe('X-Key');
  });
});

describe('A1 plugin host — ctx', () => {
  it('every ctx call works as documented', async () => {
    const logs: unknown[] = [];
    const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'u1', exp: 5 })).toString('base64url')}.sig`;
    const { transport, requests } = fixture(req => {
      if (req.url.endsWith('/json')) return { body: JSON.stringify({ used: 30, limit: 120 }) };
      if (req.url.endsWith('/html')) return { body: '<meta property="og:plan" content="Gold"><b id="n">42</b>', headers: { 'content-type': 'text/html' } };
      if (req.url.endsWith('/post-json')) return { body: JSON.stringify({ echo: JSON.parse(req.body ?? 'null') }) };
      if (req.url.endsWith('/post')) return { status: 418, body: 'teapot' };
      if (req.url.startsWith('http://127.0.0.1:8080')) return { body: '{"local":true}' };
      return { status: 404, body: '{}' };
    });
    const src = plugin(`
      const j = await ctx.http.getJSON("https://api.fixture.test/json");
      const h = await ctx.http.get("https://api.fixture.test/html", { timeoutSeconds: 3 });
      const pj = await ctx.http.postJSON("https://api.fixture.test/post-json", { body: { a: 1 } });
      const p = await ctx.http.post("https://api.fixture.test/post", { body: {} });
      const local = await ctx.http.getJSON(ctx.settings.get("BASE_URL") + "/x");
      ctx.cache.set("k", { v: 7 }, 999999);
      const cached = ctx.cache.get("k");
      const cookie = await ctx.browser.cookieHeader("fixture.test");
      ctx.log("key is", ${JSON.stringify(SECRET)}, { cookie });
      const fails = Object.keys(ctx.fail).sort().map(k => k.slice(0, 4)).join(",");
      const classified = ctx.fail.rateLimited("slow", { retryAfterSeconds: 3 }).message;
      const reset = ctx.date.nextDailyReset("America/New_York", 9);
      return {
        primary: { usedPercent: ctx.pct(j.json.used, j.json.limit), windowMinutes: 300, resetsAt: reset },
        secondary: { usedPercent: ctx.pct(1, 0), resetsAt: ctx.date.iso("2026-10-20T00:00:00Z") },
        tertiary: { usedPercent: 5, resetsAt: ctx.date.unixSeconds(1790000000) },
        extraWindows: [{ id: "fixture-extra", title: "Extra", window: { usedPercent: 2, resetsAt: ctx.date.unixMillis(1790000000000) } }],
        details: [{ title: "ctx", rows: [
          { label: "meta", value: String(ctx.html.metaContent(h.bodyText, "og:plan")) },
          { label: "match", value: String(ctx.html.matchFirst(h.bodyText, '<b id="n">(\\\\d+)</b>')) },
          { label: "postJSON", value: JSON.stringify(pj.json) },
          { label: "post", value: p.status + ":" + p.bodyText },
          { label: "local", value: String(local.json.local) },
          { label: "cache", value: String(cached && cached.v) },
          { label: "cookieLen", value: String(cookie.length) },
          { label: "fails", value: fails },
          { label: "classified", value: classified },
          { label: "now", value: String(ctx.date.now().getTime() === ctx.date.nowMillis()) },
          { label: "jwt", value: ctx.jwt.decode(${JSON.stringify(jwt)}).sub },
          { label: "number", value: ctx.format.number(1234.5, { maximumFractionDigits: 0 }) },
          { label: "tz", value: ctx.env.timeZone },
        ] }],
      };`);
    const rt = loadPlugin(src, { transport, log: (line: unknown) => logs.push(line), cookieSource: async () => 'sess=abc123' });
    const { reading, error } = await rt.read({
      secrets: { API_KEY: SECRET }, settings: { BASE_URL: 'http://127.0.0.1:8080' },
      now: Date.UTC(2026, 2, 8, 3), timeZone: 'UTC',
    });
    expect(error).toBeUndefined();
    expect(reading.windows).toEqual([
      { limitId: 'fixture-primary', usedPercent: 25, windowDurationMins: 300, resetsAt: '2026-03-08T13:00:00.000Z' },
      { limitId: 'fixture-secondary', usedPercent: 100, windowDurationMins: null, resetsAt: '2026-10-20T00:00:00.000Z' },
      { limitId: 'fixture-tertiary', usedPercent: 5, windowDurationMins: null, resetsAt: new Date(1790000000000).toISOString() },
      { limitId: 'fixture-extra', usedPercent: 2, windowDurationMins: null, resetsAt: new Date(1790000000000).toISOString() },
    ]);
    const rows = Object.fromEntries(reading.details[0].rows.map((r: { label: string; value: string }) => [r.label, r.value]));
    expect(rows).toMatchObject({
      meta: 'Gold', match: '42', postJSON: '{"echo":{"a":1}}', post: '418:teapot', local: 'true', cache: '7',
      cookieLen: '11', fails: 'apiF,auth,miss,netw,pars,perm,prov,rate',
      classified: '__CODEXBAR_FAILURE_V2__:rate-limited:3:slow', now: 'true', jwt: 'u1', number: '1,235', tz: 'UTC',
    });
    expect(requests.map(r => [r.method, r.timeoutSeconds])).toEqual([['GET', 15], ['GET', 3], ['POST', 15], ['POST', 15], ['GET', 15]]);
    expect(header(requests[0], 'Accept')).toBe('application/json');
    expect(header(requests[2], 'Content-Type')).toBe('application/json');
    expect(requests[2].body).toBe('{"a":1}');
    // ctx.log: provider category, secret and cookie value redacted.
    expect(JSON.stringify(logs)).toContain('fixture-plugin');
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain('abc123');
  });

  it('settings: undeclared keys and kind mismatches throw', async () => {
    for (const call of ['ctx.settings.get("NOPE")', 'ctx.settings.getSecret("MODE")', 'ctx.settings.get("API_KEY")']) {
      const { reading, error } = await run(plugin(`${call}; return { primary: { usedPercent: 1 } };`), fixture(() => ({ body: '{}' })).transport);
      expect(reading).toEqual({ status: 'unavailable', reason: 'plugin:script' });
      expect(error.message).toMatch(/is not declared/);
    }
  });

  it('cookies: undeclared domain refused; default cookie source is unavailable', async () => {
    const t = fixture(() => ({ body: '{}' })).transport;
    const undeclared = await run(plugin('await ctx.browser.cookieHeader("evil.test"); return { primary: { usedPercent: 1 } };'), t, { cookieSource: async () => 'a=b' });
    expect(undeclared.reading.reason).toBe('plugin:secret-access');
    expect(undeclared.error.message).toContain('cookie domain is not declared');
    const off = await run(plugin('return { primary: { usedPercent: 1 }, details: [{ rows: [{ label: "a", value: ctx.browser.availability("fixture.test") }] }] };'), t);
    expect(off.reading.details[0].rows[0].value).toBe('off');
    const unavailable = await run(plugin('await ctx.browser.cookieHeader("fixture.test"); return { primary: { usedPercent: 1 } };'), t);
    expect(unavailable.reading.reason).toBe('plugin:secret-access');
    const noCap = loadPlugin(`defineProvider({ id: "x", name: "x", endpoints: ["https://a.test"], settings: [],
      async fetchUsage(ctx) { await ctx.browser.cookieHeader("a.test"); return { primary: { usedPercent: 1 } }; } });`,
    { transport: t, cookieSource: async () => 'a=b' });
    expect((await noCap.read({})).reading.reason).toBe('plugin:secret-access');
  });

  it('non-manifest URLs are refused before the transport is called', async () => {
    for (const url of ['https://evil.test/x', 'http://api.fixture.test/x', 'https://user:pw@api.fixture.test/x', 'http://10.0.0.5:8080/x']) {
      const { transport, requests } = fixture(() => ({ body: '{}' }));
      const { reading, error } = await run(plugin(`await ctx.http.get(${JSON.stringify(url)}); return { primary: { usedPercent: 1 } };`),
        transport, { settings: { BASE_URL: 'http://127.0.0.1:8080' } });
      expect(reading.reason, url).toBe('plugin:network-policy');
      expect(error.message).toMatch(/network policy/);
      expect(requests).toHaveLength(0);
    }
  });

  it('a setting endpoint with a non-loopback http origin is refused', async () => {
    const { transport, requests } = fixture(() => ({ body: '{}' }));
    const { reading } = await run(plugin('await ctx.http.get(ctx.settings.get("BASE_URL")); return { primary: { usedPercent: 1 } };'),
      transport, { settings: { BASE_URL: 'http://example.test' } });
    expect(reading.reason).toBe('plugin:network-policy');
    expect(requests).toHaveLength(0);
  });

  it('redirects: same-origin HTTPS followed; cross-origin and downgrade refused (the 3xx reaches the plugin)', async () => {
    const make = (location: string) => fixture(req => req.url.endsWith('/start')
      ? { status: 302, body: '', headers: { location } } : { body: '{"done":1}' });
    const src = plugin('const r = await ctx.http.get("https://api.fixture.test/start"); return { primary: { usedPercent: r.status === 200 ? 50 : 10 } };');
    const same = make('/next');
    expect((await run(src, same.transport)).reading.windows[0].usedPercent).toBe(50);
    expect(same.requests.map(r => r.url)).toEqual(['https://api.fixture.test/start', 'https://api.fixture.test/next']);
    expect(header(same.requests[1], 'Authorization')).toBe(`Bearer ${SECRET}`);
    for (const location of ['https://evil.test/steal', 'http://api.fixture.test/next', 'https://api.fixture.test:8443/next']) {
      const other = make(location);
      expect((await run(src, other.transport)).reading.windows[0].usedPercent, location).toBe(10);
      expect(other.requests, location).toHaveLength(1);
    }
  });

  it('manifest auth header is injected and cannot be overridden', async () => {
    const { transport, requests } = fixture(() => ({ body: '{}' }));
    await run(plugin('await ctx.http.get("https://api.fixture.test/a"); return { primary: { usedPercent: 1 } };'), transport);
    expect(header(requests[0], 'Authorization')).toBe(`Bearer ${SECRET}`);
    for (const name of ['Authorization', 'authorization', 'AUTHORIZATION']) {
      const t = fixture(() => ({ body: '{}' }));
      const { reading } = await run(plugin(`await ctx.http.get("https://api.fixture.test/a", { headers: { ${JSON.stringify(name)}: "Bearer stolen" } });
        return { primary: { usedPercent: 1 } };`), t.transport);
      expect(reading.reason, name).toBe('plugin:network-policy');
      expect(t.requests).toHaveLength(0);
    }
  });

  it('a missing auth secret fails before any request', async () => {
    const { transport, requests } = fixture(() => ({ body: '{}' }));
    const { reading } = await loadPlugin(plugin('return { primary: { usedPercent: 1 } };'), { transport }).read({ secrets: {} });
    expect(reading.reason).toBe('plugin:secret-access');
    expect(requests).toHaveLength(0);
  });

  it('responses over 5 MiB are refused; exactly 5 MiB is accepted', async () => {
    expect(MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
    const src = plugin('const r = await ctx.http.get("https://api.fixture.test/big"); return { primary: { usedPercent: r.bodyText.length > 0 ? 1 : 0 } };');
    const ok = await run(src, fixture(() => ({ body: new Uint8Array(MAX_RESPONSE_BYTES).fill(97) })).transport);
    expect(ok.reading.status).toBe('ok');
    const big = await run(src, fixture(() => ({ body: new Uint8Array(MAX_RESPONSE_BYTES + 1).fill(97) })).transport);
    expect(big.reading.reason).toBe('plugin:http');
    expect(big.error.message).toContain('5242880-byte limit');
  });

  it('timeoutSeconds must be 1-90', async () => {
    for (const value of ['0', '91', 'true', '"15"']) {
      const t = fixture(() => ({ body: '{}' }));
      const { reading } = await run(plugin(`await ctx.http.get("https://api.fixture.test/a", { timeoutSeconds: ${value} }); return { primary: { usedPercent: 1 } };`), t.transport);
      expect(reading.reason, value).toBe('plugin:http');
      expect(t.requests).toHaveLength(0);
    }
  });

  it('secret values are redacted from thrown errors', async () => {
    const { reading, error } = await run(plugin(`throw new Error("bad key " + ctx.settings.getSecret("API_KEY"));`), fixture(() => ({ body: '{}' })).transport);
    expect(reading).toEqual({ status: 'unavailable', reason: 'plugin:script' });
    expect(error.message).toContain('<redacted>');
    expect(error.message).not.toContain(SECRET);
    const classified = await run(plugin(`throw ctx.fail.authenticationExpired("rejected " + ${JSON.stringify(SECRET)});`), fixture(() => ({ body: '{}' })).transport);
    expect(classified.reading.reason).toBe('plugin:authentication-expired');
    expect(classified.error.message).not.toContain(SECRET);
  });
});

describe('A1 plugin host — watchdog', () => {
  afterEach(() => vi.useRealTimers());
  it('a fetchUsage unsettled after 20 s times out and its context is discarded', async () => {
    vi.useFakeTimers();
    const src = plugin(`
      calls += 1;
      if (ctx.settings.get("MODE") === "hang") await new Promise(() => {});
      return { primary: { usedPercent: calls } };`).replace('defineProvider(', 'let calls = 0; defineProvider(');
    const { transport } = fixture(() => new Promise<Res>(() => {}));
    const rt = loadPlugin(src, { transport });
    const hung = rt.read({ secrets: { API_KEY: SECRET }, settings: { MODE: 'hang' } });
    await vi.advanceTimersByTimeAsync(19_999);
    let settled = false;
    void hung.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await hung;
    expect(result.reading).toEqual({ status: 'unavailable', reason: 'plugin:timeout' });
    // A fresh context: module state restarted, so the counter is 1, not 2.
    const next = await rt.read({ secrets: { API_KEY: SECRET } });
    expect(next.reading.windows[0].usedPercent).toBe(1);
  });
});

describe('A1 plugin host — result mapper', () => {
  const now = Date.UTC(2026, 9, 17);
  const map = (value: unknown) => mapPluginResult(value, { now });
  it('clamps percentages and validates bounds with the property path', () => {
    expect(map({ primary: { usedPercent: 150 }, secondary: { usedPercent: -5 } }).usage.primary.usedPercent).toBe(100);
    expect(map({ primary: { usedPercent: 150 }, secondary: { usedPercent: -5 } }).usage.secondary.usedPercent).toBe(0);
    const cases: Array<[unknown, string]> = [
      [{ primary: { usedPercent: 'x' } }, 'primary.usedPercent must be a number'],
      [{ primary: { usedPercent: Infinity } }, 'primary.usedPercent must be finite'],
      [{ primary: { usedPercent: 1, windowMinutes: 1.5 } }, 'primary.windowMinutes must be a positive integer'],
      [{ primary: { usedPercent: 1, windowMinutes: 0 } }, 'primary.windowMinutes must be a positive integer'],
      [{ primary: { usedPercent: 1, resetsAt: 'soon' } }, 'primary.resetsAt is not a valid ISO-8601 date'],
      [{ primary: { usedPercent: 1 }, dataConfidence: 5 }, 'dataConfidence must be'],
      [{ primary: { usedPercent: 1 }, bogus: 1 }, 'usage contains unknown keys'],
      [{ cost: { used: 1, currency: 'usd' } }, 'cost.currency must be a three-letter uppercase'],
      [{ details: Array.from({ length: 9 }, () => ({ rows: [] })) }, 'details exceeds 8 entries'],
      [{ details: [{ rows: [{ label: 'x'.repeat(121), value: 'v' }] }] }, 'details[0].rows[0].label exceeds 120 characters'],
      [{ extraWindows: [{ id: 'e', window: { usedPercent: 1 } }] }, 'extraWindows[0].title is required'],
      [{ identity: { email: 'x'.repeat(257) } }, 'identity.email exceeds 256 UTF-8 bytes'],
      [{}, 'snapshot must contain'],
      [[], 'must be an object'],
    ];
    for (const [value, message] of cases) expect(() => map(value), message).toThrow(message);
  });
  it('envelope vs bare snapshot', () => {
    expect(map({ usage: { primary: { usedPercent: 3 } }, sourceLabel: 'oauth+web' })).toMatchObject({ sourceLabel: 'oauth+web', usage: { primary: { usedPercent: 3 } } });
    expect(map({ primary: { usedPercent: 3 } }).sourceLabel).toBeNull();
    expect(() => map({ usage: { primary: { usedPercent: 3 } }, primary: { usedPercent: 3 } })).toThrow('result contains unknown keys');
    expect(() => map({ usage: { primary: { usedPercent: 3 } }, sourceLabel: '' })).toThrow('sourceLabel must contain 1-256 bytes');
    expect(() => map({ usage: { primary: { usedPercent: 3 } }, card: {} })).toThrow('card is not allowed');
    expect(() => map({ usage: { primary: { usedPercent: 3 } }, persist: { ACCOUNT_SLUG: 'x' } })).toThrow('persist contains an unapproved setting');
    expect(map({ empty: true }).usage.empty).toBe(true);
  });
  it('identity is returned separately and never inside the reading', async () => {
    const src = plugin('return { primary: { usedPercent: 4 }, identity: { email: " ada@example.com ", organization: "Org", loginMethod: "Pro", accountID: "acct-9" } };');
    const result = await run(src, fixture(() => ({ body: '{}' })).transport);
    expect(result.identity).toEqual({ email: 'ada@example.com', organization: 'Org', loginMethod: 'Pro', accountID: 'acct-9' });
    expect(Object.keys(result.reading).sort()).toEqual(['source', 'status', 'updatedAt', 'windows']);
    const text = JSON.stringify(result.reading);
    for (const leak of ['ada@example.com', 'Org', 'acct-9', 'Pro']) expect(text).not.toContain(leak);
  });
});

describe('A1 plugin host — settings source', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  it('env first, then the config file (path from OCLI_USAGE_READERS_CONFIG); secure values become secrets', () => {
    dir = mkdtempSync(join(tmpdir(), 'a1-settings-'));
    const file = join(dir, 'usage-readers.json');
    writeFileSync(file, JSON.stringify({ fixture: { API_KEY: 'from-file', BASE_URL: 'https://file.test', MODE: 7 }, other: { MODE: 'x' } }));
    const rt = loadPlugin(plugin('return {};'), {});
    const env = { OCLI_USAGE_READERS_CONFIG: file, BASE_URL: ' https://env.test ' };
    expect(resolvePluginSettings(rt.manifest, { env })).toEqual({ settings: { BASE_URL: 'https://env.test' }, secrets: { API_KEY: 'from-file' } });
    expect(resolvePluginSettings(rt.manifest, { env: { OCLI_USAGE_READERS_CONFIG: join(dir, 'missing.json') } })).toEqual({ settings: {}, secrets: {} });
  });
  it('readPluginUsage resolves settings from the injected env and reads a bundled plugin', async () => {
    dir = mkdtempSync(join(tmpdir(), 'a1-read-'));
    const { transport, requests } = fixture(() => ({ body: '{"data":{"limits":[{"type":"weekly","percentUsed":40}]},"success":true}' }));
    const result = await readPluginUsage('clinepass', { env: { CLINE_API_KEY: 'env-key', OCLI_USAGE_READERS_CONFIG: join(dir, 'none.json') }, transport });
    expect(result.reading.windows).toEqual([{ limitId: 'clinepass-secondary', usedPercent: 40, windowDurationMins: 10080, resetsAt: null }]);
    expect(header(requests[0], 'Authorization')).toBe('Bearer env-key');
  });
});

// ---- Bundled plugins against fixtures ported from CodexBar's own tests (Tests/CodexBarTests @ 6480977) ----

describe('zai.js (ZaiProviderTests)', () => {
  const quotaFixture = `{"code":200,"msg":"success","success":true,"data":{"planName":"Pro","limits":[
    {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},
    {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":9,"nextResetTime":1786291200000},
    {"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"currentValue":224,"remaining":776,
     "percentage":22,"usageDetails":[{"modelCode":"search-prime","usage":210}]}]}}`;
  const modelUsageFixture = `{"code":200,"msg":"success","success":true,"data":{
    "x_time":["2026-08-02 08:00","2026-08-02 09:00"],
    "modelDataList":[{"modelName":"glm-4.6","tokensUsage":[100,null]},{"modelName":"glm-4.5","tokensUsage":[50,25]}]}}`;
  const emptyModelUsage = '{"code":200,"msg":"success","success":true,"data":{"x_time":[],"modelDataList":[]}}';
  const largeModelUsage = `{"code":200,"msg":"success","success":true,"data":{
    "x_time":["2026-08-02 08:00","2026-08-02 09:00"],
    "modelDataList":[{"modelName":"Example Large","tokensUsage":[5000000000,300000000]},
    {"modelName":"Example Medium","tokensUsage":[400000000,91075408]},
    {"modelName":"Example Small","tokensUsage":[70000000,6124317]},
    {"modelName":"Example Exact","tokensUsage":[500000,499999]}]}}`;
  async function zai(quota: string, analytics = modelUsageFixture, settings: Record<string, string> = { Z_AI_REGION: 'global', Z_AI_USAGE_SCOPE: 'personal' }) {
    const f = fixture(req => ({ body: new URL(req.url).pathname.endsWith('/quota/limit') || req.url.includes('custom-quota') ? quota : analytics }));
    const result = await loadBundledPlugin('zai', { transport: f.transport }).read({ settings, secrets: { Z_AI_API_KEY: 'fixture-key' }, now: 1_785_816_000_000 });
    return { ...result, requests: f.requests as Req[] };
  }
  const titles = (r: { details?: Array<{ title?: string }> }) => (r.details ?? []).map(d => d.title);
  const row = (r: { details?: Array<{ rows: Array<{ label: string; value: string; secondaryValue?: string }> }> }, label: string) =>
    (r.details ?? []).flatMap(d => d.rows).find(x => x.label === label);

  it('maps quota and model usage into stable windows and details', async () => {
    const { reading, identity, requests } = await zai(quotaFixture);
    expect(reading.windows).toEqual([
      { limitId: 'zai-primary', usedPercent: 25, windowDurationMins: 300, resetsAt: new Date(1785816000000).toISOString() },
      { limitId: 'zai-secondary', usedPercent: 9, windowDurationMins: 10080, resetsAt: new Date(1786291200000).toISOString() },
      { limitId: 'zai-mcp', usedPercent: expect.closeTo(22.4, 9), windowDurationMins: 43200, resetsAt: null },
    ]);
    expect(identity).toEqual({ loginMethod: 'Pro' });
    expect(titles(reading)).toEqual(['Quota details', 'Hourly tokens', 'Daily tokens']);
    expect(header(requests[0], 'Authorization')).toBe('Bearer fixture-key');
    expect(requests[0].url).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
  });
  it.each(['', '{"type":"FUTURE_LIMIT","unit":3,"number":5,"percentage":40}', '{"type":"FUTURE_POINTS_POOL","pointsRemaining":800}'])(
    'missing recognized limits never fabricate unused quota (%s)', async limits => {
      for (const analytics of [emptyModelUsage, modelUsageFixture]) {
        const { reading, identity } = await zai(`{"code":200,"success":true,"data":{"planName":"Pro","limits":[${limits}]}}`, analytics);
        expect(reading.windows).toEqual([]);
        expect(identity.loginMethod).toBe('Pro');
        expect(row(reading, 'Coding Plan usage')?.value).toBe('Unavailable');
        expect(row(reading, 'Coding Plan usage')?.secondaryValue).toContain('Usage Dashboard');
        expect(titles(reading)).toEqual(analytics === emptyModelUsage ? ['Quota details'] : ['Quota details', 'Hourly tokens', 'Daily tokens']);
      }
    });
  it.each(['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'])('explicit zero usage remains a real quota window (%s)', async type => {
    const { reading } = await zai(`{"code":200,"success":true,"data":{"limits":[{"type":"${type}","unit":3,"number":5,"percentage":0}]}}`);
    expect(reading.windows).toEqual([{ limitId: 'zai-primary', usedPercent: 0, windowDurationMins: 300, resetsAt: null }]);
    expect(row(reading, 'Coding Plan usage')).toBeUndefined();
  });
  it('unsupported plan pool preserves known MCP; unknown extras mark only additional quota', async () => {
    const mcp = await zai('{"code":200,"success":true,"data":{"limits":[{"type":"FUTURE_POINTS_POOL","pointsRemaining":800},{"type":"TIME_LIMIT","unit":5,"number":1,"percentage":25}]}}');
    expect(mcp.reading.windows[0]).toMatchObject({ limitId: 'zai-primary', usedPercent: 25 });
    expect(row(mcp.reading, 'Coding Plan usage')?.value).toBe('Unavailable');
    const extra = await zai('{"code":200,"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25},{"type":"FUTURE_POINTS_POOL","pointsRemaining":800}]}}');
    expect(extra.reading.windows[0].usedPercent).toBe(25);
    expect(row(extra.reading, 'Coding Plan usage')).toBeUndefined();
    expect(row(extra.reading, 'Additional quota')?.value).toBe('Unavailable');
  });
  it.each(['{"pointsPool":{"remaining":800}}', '{"limits":[{"unit":3,"number":5,"percentage":25}]}',
    '{"limits":[{"type":null,"unit":3,"number":5,"percentage":25}]}', '{"limits":[{"type":42,"unit":3,"number":5,"percentage":25}]}'])(
    'unsupported quota shapes explain where to check usage (%s)', async data => {
      const { reading, error } = await zai(`{"code":200,"success":true,"data":${data}}`);
      expect(reading.status).toBe('unavailable');
      expect(error.message).toContain('Usage Dashboard');
    });
  it('unrenderable optional analytics preserve required quota', async () => {
    for (const [count, name, label] of [[121, 'Example', 'hour'], [1, 'x'.repeat(121), 'hour'], [1, 'Example', 'x'.repeat(121)],
      [1, '  ', 'hour'], [1, 'Example', '  '], [1, '\u0085​', 'hour'], [1, 'Example', '\u0085​']] as Array<[number, string, string]>) {
      const analytics = JSON.stringify({ code: 200, success: true, data: { x_time: Array(count).fill(label), modelDataList: [{ modelName: name, tokensUsage: Array(count).fill(1) }] } });
      const { reading, identity } = await zai(quotaFixture, analytics);
      expect(reading.windows.slice(0, 2).map((w: { usedPercent: number }) => w.usedPercent)).toEqual([25, 9]);
      expect(identity.loginMethod).toBe('Pro');
      expect(titles(reading)).toEqual(['Quota details']);
    }
  });
  it.each(['x'.repeat(120), 'é'.repeat(120), '👩‍👩‍👧‍👦'.repeat(120)])('analytics at the chart and label bounds remain complete', async name => {
    const analytics = JSON.stringify({ code: 200, success: true, data: { x_time: Array.from({ length: 120 }, (_, i) => `hour-${i}`), modelDataList: [{ modelName: name, tokensUsage: Array(120).fill(1) }] } });
    const { reading } = await zai(quotaFixture, analytics);
    for (const title of ['Hourly tokens', 'Daily tokens']) {
      const section = reading.details.find((d: { title: string }) => d.title === title);
      expect(section.rows[0]).toMatchObject({ label: name, value: '120' });
      expect(section.chart.points).toHaveLength(120);
    }
  });
  it('overflowing optional model aggregates preserve quota', async () => {
    const { reading } = await zai(quotaFixture, '{"code":200,"success":true,"data":{"x_time":["hour"],"modelDataList":[{"modelName":"Example A","tokensUsage":[1e308]},{"modelName":"Example B","tokensUsage":[1e308]}]}}');
    expect(titles(reading)).toEqual(['Quota details']);
  });
  it('compacts large model token totals without changing chart values', async () => {
    const { reading } = await zai(quotaFixture, largeModelUsage);
    for (const title of ['Hourly tokens', 'Daily tokens']) {
      const section = reading.details.find((d: { title: string }) => d.title === title);
      expect(section.rows.map((r: { label: string }) => r.label)).toEqual(['Example Large', 'Example Medium', 'Example Small', 'Example Exact']);
      expect(section.rows.map((r: { value: string }) => r.value)).toEqual(['5.3B', '491M', '76.1M', '999999']);
      expect(section.chart).toEqual({ kind: 'bars', title, unit: 'tokens', points: [{ label: '2026-08-02 08:00', value: 5_470_500_000 }, { label: '2026-08-02 09:00', value: 397_699_724 }] });
    }
  });
  it('MCP duration: explicit kept, unknown cadence unset; rolling 30-day limits', async () => {
    const explicit = await zai('{"code":200,"msg":"success","success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},{"type":"TIME_LIMIT","unit":3,"number":5,"percentage":22,"nextResetTime":1785816000000}]}}');
    expect(explicit.reading.windows.find((w: { limitId: string }) => w.limitId === 'zai-mcp').windowDurationMins).toBe(300);
    const unknown = await zai('{"code":200,"msg":"success","success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},{"type":"TIME_LIMIT","unit":0,"number":1,"percentage":22,"nextResetTime":1785816000000}]}}');
    expect(unknown.reading.windows.find((w: { limitId: string }) => w.limitId === 'zai-mcp').windowDurationMins).toBeNull();
    for (const type of ['TOKENS_LIMIT', 'CREDIT_LIMIT']) {
      const rolling = await zai(`{"code":200,"msg":"success","success":true,"data":{"limits":[{"type":"${type}","unit":1,"number":30,"percentage":50,"nextResetTime":1787112000000}]}}`);
      expect(rolling.reading.windows[0].windowDurationMins).toBe(43200);
    }
  });
  it('team scope projects validated endpoint overrides', async () => {
    const { requests } = await zai(quotaFixture, emptyModelUsage, {
      Z_AI_REGION: 'global', Z_AI_USAGE_SCOPE: 'team', Z_AI_ORGANIZATION: 'org-fixture', Z_AI_PROJECT: 'project-fixture',
      Z_AI_QUOTA_ENDPOINT: 'https://zai-proxy.test/custom-quota?keep=1&type=9', Z_AI_MODEL_USAGE_ENDPOINT: 'https://zai-proxy.test/custom-model',
    });
    const quota: Req = requests.find((r: Req) => new URL(r.url).pathname === '/custom-quota')!;
    expect(new URL(quota.url).search).toContain('keep=1');
    expect(new URL(quota.url).search).toContain('type=2');
    expect(new URL(quota.url).search).not.toContain('type=9');
    expect(header(quota, 'Bigmodel-Organization')).toBe('org-fixture');
    expect(header(quota, 'Bigmodel-Project')).toBe('project-fixture');
    expect(requests.filter((r: Req) => new URL(r.url).pathname === '/custom-model')).toHaveLength(2);
  });
});

describe('muse.js (MusePluginTests)', () => {
  const account = `{"api_key":"LLM|fixture-inference-key", "payment_method":"Visa-0000",
    "require_payment":false, "is_subs_active":true, "user_email":"ada@example.com", "subs_tier_name":"Muse Code Power Usage",
    "subs_usage":{"window":{"used_percent":96,"window_duration_mins":300,"resets_at":1788599502},"weekly":{"used_percent":40,"resets_at":1788739200}}}`;
  const activeWithoutWindows = '{"is_subs_active":true,"user_email":"ada@example.com","subs_tier_name":"Muse Code Power Usage"}';
  const activeWithNullWindows = '{"is_subs_active":true, "user_email":"ada@example.com", "subs_tier_name":"Muse Code Power Usage", "subs_usage":null}';
  const iso = (s: number) => new Date(s * 1000).toISOString();
  async function muse(body: string, status = 200, token = 'dca:fixture-token') {
    const f = fixture(() => ({ body, status }));
    const result = await loadBundledPlugin('muse', { transport: f.transport }).read({ secrets: { MUSE_DEVICE_TOKEN: token }, now: 1_788_580_000_000 });
    return { ...result, requests: f.requests as Req[] };
  }
  it('reported subscription windows retain their identity and resets', async () => {
    const { reading, identity } = await muse(account);
    expect(reading.windows).toEqual([
      { limitId: 'muse-primary', usedPercent: 96, windowDurationMins: 300, resetsAt: iso(1788599502) },
      { limitId: 'muse-secondary', usedPercent: 40, windowDurationMins: 10080, resetsAt: iso(1788739200) },
    ]);
    expect(identity).toEqual({ email: 'ada@example.com', loginMethod: 'Muse Code Power Usage' });
    expect(JSON.stringify(reading)).not.toMatch(/Visa|LLM\||ada@example\.com/);
  });
  it('JSON request sends only the device credential and fixed API version', async () => {
    const { requests } = await muse(account);
    expect(requests[0]).toMatchObject({ url: 'https://api.meta.ai/muse-code/key', method: 'POST', body: '{}', timeoutSeconds: 15 });
    expect(header(requests[0], 'Authorization')).toBe('Bearer dca:fixture-token');
    expect(header(requests[0], 'x-api-version')).toBe('1.0.0');
    expect(header(requests[0], 'Content-Type')).toBe('application/json');
  });
  it('inference keys never reach the mint endpoint', async () => {
    const { reading, requests } = await muse(account, 200, 'LLM|fixture-token');
    expect(reading.reason).toBe('plugin:authentication-expired');
    expect(requests).toHaveLength(0);
  });
  it.each(['{}', '<html>Sign in</html>', ''])('unauthorized responses retain login recovery (%s)', async body => {
    expect((await muse(body, 401)).reading.reason).toBe('plugin:authentication-expired');
  });
  it.each(['{"require_payment":true,"is_subs_active":false}', '{"is_subs_active":false,"subs_usage":null}'])('inactive subscriptions never invent quotas', async body => {
    expect((await muse(body)).reading.reason).toBe('plugin:permission-denied');
  });
  it.each([activeWithoutWindows, activeWithNullWindows])('active login without quota windows keeps plan identity', async body => {
    const { reading, identity } = await muse(body);
    expect(reading.windows).toEqual([]);
    expect(identity).toEqual({ email: 'ada@example.com', loginMethod: 'Muse Code Power Usage' });
    const rows = reading.details.flatMap((d: { rows: unknown[] }) => d.rows);
    expect(rows).toContainEqual({ label: 'Plan', value: 'Muse Code Power Usage' });
    expect(rows.find((r: { label: string }) => r.label === 'Quota').value).toContain('login response');
  });
  it('non-object quota payload and invalid durations are parse failures', async () => {
    expect((await muse('{"is_subs_active":true,"subs_usage":"window"}')).reading.reason).toBe('plugin:parse-failure');
    for (const value of ['1e30', '0', '-1', 'true', '"300"'])
      expect((await muse(account.replace('"window_duration_mins":300', `"window_duration_mins":${value}`))).reading.reason, value).toBe('plugin:parse-failure');
  });
  it('unrepresentable resets preserve reported usage', async () => {
    const { reading } = await muse(account.replace('1788599502', '1e30'));
    expect(reading.windows[0]).toMatchObject({ usedPercent: 96, resetsAt: null });
    expect(reading.windows[1].resetsAt).not.toBeNull();
  });

  const now = 1_790_341_873;
  const teamID = '424242424242';
  const quota = (windowUsed = '0', windowResetsAt?: number) => `{"subscription_quota":{"tier_id":"1","tier":"Muse Code Power Usage","as_of":${now},`
    + '"window_weighted_limit":"20000000000","window_duration_secs":18000,'
    + `"weekly_weighted_limit":"60000000000","weekly_resets_at":1790553600,"window_weighted_used":"${windowUsed}","weekly_weighted_used":"9043782620"${windowResetsAt ? `,"window_resets_at":${windowResetsAt}` : ''}}}`;
  const web = (q: string) => (path: string): [string, number] => ({
    '/api/auth/me': ['{"userId":"1","email":"Ada@Example.com","accountType":"META_ACCOUNT"}', 200],
    '/api/portal/teams': ['{"teams":[{"team_id":424242424242,"team_name":"My Team"}]}', 200],
    [`/api/portal/teams/${teamID}/subscription-quota`]: [q, 200],
  } as Record<string, [string, number]>)[path] ?? ['{}', 404];
  async function museWeb(q: string, cookieSource?: (domain: string) => Promise<string>) {
    const f = fixture(req => {
      const u = new URL(req.url);
      if (u.host !== 'dev.meta.ai') return { body: activeWithoutWindows };
      const [body, status] = web(q)(u.pathname);
      return { body, status };
    });
    const result = await loadBundledPlugin('muse', { transport: f.transport, cookieSource })
      .read({ settings: { MUSE_WEB_TEAM_ID: teamID }, secrets: { MUSE_DEVICE_TOKEN: 'dca:fixture-token' }, now: now * 1000 });
    return { ...result, requests: f.requests as Req[] };
  }
  it('selected team quota fills omitted login quotas (browser session via the injected cookie source)', async () => {
    const { reading, sourceLabel, requests } = await museWeb(quota('4000000000', now + 3600), async () => 'llama_dev_sess=fixture');
    expect(sourceLabel).toBe('oauth+web');
    expect(reading.windows[0]).toEqual({ limitId: 'muse-primary', usedPercent: 20, windowDurationMins: 300, resetsAt: iso(now + 3600) });
    expect(reading.windows[1].limitId).toBe('muse-secondary');
    expect(Math.abs(reading.windows[1].usedPercent - 15.07297103)).toBeLessThan(0.0001);
    expect(reading.windows[1].resetsAt).toBe(iso(1790553600));
    const webRequests = requests.filter((r: Req) => new URL(r.url).host === 'dev.meta.ai');
    expect(webRequests.map((r: Req) => new URL(r.url).pathname)).toEqual(['/api/auth/me', '/api/portal/teams', `/api/portal/teams/${teamID}/subscription-quota`]);
    for (const r of webRequests) {
      expect(header(r, 'Cookie')).toBe('llama_dev_sess=fixture');
      expect(header(r, 'Authorization')).toBeUndefined();
      expect(r.timeoutSeconds).toBe(8);
    }
  });
  it('disabled browser cookies (the A1 default) never contact dev.meta.ai', async () => {
    const { reading, requests } = await museWeb(quota());
    expect(reading.windows).toEqual([]);
    expect(requests.some((r: Req) => new URL(r.url).host === 'dev.meta.ai')).toBe(false);
  });
});

describe('clinepass.js (ClinePassPluginTests)', () => {
  async function cline(body: string, status = 200, settings: Record<string, string> = {}, key = 'test-key') {
    const f = fixture(() => ({ body, status }));
    const result = await loadBundledPlugin('clinepass', { transport: f.transport }).read({ settings, secrets: { CLINE_API_KEY: key } });
    return { ...result, requests: f.requests as Req[] };
  }
  it('all rate-window fixture matches the production golden', async () => {
    const { reading, identity } = await cline(`{"data":{"limits":[
      { "type": "five_hour", "percentUsed": 12.5, "resetsAt": "2026-07-16T10:20:30Z" },
      { "type": "weekly", "percentUsed": 34, "resetsAt": "2026-07-20T00:00:00Z" },
      { "type": "monthly", "percentUsed": 56.75, "resetsAt": "2026-08-01T00:00:00Z" }]},"success": true}`);
    expect(reading.windows).toEqual([
      { limitId: 'clinepass-primary', usedPercent: 12.5, windowDurationMins: 300, resetsAt: '2026-07-16T10:20:30.000Z' },
      { limitId: 'clinepass-secondary', usedPercent: 34, windowDurationMins: 10080, resetsAt: '2026-07-20T00:00:00.000Z' },
      { limitId: 'clinepass-tertiary', usedPercent: 56.75, windowDurationMins: 43200, resetsAt: '2026-08-01T00:00:00.000Z' },
    ]);
    expect(identity).toEqual({ loginMethod: 'API key' });
  });
  it('unknown limits are ignored without dropping known windows', async () => {
    const { reading } = await cline(`{"success":true,"data":{"limits":[
      { "type": "five_hour", "percentUsed": 12.5, "resetsAt": "2026-07-16T15:00:00Z" },
      { "type": "experimental_pool", "percentUsed": 77, "resetsAt": "2026-07-16T15:00:00Z" },
      { "type": "weekly", "percentUsed": 25, "resetsAt": "2026-07-20T00:00:00Z" },
      { "type": "monthly", "percentUsed": 40, "resetsAt": null }]}}`);
    expect(reading.windows.map((w: { usedPercent: number }) => w.usedPercent)).toEqual([12.5, 25, 40]);
    expect(reading.windows[2].resetsAt).toBeNull();
  });
  it('request uses bearer auth and the production deadline', async () => {
    const { reading, requests } = await cline('{"data":{"limits":[{"type":"weekly","percentUsed":40}]},"success":true}');
    expect(requests[0]).toMatchObject({ url: 'https://api.cline.bot/api/v1/users/me/plan/usage-limits', method: 'GET', timeoutSeconds: 15 });
    expect(header(requests[0], 'Authorization')).toBe('Bearer test-key');
    expect(header(requests[0], 'Accept')).toBe('application/json');
    expect(reading.windows).toEqual([{ limitId: 'clinepass-secondary', usedPercent: 40, windowDurationMins: 10080, resetsAt: null }]);
  });
  it.each([[401, 'authentication-expired'], [403, 'authentication-expired'], [429, 'rate-limited'], [500, 'provider-unavailable']])(
    'HTTP %i preserves its classified surface', async (status, kind) => {
      const { reading, error } = await cline('{}', status as number);
      expect(reading.reason).toBe(`plugin:${kind}`);
      expect(error.message).toContain(status === 401 || status === 403 ? 'ClinePass credentials were rejected.' : `ClinePass API error: HTTP ${status}`);
    });
  it('malformed payload is a classified parse failure', async () => {
    const { reading, error } = await cline('{"data":{"limits":[{"type":"weekly","percentUsed":"forty"}]},"success":true}');
    expect(reading.reason).toBe('plugin:parse-failure');
    expect(error.message).toContain('Failed to parse ClinePass response');
  });
  it('browser session reaches the quota parser; a rejected session never discloses the secret', async () => {
    const ok = await cline('{"success":true,"data":{"limits":[{"type":"weekly","percentUsed":25}]}}', 200, { CLINE_AUTH_SOURCE: 'oauth' }, 'workos:fixture-session');
    expect(header(ok.requests[0], 'Authorization')).toBe('Bearer workos:fixture-session');
    expect(ok.identity).toEqual({ loginMethod: 'Browser' });
    const rejected = await cline('{"error":"workos:fixture-session"}', 401, { CLINE_AUTH_SOURCE: 'oauth' }, 'workos:fixture-session');
    expect(rejected.reading.reason).toBe('plugin:authentication-expired');
    expect(rejected.error.message).toContain('cline auth');
    expect(rejected.error.message).not.toContain('fixture-session');
  });
  it('exports a typed error class', () => {
    expect(new PluginError('timeout').message).toBe('Provider plugin timed out');
  });
});

describe('vendored files', () => {
  it('ATTRIBUTION.md records the source path, commit and sha256 of every vendored file', () => {
    const dir = join(__dirname, '..', 'dispatcher', 'usage-readers', 'plugins');
    const attribution = readFileSync(join(dir, 'ATTRIBUTION.md'), 'utf8');
    expect(attribution).toContain('6480977');
    for (const file of ['zai.js', 'muse.js', 'clinepass.js', 'provider-plugin-prelude.js', 'LICENSE-CodexBar']) {
      const sha = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
      expect.soft(attribution, file).toContain(`| ${file} |`);
      expect.soft(attribution, `${file} ${sha}`).toContain(sha);
    }
  });
});
