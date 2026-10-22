// Raw usage-response store: every HTTP response a usage reader receives, kept verbatim (minus secrets) in
// ~/.config/ocli/data/raw_usage.sqlite — gzip, content-addressed blobs + an append-only fetches table (agent rule: keep fetched
// data raw). The recording transport is the ONE seam every reader shares: index.mjs wraps each reader's own
// transport with it, so no reader has to know the store exists.
//
// Never stored: request headers that carry credentials (Authorization, Cookie, Set-Cookie, X-CSRF*, X-XSRF*,
// X-API-Key, any name containing token/secret), the body of a token endpoint (OAuth token / refresh), and every
// known secret value (the request's own credential header values plus the run's live redaction set, which index.mjs
// shares with the reader) inside a body or URL.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CODEX_REFRESH_ENDPOINT } from './natives/codex.mjs';

const isTestProcess = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
export const DEFAULT_RAW_USAGE_DB = join(homedir(), '.config', 'ocli', 'data', 'raw_usage.sqlite');

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-csrf.*|x-xsrf.*)$|token|secret/i;
const SECRET_PARAM = /token|secret|key|password|auth|session|csrf|xsrf/i;

/** OAuth token / refresh endpoints: their response IS a credential, so the body is never kept. */
export function isTokenEndpoint(url) {
  if (String(url).startsWith(CODEX_REFRESH_ENDPOINT)) return true;
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return true; } // unparseable: assume the worst
  return /(^|\/)(oauth\/)?token(\/|$)|refresh/i.test(pathname);
}

/** Request headers with every credential header dropped; the dropped values come back as secrets to redact. */
export function stripHeaders(headers) {
  const kept = {};
  const secrets = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!SECRET_HEADER.test(name)) { kept[name] = String(value); continue; }
    const v = String(value ?? '');
    secrets.push(v, v.replace(/^\s*(bearer|basic|token)\s+/i, ''));
    for (const part of v.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) secrets.push(part.slice(eq + 1).trim());
    }
  }
  return { headers: kept, secrets };
}

function redactText(text, secrets) {
  let out = text;
  // Shortest secrets are skipped: a 3-char "value" would shred the body for nothing.
  for (const v of [...secrets].filter(s => typeof s === 'string' && s.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('<redacted>');
  }
  return out;
}

function redactURL(url, secrets) {
  let parsed;
  try { parsed = new URL(url); } catch { return redactText(String(url), secrets); }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) parsed.searchParams.set(name, '<redacted>');
  }
  parsed.username = '';
  parsed.password = '';
  return redactText(parsed.href, secrets);
}

/**
 * Opens (creating) the store at `path`. `record(request, response, secrets)` appends one fetch; it never throws to
 * the caller (index.mjs wraps it anyway). WAL; tables blobs(sha256 PK, gz, bytes) and fetches(id, method, url,
 * fetched_at, status, content_type, request_headers JSON, body_sha256).
 */
export async function openRawStore(path, { now = () => new Date() } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, gz BLOB NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fetches (id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, url TEXT NOT NULL,
      fetched_at TEXT NOT NULL, status INTEGER, content_type TEXT, request_headers TEXT NOT NULL,
      body_sha256 TEXT REFERENCES blobs(sha256));`);
  const putBlob = db.prepare('INSERT OR IGNORE INTO blobs (sha256, gz, bytes) VALUES (?, ?, ?)');
  const putFetch = db.prepare(`INSERT INTO fetches (method, url, fetched_at, status, content_type, request_headers, body_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  return {
    path,
    db,
    record(request, response, extraSecrets = []) {
      const { headers, secrets } = stripHeaders(request.headers);
      const all = [...secrets, ...extraSecrets];
      let sha = null;
      if (!isTokenEndpoint(request.url) && response?.body !== undefined && response?.body !== null) {
        const raw = typeof response.body === 'string' ? response.body : Buffer.from(response.body).toString('utf8');
        const body = Buffer.from(redactText(raw, all), 'utf8');
        sha = createHash('sha256').update(body).digest('hex');
        putBlob.run(sha, gzipSync(body), body.length);
      }
      const contentType = Object.entries(response?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
      putFetch.run(String(request.method ?? 'GET'), redactURL(request.url, all), now().toISOString(),
        Number.isInteger(response?.status) ? response.status : null, contentType === null ? null : String(contentType),
        JSON.stringify(headers), sha);
    },
    close() { db.close(); },
  };
}

/**
 * The store index.mjs uses when none is injected: env OCLI_RAW_USAGE_DB, else ~/.config/ocli/data/raw_usage.sqlite.
 * In a test process it is OFF (null) — the env var is ignored there too, so a stray shell variable can never make
 * vitest write a real database; a test injects its own store.
 */
let defaultStore;
export function defaultRawStore(env = process.env) {
  if (isTestProcess()) return null;
  defaultStore ??= openRawStore(env.OCLI_RAW_USAGE_DB || DEFAULT_RAW_USAGE_DB).catch(() => null);
  return defaultStore;
}

/**
 * Wraps a reader transport: the response passes through untouched, and a copy goes to the store. A store failure
 * never fails the read (it is logged without any request detail). `secrets`: extra known values to redact — an
 * iterable read at each write, so a Set the reader keeps filling is a live view.
 */
export function recordingTransport(inner, store, { secrets = [], log = () => {} } = {}) {
  if (!store) return inner;
  return async request => {
    const response = await inner(request);
    try {
      (await store)?.record(request, response, secrets);
    } catch (error) {
      log({ category: 'raw-store', message: `raw usage record skipped: ${error?.code ?? error?.name ?? 'error'}` });
    }
    return response;
  };
}
