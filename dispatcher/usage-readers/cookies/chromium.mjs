/**
 * Chromium cookie reader (macOS) — a port of SweetCookieKit's ChromeCookieImporter.swift.
 *   Reference: github.com/steipete/SweetCookieKit @ 3960c33 (MIT, © 2026 Peter Steinberger).
 *
 * node:sqlite + node:crypto only. No new dependency, no native binding, no browser process touched.
 *
 * Shape (ChromeCookieImporter):
 *  - Work on a COPY of the Cookies DB (+ its -wal/-shm) in a fresh temp dir (L88-116); open the copy
 *    read-only; never open or lock the live browser file; delete only the temp copy created here.
 *  - Filter by host_key in SQL before reading values (L135-143).
 *  - Request the "Safe Storage" keychain password ONLY after a value that needs decryption is found
 *    (L168-169) — lazily, once, cached per browser.
 *  - Decrypt as Chrome does on macOS: PBKDF2-SHA1(password, "saltysalt", 1003) → 16-byte AES key,
 *    AES-128-CBC with a 16-byte 0x20 IV, `v10` prefix; at meta version ≥ 24 a SHA-256(host_key)
 *    32-byte prefix is stripped (L310-336).
 *
 * A cookie value is a secret: it is never logged, never put in an error message, never in a reason.
 */
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, createDecipheriv, createHash } from 'node:crypto';
import { mkdtempSync as realMkdtemp, copyFileSync as realCopy, existsSync as realExists, rmSync as realRm, readdirSync as realReaddir } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStorageLabelsFor, chromiumRoots, discoverProfileStores, isRealProfilePathBlocked } from './catalog.mjs';

// Chrome macOS Safe Storage KDF/cipher parameters (ChromeCookieImporter L274-291, L321).
export const SAFE_STORAGE_SALT = 'saltysalt';
export const SAFE_STORAGE_ITERATIONS = 1003;
export const SAFE_STORAGE_KEY_LENGTH = 16; // kCCKeySizeAES128
export const CHROMIUM_V10_PREFIX = 'v10';
export const CBC_IV = Buffer.alloc(16, 0x20); // kCCBlockSizeAES128 bytes of 0x20 (L321)
// At this meta version and above, a SHA-256(host_key) prefix is prepended to the plaintext (L327-330).
export const META_HASH_PREFIX_VERSION = 24;

/** A typed failure. The reason is one of: unavailable | not-found | denied | interaction-required |
 *  timeout | load-failed. It never carries a cookie value or a keychain password. */
export class CookieReadError extends Error {
  constructor(reason) {
    super(`cookie read failed: ${reason}`);
    this.name = 'CookieReadError';
    this.reason = reason;
  }
}

/** PBKDF2-SHA1(password, "saltysalt", 1003) → 16-byte AES-128 key (L274-291). */
export function deriveSafeStorageKey(password) {
  return pbkdf2Sync(Buffer.from(String(password), 'utf8'), SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_LENGTH, 'sha1');
}

/** Decrypt a Chromium `encrypted_value` (L310-336). Returns the string value, or null on any failure
 *  (wrong prefix, bad padding, host-hash mismatch, non-UTF8). Never throws, never surfaces the value. */
export function decryptChromiumValue(encryptedValue, key, hostKey, databaseVersion) {
  const buf = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue ?? []);
  if (buf.length <= 3) return null;
  if (buf.subarray(0, 3).toString('latin1') !== CHROMIUM_V10_PREFIX) return null;
  const payload = buf.subarray(3);
  if (payload.length === 0 || payload.length % 16 !== 0) return null;

  let decrypted;
  try {
    const d = createDecipheriv('aes-128-cbc', key, CBC_IV); // PKCS7 padding stripped by default
    decrypted = Buffer.concat([d.update(payload), d.final()]);
  } catch {
    return null; // bad padding (e.g. wrong key) — skip, never leak
  }

  let value = decrypted;
  if (databaseVersion >= META_HASH_PREFIX_VERSION) {
    const expected = createHash('sha256').update(Buffer.from(String(hostKey), 'utf8')).digest(); // 32 bytes
    if (decrypted.length < expected.length || !decrypted.subarray(0, expected.length).equals(expected)) return null;
    value = decrypted.subarray(expected.length);
  }
  return value.toString('utf8');
}

/** Chrome expiry (µs since 1601-01-01) → epoch ms. `0`/non-positive ⇒ null (session cookie) (L322-327). */
export function chromeExpiryToEpochMs(expiresUTC) {
  const n = typeof expiresUTC === 'bigint' ? Number(expiresUTC) : Number(expiresUTC);
  if (!(n > 0)) return null;
  const seconds = n / 1_000_000 - 11_644_473_600;
  if (!(seconds > 0)) return null;
  return Math.trunc(seconds * 1000);
}

export function normalizeDomain(raw) {
  const trimmed = String(raw ?? '').trim();
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}

/** Build the host_key WHERE condition (BrowserCookieDomainMatcher.sqlCondition, L329-348). Exact
 *  matches both the bare and the dot-parent host_key. Single quotes are doubled. */
export function sqlCondition(column, patterns, match = 'exact') {
  if (!patterns || patterns.length === 0) return '1=1';
  const esc = v => String(v).replace(/'/g, "''");
  const clauses = patterns.map(raw => {
    switch (match) {
      case 'contains': return `${column} LIKE '%${esc(raw)}%'`;
      case 'suffix': return `${column} LIKE '%${esc(raw)}'`;
      case 'exact':
      default: {
        const n = esc(normalizeDomain(raw));
        return `(${column} = '${n}' OR ${column} = '.${n}')`;
      }
    }
  });
  return clauses.join(' OR ');
}

/** Cookie header for a request domain: `name=value; …` for every record whose domain the request
 *  domain equals or is a subdomain of. Values are not logged — the caller owns the returned string. */
export function cookieHeader(records, domain) {
  const target = normalizeDomain(domain).toLowerCase();
  return records
    .filter(r => {
      const d = normalizeDomain(r.domain).toLowerCase();
      return d === target || target.endsWith('.' + d);
    })
    .map(r => `${r.name}=${r.value}`)
    .join('; ');
}

function toBool(v) {
  return (typeof v === 'bigint' ? v !== 0n : Number(v) !== 0);
}

/**
 * Create a Chromium cookie reader.
 * @param {object} deps
 * @param {string} [deps.platform]        process.platform; non-darwin ⇒ every read is `unavailable`.
 * @param {object} deps.credentials       B1 credential store: `{ read({service, account}) -> {ok, value} | {ok:false, reason} }`.
 * @param {Function} [deps.openDatabase]  `(path, opts) -> DatabaseSync`-like; injected so the opened path can be spied.
 * @param {object} [deps.fs]              `{ mkdtempSync, copyFileSync, existsSync, rmSync, readdirSync }`.
 * @param {string} [deps.tmpDir]          base temp dir.
 * @param {Function} [deps.log]           `({category, message}) -> void`; never receives a value or password.
 * @param {number} [deps.now]            epoch ms used to filter expired cookies (default Date.now()).
 */
export function createChromiumCookieReader({
  platform = process.platform,
  credentials,
  openDatabase = (p, opts) => new DatabaseSync(p, opts),
  fs = { mkdtempSync: realMkdtemp, copyFileSync: realCopy, existsSync: realExists, rmSync: realRm, readdirSync: realReaddir },
  tmpDir = tmpdir(),
  log = () => {},
  now,
} = {}) {
  const note = (message) => { log({ category: 'cookies', message }); };
  const keyCache = new Map(); // browserId -> derived key Buffer

  function fetchSafeStorageKey(browserId) {
    if (keyCache.has(browserId)) return keyCache.get(browserId);
    const labels = safeStorageLabelsFor(browserId);
    let password;
    let lastReason = 'denied';
    for (const { service, account } of labels) {
      const r = credentials?.read?.({ service, account });
      if (r && r.ok && typeof r.value === 'string') { password = r.value; break; }
      if (r && typeof r.reason === 'string') lastReason = r.reason;
    }
    if (password === undefined) {
      note(`safe storage unavailable for ${browserId}: ${lastReason}`);
      throw new CookieReadError(lastReason); // reason only — never the password
    }
    const key = deriveSafeStorageKey(password);
    keyCache.set(browserId, key);
    return key;
  }

  function availableStores(browserId) {
    if (platform !== 'darwin') return [];
    const roots = chromiumRoots({ browserIds: [browserId] });
    return roots.flatMap(({ url }) => discoverProfileStores({ root: url, browserId, fs }));
  }

  function read({ databaseURL, store, browserId, domains = [], match = 'exact', includeExpired = false, now: nowArg } = {}) {
    if (platform !== 'darwin') throw new CookieReadError('unavailable');
    // B2a finding: sqlCondition([]) collapses to `1=1` (every cookie in the profile). An empty or
    // missing domain list must open NOTHING — refuse before any copy or db open.
    if (!Array.isArray(domains) || domains.length === 0) throw new CookieReadError('no-domains');
    const sourceDB = databaseURL ?? store?.databaseURL;
    const bid = browserId ?? store?.browserId;
    if (!sourceDB) throw new CookieReadError('not-found');
    if (isRealProfilePathBlocked(sourceDB)) throw new CookieReadError('unavailable'); // test process: never copy a real DB

    const dir = fs.mkdtempSync(join(tmpDir, 'sweet-cookie-kit-chrome-cookies-'));
    try {
      const copied = join(dir, 'Cookies');
      fs.copyFileSync(sourceDB, copied); // copy the live DB; the live file is never opened
      for (const suffix of ['-wal', '-shm']) {
        const src = sourceDB + suffix;
        if (fs.existsSync(src)) { try { fs.copyFileSync(src, copied + suffix); } catch { /* best-effort sidecar */ } }
      }

      const db = openDatabase(copied, { readOnly: true }); // only the disposable copy, read-only
      try {
        const version = readVersion(db);
        const condition = sqlCondition('host_key', domains, match);
        const sql = `SELECT host_key, name, path, expires_utc, is_secure, is_httponly, value, encrypted_value FROM cookies WHERE ${condition}`;
        const stmt = db.prepare(sql);
        stmt.setReadBigInts(true);

        const records = [];
        for (const row of stmt.iterate()) {
          const hostKey = String(row.host_key);
          const name = String(row.name);
          const path = String(row.path ?? '');
          const plain = row.value;
          const enc = row.encrypted_value;

          let value;
          if (typeof plain === 'string' && plain.length > 0) {
            value = plain;
          } else if (enc && enc.length > 0) {
            // Only now — a value that needs decryption was found — request the Safe Storage password.
            const key = fetchSafeStorageKey(bid);
            const decrypted = decryptChromiumValue(Buffer.from(enc), key, hostKey, version);
            if (decrypted === null) { note(`skipped undecryptable cookie for ${normalizeDomain(hostKey)}`); continue; }
            value = decrypted;
          } else {
            continue;
          }

          records.push({
            name, value,
            domain: normalizeDomain(hostKey),
            path,
            expires: chromeExpiryToEpochMs(row.expires_utc),
            secure: toBool(row.is_secure),
            httpOnly: toBool(row.is_httponly),
          });
        }

        const nowMs = nowArg ?? now ?? Date.now();
        const kept = includeExpired ? records : records.filter(r => r.expires === null || r.expires >= nowMs);
        return { records: kept, cookieHeader: (d) => cookieHeader(kept, d) };
      } finally {
        db.close();
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup of our temp copy */ }
    }
  }

  return { availableStores, read };
}

function readVersion(db) {
  let stmt;
  try {
    stmt = db.prepare("SELECT value FROM meta WHERE key = 'version'");
    stmt.setReadBigInts(true);
  } catch {
    throw new CookieReadError('load-failed');
  }
  const row = stmt.get();
  if (!row || row.value === undefined || row.value === null) throw new CookieReadError('load-failed');
  return Number(row.value);
}
