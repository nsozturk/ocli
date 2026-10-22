import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  createChromiumCookieReader, decryptChromiumValue, deriveSafeStorageKey, chromeExpiryToEpochMs,
  sqlCondition, cookieHeader, CookieReadError,
  SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_LENGTH, META_HASH_PREFIX_VERSION,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/cookies/chromium.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { safeStorageLabelsFor, CHROMIUM_BROWSERS, AGGREGATE_SAFE_STORAGE_LABELS, discoverProfileStores } from '../dispatcher/usage-readers/cookies/catalog.mjs';

// A real browser profile and the real keychain are NEVER touched. We build a synthetic Cookies sqlite
// in a temp dir, encrypted with a KNOWN password through the exact PBKDF2/AES path the reader uses.
const PASSWORD = 'synthetic-safe-storage-pw';
// Literal Chrome parameters (NOT the module constants) so the decrypt path catches an internal
// iteration/salt/length drift independently of the constant assertions below.
const KEY = pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, 0x20);

// Chrome's v10 macOS encryption: 'v10' || AES-128-CBC(iv=0x20*16, PKCS7)[ (version>=24 ? sha256(host) : '') || value ].
function encrypt(value: string, hostKey: string, version: number): Buffer {
  const prefix = version >= 24 ? createHash('sha256').update(Buffer.from(hostKey, 'utf8')).digest() : Buffer.alloc(0);
  const plain = Buffer.concat([prefix, Buffer.from(value, 'utf8')]);
  const c = createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([Buffer.from('v10', 'latin1'), c.update(plain), c.final()]);
}

type Row = {
  host_key: string; name: string; path?: string; expires_utc?: number;
  is_secure?: number; is_httponly?: number; value?: string; encrypted?: Buffer;
};
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(
      r.host_key, r.name, r.path ?? '/', r.expires_utc ?? 0,
      r.is_secure ?? 0, r.is_httponly ?? 0,
      r.value ?? null, r.encrypted ?? null);
  }
  db.close();
  return dbPath;
}

// A keychain stub: records every query; answers the Safe Storage password. Never the real keychain.
function keychainStub(answer: { ok: boolean; value?: string; reason?: string }) {
  const reads: { service: string; account: string }[] = [];
  return { reads, read: (q: { service: string; account: string }) => { reads.push(q); return answer; } };
}

// An openDatabase spy: records every path opened, opens the copy read-only for real.
function openSpy() {
  const paths: string[] = [];
  const open = vi.fn((p: string, opts?: Record<string, unknown>) => { paths.push(p); return new DatabaseSync(p, opts as never); });
  return { paths, open };
}

let roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });
function freshDir(tag: string): string { const d = mkdtempSync(join(tmpdir(), `b2a-${tag}-`)); roots.push(d); return d; }

const FUTURE = 16_000_000_000_000_000; // expires_utc (µs since 1601), far future
const PAST = 13_000_000_000_000_000;   // expires_utc in the past (≈ year 2012)

describe('B2a crypto + helpers', () => {
  it('derives the AES-128 key with PBKDF2-SHA1, saltysalt, 1003 iterations, 16 bytes', () => {
    expect(SAFE_STORAGE_SALT).toBe('saltysalt');
    expect(SAFE_STORAGE_ITERATIONS).toBe(1003);
    expect(SAFE_STORAGE_KEY_LENGTH).toBe(16);
    expect(META_HASH_PREFIX_VERSION).toBe(24);
    const key = deriveSafeStorageKey(PASSWORD);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(16);
    expect(Buffer.compare(key, KEY)).toBe(0);
  });

  it('decrypts a v10 value and strips the SHA-256(host_key) prefix only at version ≥ 24', () => {
    const host = 'example.com';
    const encV24 = encrypt('token-abc', host, 24);
    const encV23 = encrypt('token-abc', host, 23);
    expect(decryptChromiumValue(encV24, KEY, host, 24)).toBe('token-abc');
    expect(decryptChromiumValue(encV23, KEY, host, 23)).toBe('token-abc');
    // At v24, a value whose stored host hash does not match is rejected (null), not returned raw.
    expect(decryptChromiumValue(encV24, KEY, 'other.com', 24)).toBeNull();
    // Non-v10 / too-short / garbage ⇒ null, never a throw.
    expect(decryptChromiumValue(Buffer.from('v11xxxx'), KEY, host, 24)).toBeNull();
    expect(decryptChromiumValue(Buffer.from('v1'), KEY, host, 24)).toBeNull();
    expect(decryptChromiumValue(Buffer.concat([Buffer.from('v10'), randomBytes(16)]), KEY, host, 23)).toBeNull();
  });

  it('converts Chrome expiry (µs since 1601) to epoch ms, session cookies ⇒ null', () => {
    expect(chromeExpiryToEpochMs(0)).toBeNull();
    expect(chromeExpiryToEpochMs(11_644_473_600_000_000n)).toBeNull(); // == unix epoch, seconds==0
    const ms = chromeExpiryToEpochMs(FUTURE);
    expect(typeof ms).toBe('number');
    expect(ms!).toBeGreaterThan(Date.now());
  });

  it('builds an escaped exact + dot-parent SQL condition', () => {
    expect(sqlCondition('host_key', [], 'exact')).toBe('1=1');
    expect(sqlCondition('host_key', ['example.com'], 'exact'))
      .toBe("(host_key = 'example.com' OR host_key = '.example.com')");
    expect(sqlCondition('host_key', ['.a.com'], 'exact'))
      .toBe("(host_key = 'a.com' OR host_key = '.a.com')");
    expect(sqlCondition('host_key', ["o'x"], 'exact')).toContain("o''x");
  });
});

describe('B2a catalog', () => {
  it('lists the named Chromium browsers with Safe Storage labels', () => {
    const ids = CHROMIUM_BROWSERS.map((b: { id: string }) => b.id);
    for (const id of ['chrome', 'arc', 'brave', 'edge', 'chromium', 'vivaldi', 'opera']) expect(ids).toContain(id);
    expect(safeStorageLabelsFor('chrome')).toEqual([{ service: 'Chrome Safe Storage', account: 'Chrome' }]);
    // A browser with no own labels falls back to the aggregate list.
    expect(safeStorageLabelsFor('chromeBeta')).toEqual(AGGREGATE_SAFE_STORAGE_LABELS);
    expect(AGGREGATE_SAFE_STORAGE_LABELS[0]).toEqual({ service: 'Chrome Safe Storage', account: 'Chrome' });
  });

  it('discovers only existing profile cookie DBs (Default/Profile*/user-*), network + primary', () => {
    const root = freshDir('profiles');
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(join(root, 'Default'), { recursive: true });
    writeFileSync(join(root, 'Default', 'Cookies'), '');
    mkdirSync(join(root, 'Profile 1', 'Network'), { recursive: true });
    writeFileSync(join(root, 'Profile 1', 'Network', 'Cookies'), '');
    mkdirSync(join(root, 'Guest Profile'), { recursive: true }); // ignored
    const stores = discoverProfileStores({ root, browserId: 'chrome', fs: { readdirSync, existsSync } });
    const dbs = stores.map((s: { databaseURL: string }) => s.databaseURL).sort();
    expect(dbs).toContain(join(root, 'Default', 'Cookies'));
    expect(dbs).toContain(join(root, 'Profile 1', 'Network', 'Cookies'));
    expect(dbs.some((d: string) => d.includes('Guest Profile'))).toBe(false);
  });
});

describe('B2a reader — copy, read-only, lazy keychain, decrypt, expiry', () => {
  function makeReader(opts: { platform?: string; keychain?: ReturnType<typeof keychainStub>; now?: number }) {
    const spy = openSpy();
    const fsSpy = {
      mkdtempSync: vi.fn((p: string) => mkdtempSync(p)),
      copyFileSync: vi.fn((a: string, b: string) => copyFileSync(a, b)),
      existsSync, rmSync: vi.fn((p: string, o?: Record<string, unknown>) => rmSync(p, o as never)),
    };
    const logs: unknown[] = [];
    const credentials = opts.keychain ?? keychainStub({ ok: true, value: PASSWORD });
    const reader = createChromiumCookieReader({
      platform: opts.platform ?? 'darwin',
      credentials,
      openDatabase: spy.open,
      fs: fsSpy,
      tmpDir: tmpdir(),
      log: (e: unknown) => logs.push(e),
      now: opts.now,
    });
    return { reader, spy, fsSpy, credentials, logs };
  }

  // Lead pin (B2a survivor): a running browser keeps its newest rows in the uncheckpointed -wal file;
  // the reader must copy the sidecars or those cookies vanish.
  it('reads a row that lives only in an uncheckpointed WAL (sidecars are copied)', () => {
    const dir = freshDir('wal');
    const dbPath = buildCookieDb(dir, 24, []);
    const live = new DatabaseSync(dbPath);
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    live.prepare(`INSERT INTO cookies (host_key, name, path, expires_utc, is_secure, is_httponly, value, encrypted_value)
      VALUES ('example.com', 'sid', '/', ${FUTURE}, 0, 0, 'wal-only', NULL)`).run();
    try {
      const { reader } = makeReader({ keychain: keychainStub({ ok: true, value: PASSWORD }) });
      const { records } = reader.read({ databaseURL: dbPath, browserId: 'chrome', domains: ['example.com'] });
      expect(records.map((r: { value: string }) => r.value)).toEqual(['wal-only']);
    } finally {
      live.close();
    }
  });

  it('returns plaintext cookies without ever querying the keychain', () => {
    const dir = freshDir('plain');
    const db = buildCookieDb(dir, 24, [
      { host_key: 'example.com', name: 'sid', value: 'plain-1', expires_utc: FUTURE },
    ]);
    const kc = keychainStub({ ok: true, value: PASSWORD });
    const { reader } = makeReader({ keychain: kc });
    const { records } = reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(records).toEqual([
      { name: 'sid', value: 'plain-1', domain: 'example.com', path: '/', expires: chromeExpiryToEpochMs(FUTURE), secure: false, httpOnly: false },
    ]);
    expect(kc.reads).toEqual([]); // keychain asked only when an encrypted value matches
  });

  it('decrypts encrypted cookies, querying the keychain lazily exactly once, labels from the catalog', () => {
    const dir = freshDir('enc');
    const db = buildCookieDb(dir, 24, [
      { host_key: 'example.com', name: 'auth', encrypted: encrypt('secret-24', 'example.com', 24), expires_utc: FUTURE, is_secure: 1, is_httponly: 1 },
      { host_key: 'example.com', name: 'extra', encrypted: encrypt('second', 'example.com', 24), expires_utc: FUTURE },
    ]);
    const kc = keychainStub({ ok: true, value: PASSWORD });
    const { reader, logs } = makeReader({ keychain: kc });
    const { records, cookieHeader: header } = reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(records.map((r: { name: string; value: string }) => [r.name, r.value])).toEqual([['auth', 'secret-24'], ['extra', 'second']]);
    expect(records[0]).toMatchObject({ secure: true, httpOnly: true });
    expect(kc.reads).toEqual([{ service: 'Chrome Safe Storage', account: 'Chrome' }]); // once, lazy, from catalog
    expect(header('example.com')).toBe('auth=secret-24; extra=second');
    // A decrypted value is a secret: it never reaches the log, even on the happy path.
    expect(JSON.stringify(logs)).not.toContain('secret-24');
    expect(JSON.stringify(logs)).not.toContain('second');
  });

  it('reads a version-23 db (no host hash prefix)', () => {
    const dir = freshDir('v23');
    const db = buildCookieDb(dir, 23, [
      { host_key: 'example.com', name: 'auth', encrypted: encrypt('secret-23', 'example.com', 23), expires_utc: FUTURE },
    ]);
    const { reader } = makeReader({});
    const { records } = reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(records.map((r: { value: string }) => r.value)).toEqual(['secret-23']);
  });

  it('filters by host_key (exact + dot-parent) and nothing else leaks through', () => {
    const dir = freshDir('filter');
    const db = buildCookieDb(dir, 24, [
      { host_key: 'example.com', name: 'a', value: 'A', expires_utc: FUTURE },
      { host_key: '.example.com', name: 'b', value: 'B', expires_utc: FUTURE },
      { host_key: 'evil.com', name: 'c', value: 'C', expires_utc: FUTURE },
    ]);
    const { reader } = makeReader({});
    const { records } = reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(records.map((r: { value: string }) => r.value).sort()).toEqual(['A', 'B']);
  });

  it('skips expired cookies unless includeExpired is set', () => {
    const dir = freshDir('exp');
    const db = buildCookieDb(dir, 24, [
      { host_key: 'example.com', name: 'live', value: 'L', expires_utc: FUTURE },
      { host_key: 'example.com', name: 'dead', value: 'D', expires_utc: PAST },
      { host_key: 'example.com', name: 'session', value: 'S', expires_utc: 0 },
    ]);
    const now = Date.now();
    const kept = makeReader({ now }).reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(kept.records.map((r: { name: string }) => r.name).sort()).toEqual(['live', 'session']);
    const all = makeReader({ now }).reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'], includeExpired: true });
    expect(all.records.map((r: { name: string }) => r.name).sort()).toEqual(['dead', 'live', 'session']);
  });

  it('never opens the live db — only the temp copy — and removes the copy afterwards', () => {
    const dir = freshDir('copy');
    const db = buildCookieDb(dir, 24, [{ host_key: 'example.com', name: 'a', value: 'A', expires_utc: FUTURE }]);
    const { reader, spy, fsSpy } = makeReader({});
    reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(spy.paths.length).toBeGreaterThan(0);
    expect(spy.paths).not.toContain(db);               // the live file is never opened
    expect(spy.paths.every((p: string) => p !== db)).toBe(true);
    expect(fsSpy.copyFileSync).toHaveBeenCalled();
    const tempDir = fsSpy.mkdtempSync.mock.results[0].value as string;
    expect(spy.paths[0]).toBe(join(tempDir, 'Cookies')); // opened the copy, in the temp dir
    expect(existsSync(tempDir)).toBe(false);             // temp copy removed
  });

  it('a keychain denial becomes a typed reason and never exposes a value', () => {
    const dir = freshDir('denied');
    const secret = 'top-secret-token';
    const db = buildCookieDb(dir, 24, [{ host_key: 'example.com', name: 'auth', encrypted: encrypt(secret, 'example.com', 24), expires_utc: FUTURE }]);
    const logs: unknown[] = [];
    const spy = openSpy();
    const reader = createChromiumCookieReader({
      platform: 'darwin', credentials: keychainStub({ ok: false, reason: 'denied' }),
      openDatabase: spy.open, fs: { mkdtempSync, copyFileSync, existsSync, rmSync }, tmpDir: tmpdir(),
      log: (e: unknown) => logs.push(e),
    });
    let thrown: unknown;
    try { reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CookieReadError);
    expect((thrown as { reason: string }).reason).toBe('denied');
    const everything = JSON.stringify({ msg: String(thrown), logs });
    expect(everything).not.toContain(secret);
  });

  it('a decrypt failure is skipped and never puts the (attempted) value in a log or error', () => {
    const dir = freshDir('wrongkey');
    // Encrypt with a DIFFERENT key so the reader's key cannot decrypt it.
    const otherKey = pbkdf2Sync('a-different-password', SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_LENGTH, 'sha1');
    const c = createCipheriv('aes-128-cbc', otherKey, IV);
    const prefix = createHash('sha256').update(Buffer.from('example.com', 'utf8')).digest();
    const enc = Buffer.concat([Buffer.from('v10', 'latin1'), c.update(Buffer.concat([prefix, Buffer.from('UNREADABLE', 'utf8')])), c.final()]);
    const db = buildCookieDb(dir, 24, [
      { host_key: 'example.com', name: 'bad', encrypted: enc, expires_utc: FUTURE },
      { host_key: 'example.com', name: 'good', encrypted: encrypt('ok', 'example.com', 24), expires_utc: FUTURE },
    ]);
    const logs: unknown[] = [];
    const spy = openSpy();
    const reader = createChromiumCookieReader({
      platform: 'darwin', credentials: keychainStub({ ok: true, value: PASSWORD }),
      openDatabase: spy.open, fs: { mkdtempSync, copyFileSync, existsSync, rmSync }, tmpDir: tmpdir(),
      log: (e: unknown) => logs.push(e),
    });
    const { records } = reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] });
    expect(records.map((r: { name: string }) => r.name)).toEqual(['good']); // bad row skipped
    expect(JSON.stringify(logs)).not.toContain('UNREADABLE');
  });

  it('non-darwin ⇒ unavailable, without copying or opening anything', () => {
    const dir = freshDir('nonmac');
    const db = buildCookieDb(dir, 24, [{ host_key: 'example.com', name: 'a', value: 'A', expires_utc: FUTURE }]);
    const { reader, spy, fsSpy } = makeReader({ platform: 'linux' });
    let thrown: unknown;
    try { reader.read({ databaseURL: db, browserId: 'chrome', domains: ['example.com'] }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CookieReadError);
    expect((thrown as { reason: string }).reason).toBe('unavailable');
    expect(spy.open).not.toHaveBeenCalled();
    expect(fsSpy.copyFileSync).not.toHaveBeenCalled();
  });
});

// B2b review finding: in a test process the discovery seam itself must fail closed for the REAL home.
// Every fs function is a spy that never touches disk, so even a broken guard cannot reach a real file.
describe('B2b guard — test process never discovers or copies under the real home', () => {
  const realHome = homedir();
  function spyFs() {
    return {
      readdirSync: vi.fn(() => [{ name: 'Default', isDirectory: () => true }]),
      existsSync: vi.fn(() => true),
      mkdtempSync: vi.fn((p: string) => p + 'X'),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
    };
  }

  it('discoverProfileStores: real-home roots (profile + electron) yield no stores and no fs calls', () => {
    const fs = spyFs();
    const appSupport = join(realHome, 'Library', 'Application Support');
    expect(discoverProfileStores({ root: join(appSupport, 'Google/Chrome'), browserId: 'chrome', fs })).toEqual([]);
    expect(discoverProfileStores({ root: join(appSupport, 'Claude'), browserId: 'claudeDesktop', fs })).toEqual([]);
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('reader: default availableStores and a read of a real-home DB touch nothing', () => {
    const fs = spyFs();
    const open = vi.fn();
    const reader = createChromiumCookieReader({
      platform: 'darwin', credentials: keychainStub({ ok: true, value: PASSWORD }), openDatabase: open, fs, tmpDir: tmpdir(),
    });
    for (const b of CHROMIUM_BROWSERS) expect(reader.availableStores(b.id)).toEqual([]);
    const realDb = join(realHome, 'Library', 'Application Support', 'Claude', 'Cookies');
    let thrown: unknown;
    try { reader.read({ databaseURL: realDb, browserId: 'claudeDesktop', domains: ['claude.ai'] }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CookieReadError);
    expect((thrown as { reason: string }).reason).toBe('unavailable');
    for (const f of [fs.readdirSync, fs.existsSync, fs.mkdtempSync, fs.copyFileSync, open]) expect(f).not.toHaveBeenCalled();
  });
});

// Regression: the reader's DEFAULT fs object must carry readdirSync, or availableStores finds no
// profile in production (discoverProfileStores calls fs.readdirSync). `fs` is NOT injected here.
// HOME points at a fresh temp dir and the real-home guard is lifted only for this test; the precondition
// check below aborts before any discovery if homedir() is not that temp dir, so no real profile is listed.
describe('B2b regression — default fs discovers profiles (readdirSync present)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('availableStores with the module-default fs finds Default, Profile 1 and Network stores', () => {
    const { mkdirSync, writeFileSync } = require('node:fs');
    const home = freshDir('defaultfs');
    vi.stubEnv('HOME', home);
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OCLI_DISABLE_KEYCHAIN', '');
    expect(homedir()).toBe(home); // precondition: never discover against a real home
    const root = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    mkdirSync(join(root, 'Default'), { recursive: true });
    writeFileSync(join(root, 'Default', 'Cookies'), '');
    mkdirSync(join(root, 'Profile 1', 'Network'), { recursive: true });
    writeFileSync(join(root, 'Profile 1', 'Network', 'Cookies'), '');
    const reader = createChromiumCookieReader({ platform: 'darwin', credentials: keychainStub({ ok: true, value: PASSWORD }) });
    const dbs = reader.availableStores('chrome').map((s: { databaseURL: string }) => s.databaseURL).sort();
    expect(dbs).toEqual([join(root, 'Default', 'Cookies'), join(root, 'Profile 1', 'Network', 'Cookies')]);
  });
});
