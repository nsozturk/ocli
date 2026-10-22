import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, createCipheriv, createHash } from 'node:crypto';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { createChromiumCookieReader, CookieReadError } from '../dispatcher/usage-readers/cookies/chromium.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { CHROMIUM_BROWSERS } from '../dispatcher/usage-readers/cookies/catalog.mjs';
import {
  createCookieAccessGate, COOKIE_GATE_COOLDOWN_MS, isDenialReason, defaultGateStatePath,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/cookies/gate.mjs';
import {
  createCookieBroker, defaultImportOrder, normalizeDeclaredDomains,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/cookies/broker.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { loadPlugin, defaultCookieSource } from '../dispatcher/usage-readers/plugin-host.mjs';

// A real browser profile and the real keychain are NEVER touched. Synthetic Cookies sqlite + a known
// Safe Storage password through the exact PBKDF2/AES path the reader uses.
const PASSWORD = 'synthetic-safe-storage-pw';
const KEY = pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, 0x20);
const FUTURE = 16_000_000_000_000_000; // expires_utc (µs since 1601), far future

function encrypt(value: string, hostKey: string, version: number): Buffer {
  const prefix = version >= 24 ? createHash('sha256').update(Buffer.from(hostKey, 'utf8')).digest() : Buffer.alloc(0);
  const plain = Buffer.concat([prefix, Buffer.from(value, 'utf8')]);
  const c = createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([Buffer.from('v10', 'latin1'), c.update(plain), c.final()]);
}

type Row = { host_key: string; name: string; value?: string; encrypted?: Buffer; expires_utc?: number };
function buildCookieDb(dir: string, version: number, rows: Row[]): string {
  const dbPath = join(dir, 'Cookies');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT INTO meta(key, value) VALUES ('version', ?)`).run(String(version));
  db.exec(`CREATE TABLE cookies(
    host_key TEXT, name TEXT, path TEXT, expires_utc INTEGER,
    is_secure INTEGER, is_httponly INTEGER, value TEXT, encrypted_value BLOB)`);
  const ins = db.prepare(`INSERT INTO cookies
    (host_key, name, path, expires_utc, is_secure, is_httponly, value, encrypted_value)
    VALUES (?, ?, '/', ?, 0, 0, ?, ?)`);
  for (const r of rows) ins.run(r.host_key, r.name, r.expires_utc ?? FUTURE, r.value ?? null, r.encrypted ?? null);
  db.close();
  return dbPath;
}

let roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });
function freshDir(tag: string): string { const d = mkdtempSync(join(tmpdir(), `b2b-${tag}-`)); roots.push(d); return d; }

// A gate state path inside a temp dir — NEVER the real ~/.config/ocli.
function gateIn(dir: string) { return join(dir, 'cookie-access-gate.json'); }

// A fake reader: availableStores and read are both controllable and spied.
function fakeReader(spec: {
  stores?: (browserId: string) => any[];
  read?: (args: any) => { records: any[] };
} = {}) {
  const availableCalls: string[] = [];
  const readCalls: any[] = [];
  return {
    availableCalls, readCalls,
    availableStores: vi.fn((browserId: string) => { availableCalls.push(browserId); return spec.stores ? spec.stores(browserId) : []; }),
    read: vi.fn((args: any) => { readCalls.push(args); return spec.read ? spec.read(args) : { records: [] }; }),
  };
}

describe('B2b gate', () => {
  it('a denial starts a 6h cooldown for the browser and the whole chromium family', () => {
    const dir = freshDir('gate');
    const t0 = 1_000_000_000_000;
    const gate = createCookieAccessGate({ statePath: gateIn(dir), now: t0 });
    expect(gate.shouldAttempt('chrome', t0)).toBe(true);
    gate.recordDenied('chrome', t0);
    // the denied browser is skipped...
    expect(gate.shouldAttempt('chrome', t0 + 1)).toBe(false);
    // ...and so is every other chromium browser (family suppression)
    expect(gate.shouldAttempt('edge', t0 + 1)).toBe(false);
    // just before the cooldown ends: still blocked; just after: attempted again
    expect(gate.shouldAttempt('chrome', t0 + COOKIE_GATE_COOLDOWN_MS - 1)).toBe(false);
    expect(gate.shouldAttempt('chrome', t0 + COOKIE_GATE_COOLDOWN_MS + 1)).toBe(true);
  });

  it('persists cooldowns (0600) holding only timestamps — never a cookie value', () => {
    const dir = freshDir('gate-persist');
    const path = gateIn(dir);
    const t0 = 1_000_000_000_000;
    const g1 = createCookieAccessGate({ statePath: path });
    g1.recordDenied('brave', t0);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(doc).sort()).toEqual(['chromiumFamilyDeniedUntil', 'deniedUntilBySource']);
    for (const v of Object.values(doc.deniedUntilBySource)) expect(typeof v).toBe('number');
    expect(typeof doc.chromiumFamilyDeniedUntil).toBe('number');
    // reloaded from disk by a fresh instance
    const g2 = createCookieAccessGate({ statePath: path });
    expect(g2.shouldAttempt('brave', t0 + 1)).toBe(false);
  });

  it('isDenialReason: only denied / interaction-required start a cooldown', () => {
    expect(isDenialReason('denied')).toBe(true);
    expect(isDenialReason('interaction-required')).toBe(true);
    expect(isDenialReason('not-found')).toBe(false);
    expect(isDenialReason('unavailable')).toBe(false);
    expect(isDenialReason('timeout')).toBe(false);
  });

  it('the default gate state path lives beside the usage-readers config', () => {
    const p = defaultGateStatePath({ OCLI_USAGE_READERS_CONFIG: '/tmp/x/usage-readers.json' });
    expect(p).toBe('/tmp/x/cookie-access-gate.json');
  });
});

describe('B2b broker', () => {
  it('attempts browsers in the catalog import order, stopping when one yields a header', () => {
    const dir = freshDir('order');
    const reader = fakeReader(); // every browser: no stores
    const gate = createCookieAccessGate({ statePath: gateIn(dir) });
    const broker = createCookieBroker({ reader, gate, domains: ['fixture.test'] });
    expect(() => broker.cookieHeader('fixture.test')).toThrow(CookieReadError);
    expect(reader.availableCalls).toEqual(defaultImportOrder());
    expect(defaultImportOrder()).toEqual(CHROMIUM_BROWSERS.map((b: any) => b.id));
    expect(defaultImportOrder()[0]).toBe('chrome');
  });

  it('serves the chromium reader\'s header for a declared domain; the value never reaches the log', () => {
    const dir = freshDir('serve');
    const db = buildCookieDb(dir, 24, [
      { host_key: 'fixture.test', name: 'sid', encrypted: encrypt('SECRET-COOKIE-VALUE', 'fixture.test', 24) },
    ]);
    const logs: unknown[] = [];
    const reader = createChromiumCookieReader({
      platform: 'darwin', credentials: { read: () => ({ ok: true, value: PASSWORD }) },
      fs: { mkdtempSync, copyFileSync, existsSync, rmSync }, tmpDir: tmpdir(), log: (e: unknown) => logs.push(e),
    });
    // availableStores is the only seam that would hit a real profile; point it at the synthetic db.
    const bound = {
      availableStores: (id: string) => (id === 'chrome' ? [{ browserId: 'chrome', kind: 'primary', databaseURL: db }] : []),
      read: (args: any) => reader.read(args),
    };
    const gate = createCookieAccessGate({ statePath: gateIn(dir) });
    const broker = createCookieBroker({ reader: bound, gate, domains: ['fixture.test'], log: (e: unknown) => logs.push(e) });
    expect(broker.cookieHeader('fixture.test')).toBe('sid=SECRET-COOKIE-VALUE');
    expect(JSON.stringify(logs)).not.toContain('SECRET-COOKIE-VALUE');
  });

  it('a keychain denial records a cooldown; the next read skips the keychain entirely', () => {
    const dir = freshDir('cooldown');
    const t0 = 2_000_000_000_000;
    const reader = fakeReader({
      stores: id => (id === 'chrome' ? [{ browserId: 'chrome', kind: 'primary', databaseURL: '/unused' }] : []),
      read: () => { throw new CookieReadError('denied'); },
    });
    const gate = createCookieAccessGate({ statePath: gateIn(dir), now: t0 });
    const recordSpy = vi.spyOn(gate, 'recordDenied');
    const broker = createCookieBroker({ reader, gate, domains: ['fixture.test'], now: t0 });

    expect(() => broker.cookieHeader('fixture.test')).toThrow(CookieReadError); // first pass: chrome denied
    expect(reader.read).toHaveBeenCalledTimes(1);
    // recordDenied is only ever handed a browserId + timestamp — never a cookie value.
    for (const call of recordSpy.mock.calls) {
      expect(typeof call[0]).toBe('string');
      if (call[1] !== undefined) expect(typeof call[1]).toBe('number');
      expect(call.length).toBeLessThanOrEqual(2);
    }

    const availableBefore = reader.availableCalls.length;
    const readBefore = reader.read.mock.calls.length;
    expect(() => broker.cookieHeader('fixture.test')).toThrow(CookieReadError); // second pass
    // cooldown active for the whole family ⇒ no browser is probed, keychain never touched again
    expect(reader.availableCalls.length).toBe(availableBefore);
    expect(reader.read.mock.calls.length).toBe(readBefore);
  });

  it('refuses an undeclared domain without ever touching the reader (domain policy)', () => {
    const dir = freshDir('undeclared');
    const reader = fakeReader();
    const gate = createCookieAccessGate({ statePath: gateIn(dir) });
    const broker = createCookieBroker({ reader, gate, domains: ['fixture.test'] });
    let thrown: any;
    try { broker.cookieHeader('evil.test'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CookieReadError);
    expect(thrown.reason).toBe('undeclared');
    expect(reader.availableStores).not.toHaveBeenCalled();
  });

  it('refuses an empty or missing domain list (B2a finding — never read every cookie)', () => {
    const dir = freshDir('empty');
    const reader = fakeReader();
    const gate = createCookieAccessGate({ statePath: gateIn(dir) });
    for (const domains of [[], undefined]) {
      const broker = createCookieBroker({ reader, gate, domains });
      let thrown: any;
      try { broker.cookieHeader('fixture.test'); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(CookieReadError);
      expect(thrown.reason).toBe('no-domains');
    }
    expect(reader.availableStores).not.toHaveBeenCalled();
    expect(normalizeDeclaredDomains([])).toEqual([]);
    expect(normalizeDeclaredDomains(['.Fixture.test', 'fixture.test'])).toEqual(['fixture.test']);
  });
});

describe('B2b chromium reader — empty domain guard (B2a finding)', () => {
  it('read refuses an empty / missing domain list, opening nothing', () => {
    const dir = freshDir('reader-empty');
    const db = buildCookieDb(dir, 24, [{ host_key: 'fixture.test', name: 'a', value: 'A' }]);
    const open = vi.fn((p: string, o?: any) => new DatabaseSync(p, o));
    const copied = vi.fn(copyFileSync);
    const reader = createChromiumCookieReader({
      platform: 'darwin', credentials: { read: () => ({ ok: true, value: PASSWORD }) },
      openDatabase: open, fs: { mkdtempSync, copyFileSync: copied, existsSync, rmSync }, tmpDir: tmpdir(),
    });
    for (const domains of [[], undefined]) {
      let thrown: any;
      try { reader.read({ databaseURL: db, browserId: 'chrome', domains }); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(CookieReadError);
      expect(thrown.reason).toBe('no-domains');
    }
    expect(open).not.toHaveBeenCalled();
    expect(copied).not.toHaveBeenCalled();
  });
});

describe('B2b host wiring', () => {
  const MANIFEST = `id: "fx", name: "fx", endpoints: ["https://api.fixture.test"], settings: [],
    capabilities: ["browser-cookies"], cookieDomains: ["fixture.test"],`;
  const plugin = (body: string) => `defineProvider({ ${MANIFEST} async fetchUsage(ctx) { ${body} } });`;

  it('an undeclared domain never reaches the broker (host enforces the manifest)', async () => {
    const dir = freshDir('wiring');
    const reader = fakeReader();
    const gate = createCookieAccessGate({ statePath: gateIn(dir) });
    const broker = createCookieBroker({ reader, gate, domains: ['fixture.test'] });
    const transport = async () => ({ status: 200, headers: {}, body: '{}' });
    const rt = loadPlugin(plugin('await ctx.browser.cookieHeader("evil.test"); return { primary: { usedPercent: 1 } };'),
      { transport, cookieSource: (d: string) => broker.cookieHeader(d) });
    const { reading } = await rt.read({ secrets: {}, now: Date.UTC(2026, 9, 18) });
    expect(reading.status).toBe('unavailable');
    expect(reading.reason).toBe('plugin:secret-access');
    expect(reader.availableStores).not.toHaveBeenCalled();
  });

  it('the broker-backed cookie source serves a declared domain to the plugin', async () => {
    const dir = freshDir('wiring-ok');
    const db = buildCookieDb(dir, 24, [{ host_key: 'fixture.test', name: 'sid', value: 'plain-ok' }]);
    const reader = createChromiumCookieReader({
      platform: 'darwin', credentials: { read: () => ({ ok: true, value: PASSWORD }) },
      fs: { mkdtempSync, copyFileSync, existsSync, rmSync }, tmpDir: tmpdir(),
    });
    const bound = {
      availableStores: (id: string) => (id === 'chrome' ? [{ browserId: 'chrome', kind: 'primary', databaseURL: db }] : []),
      read: (args: any) => reader.read(args),
    };
    const gate = createCookieAccessGate({ statePath: gateIn(dir) });
    const broker = createCookieBroker({ reader: bound, gate, domains: ['fixture.test'] });
    const transport = async () => ({ status: 200, headers: {}, body: '{}' });
    const rt = loadPlugin(
      plugin('const h = await ctx.browser.cookieHeader("fixture.test"); if (h !== "sid=plain-ok") throw new Error("header mismatch"); return { primary: { usedPercent: 1 } };'),
      { transport, cookieSource: (d: string) => broker.cookieHeader(d) });
    const { reading } = await rt.read({ secrets: {}, now: Date.UTC(2026, 9, 18) });
    expect(reading.status).toBe('ok');
  });
});

// Review pins (u1-review-b2b): clauses the slice's own tests left unobserved.
describe('B2b review pins', () => {
  const rec = (domain: string, name: string, value: string, expires: number | null = 100) => ({ domain, name, path: '/', value, expires });

  it('a per-browser cooldown alone (no family entry on disk) blocks only that browser', () => {
    const dir = freshDir('pin-perbrowser');
    const t0 = 3_000_000_000_000;
    const path = gateIn(dir);
    writeFileSync(path, JSON.stringify({ deniedUntilBySource: { chrome: t0 + 1000 }, chromiumFamilyDeniedUntil: null }));
    const gate = createCookieAccessGate({ statePath: path });
    expect(gate.shouldAttempt('chrome', t0)).toBe(false);
    expect(gate.shouldAttempt('edge', t0)).toBe(true);
  });

  it('the Network store wins a key tie over the primary store, and is read first', () => {
    const dir = freshDir('pin-priority');
    const reader = fakeReader({
      stores: id => (id === 'chrome' ? [{ kind: 'primary', databaseURL: '/p' }, { kind: 'network', databaseURL: '/n' }] : []),
      read: ({ store }) => ({ records: [rec('fixture.test', 'sid', store.kind)] }),
    });
    const broker = createCookieBroker({ reader, gate: createCookieAccessGate({ statePath: gateIn(dir) }), domains: ['fixture.test'] });
    expect(broker.cookieHeader('fixture.test')).toBe('sid=network');
    expect(reader.readCalls.map(c => c.store.kind)).toEqual(['network', 'primary']);
  });

  it('on a key collision the later-expiring record wins', () => {
    const dir = freshDir('pin-expiry');
    const reader = fakeReader({
      stores: id => (id === 'chrome' ? [{ kind: 'network', databaseURL: '/n' }, { kind: 'primary', databaseURL: '/p' }] : []),
      read: ({ store }) => ({ records: [rec('fixture.test', 'sid', store.kind, store.kind === 'primary' ? 200 : 100)] }),
    });
    const broker = createCookieBroker({ reader, gate: createCookieAccessGate({ statePath: gateIn(dir) }), domains: ['fixture.test'] });
    expect(broker.cookieHeader('fixture.test')).toBe('sid=primary');
  });

  it('a denial on the first store stops the browser — the second store is never read (no second prompt)', () => {
    const dir = freshDir('pin-deny-stop');
    const reader = fakeReader({
      stores: id => (id === 'chrome' ? [{ kind: 'network', databaseURL: '/n' }, { kind: 'primary', databaseURL: '/p' }] : []),
      read: () => { throw new CookieReadError('denied'); },
    });
    const broker = createCookieBroker({ reader, gate: createCookieAccessGate({ statePath: gateIn(dir) }), domains: ['fixture.test'] });
    expect(() => broker.cookieHeader('fixture.test')).toThrow(CookieReadError);
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it('a request for one declared domain never carries another declared domain\'s cookies', () => {
    const dir = freshDir('pin-cross');
    const reader = fakeReader({
      stores: id => (id === 'chrome' ? [{ kind: 'primary', databaseURL: '/p' }] : []),
      read: () => ({ records: [rec('a.test', 'a', '1'), rec('b.test', 'b', '2')] }),
    });
    const broker = createCookieBroker({ reader, gate: createCookieAccessGate({ statePath: gateIn(dir) }), domains: ['a.test', 'b.test'] });
    expect(broker.cookieHeader('a.test')).toBe('a=1');
  });

  it('the default cookie source is null for a plugin without the browser-cookies capability', () => {
    // Nothing is invoked: a non-null return would only be a closure, never called here.
    expect(defaultCookieSource({ capabilities: [], cookieDomains: ['fixture.test'] }, { env: {}, platform: 'darwin' })).toBeNull();
    expect(defaultCookieSource({ capabilities: ['browser-cookies'], cookieDomains: ['fixture.test'] }, { env: { VITEST: 'true' }, platform: 'darwin' })).toBeNull();
  });
});
