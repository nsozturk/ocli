import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { openRawStore, recordingTransport, defaultRawStore, isTokenEndpoint, stripHeaders } from '../dispatcher/usage-readers/raw-store.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { readProviderUsage } from '../dispatcher/usage-readers/index.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { CODEX_REFRESH_ENDPOINT } from '../dispatcher/usage-readers/natives/codex.mjs';

// The store lives in a temp dir per test; the default store is never opened in a test process.

let dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'd-raw-')); dirs.push(d); return d; };
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.unstubAllEnvs();
});
async function store() {
  const s = await openRawStore(join(temp(), 'raw_usage.sqlite'), { now: () => new Date('2026-10-21T10:00:00.000Z') });
  stores.push(s);
  return s;
}
type Row = { id: number; method: string; url: string; fetched_at: string; status: number | null; content_type: string | null; request_headers: string; body_sha256: string | null };
const fetches = (s: any): Row[] => s.db.prepare('SELECT * FROM fetches ORDER BY id').all();
const blob = (s: any, sha: string) => {
  const row = s.db.prepare('SELECT gz, bytes FROM blobs WHERE sha256 = ?').get(sha);
  return row ? { text: gunzipSync(row.gz).toString('utf8'), bytes: row.bytes } : null;
};
const allBlobText = (s: any) => s.db.prepare('SELECT gz FROM blobs').all().map((r: { gz: Uint8Array }) => gunzipSync(r.gz).toString('utf8')).join('\n');
const fixedResponse = (body: string, status = 200) => vi.fn(async () => ({ status, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(body) }));

const BEARER = 'bearer-SECRET-value-0001';
const COOKIE_VAL = 'cookie-SECRET-value-0002';
const CSRF = 'csrf-SECRET-value-0003';
const API_KEY = 'apikey-SECRET-value-0004';
const SESSION_TOKEN = 'session-SECRET-value-0005';
const ALL = [BEARER, COOKIE_VAL, CSRF, API_KEY, SESSION_TOKEN];

describe('slice D — raw_usage.sqlite: raw, content-addressed, append-only, secrets stripped', () => {
  it('records every response; strips Authorization, Cookie, X-CSRF*, X-API-Key and *token* headers; redacts their values in the body', async () => {
    const s = await store();
    const inner = fixedResponse(`{"echo":"${BEARER}","c":"${COOKIE_VAL}","x":"${CSRF}","k":"${API_KEY}","t":"${SESSION_TOKEN}","used":42}`);
    const t = recordingTransport(inner, s);
    const req = { url: 'https://api.example.test/v1/usage?team=1', method: 'GET', headers: {
      Authorization: `Bearer ${BEARER}`, Cookie: `sid=${COOKIE_VAL}; theme=dark`, 'X-CSRF-Token': CSRF, 'X-XSRF-TOKEN': CSRF,
      'X-API-Key': API_KEY, 'X-Session-Token': SESSION_TOKEN, 'X-Client-Secret': SESSION_TOKEN, Accept: 'application/json' } };
    const res = await t(req);
    expect(res.body.toString()).toContain(BEARER); // the reader still gets the response untouched
    const [row] = fetches(s);
    expect(row).toMatchObject({ method: 'GET', url: 'https://api.example.test/v1/usage?team=1', fetched_at: '2026-10-21T10:00:00.000Z', status: 200, content_type: 'application/json' });
    expect(JSON.parse(row.request_headers)).toEqual({ Accept: 'application/json' });
    const stored = blob(s, row.body_sha256!)!;
    expect(stored.text).toContain('"used":42');
    for (const secret of ALL) expect(stored.text).not.toContain(secret);
    expect(row.body_sha256).toBe(createHash('sha256').update(stored.text).digest('hex'));
    expect(stored.bytes).toBe(Buffer.byteLength(stored.text));
    const everything = JSON.stringify(fetches(s)) + allBlobText(s);
    for (const secret of ALL) expect(everything).not.toContain(secret);
  });

  it('extra known secrets (the run redaction set) are replaced in bodies and URLs; secret query params are masked', async () => {
    const s = await store();
    const t = recordingTransport(fixedResponse('{"key":"run-SECRET-abcdef","ok":true}'), s, { secrets: ['run-SECRET-abcdef'] });
    await t({ url: 'https://api.example.test/u?api_key=qq-SECRET-1234&path=run-SECRET-abcdef&page=2', method: 'GET', headers: {} });
    const [row] = fetches(s);
    expect(row.url).not.toContain('qq-SECRET');
    expect(row.url).not.toContain('run-SECRET');
    expect(row.url).toContain('page=2');
    expect(blob(s, row.body_sha256!)!.text).toBe('{"key":"<redacted>","ok":true}');
  });

  it('never records the body of a token endpoint (codex refresh, any /oauth/token, any refresh URL) — the row only', async () => {
    const s = await store();
    const tokenBody = '{"access_token":"new-access-SECRET-9","refresh_token":"new-refresh-SECRET-9","id_token":"id-SECRET-9"}';
    const t = recordingTransport(fixedResponse(tokenBody), s);
    for (const url of [CODEX_REFRESH_ENDPOINT, 'https://platform.claude.com/v1/oauth/token', 'https://api.example.test/auth/refresh', 'https://x.example.test/token']) {
      await t({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"grant_type":"refresh_token"}' });
    }
    const rows = fetches(s);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.body_sha256).toBeNull();
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(0);
    expect(JSON.stringify(rows)).not.toContain('SECRET-9');
    expect(isTokenEndpoint('https://chatgpt.com/backend-api/wham/usage')).toBe(false);
    expect(isTokenEndpoint('not a url')).toBe(true);
  });

  it('identical bodies share one blob; fetches are append-only', async () => {
    const s = await store();
    const t = recordingTransport(fixedResponse('{"same":true}'), s);
    for (let i = 0; i < 3; i += 1) await t({ url: 'https://api.example.test/u', method: 'GET', headers: {} });
    expect(fetches(s).map(r => r.id)).toEqual([1, 2, 3]);
    expect(new Set(fetches(s).map(r => r.body_sha256)).size).toBe(1);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(1);
    expect(s.db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
  });

  it('a store failure never fails the read and logs no request detail', async () => {
    const logs: unknown[] = [];
    const broken = { record: () => { throw Object.assign(new Error(`disk full ${BEARER}`), { code: 'SQLITE_FULL' }); } };
    const t = recordingTransport(fixedResponse('{"ok":1}'), broken, { log: (l: unknown) => logs.push(l) });
    const res = await t({ url: 'https://api.example.test/u', method: 'GET', headers: { Authorization: `Bearer ${BEARER}` } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(logs)).not.toContain(BEARER);
    expect(JSON.stringify(logs)).toContain('SQLITE_FULL');
  });

  it('no store ⇒ the inner transport is returned as is; the default store is off in a test process, even with OCLI_RAW_USAGE_DB set', async () => {
    const inner = fixedResponse('{}');
    expect(recordingTransport(inner, null)).toBe(inner);
    const path = join(temp(), 'stray.sqlite');
    vi.stubEnv('OCLI_RAW_USAGE_DB', path);
    expect(defaultRawStore()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('stripHeaders hands back each credential value (bearer stripped, each cookie value) for redaction', () => {
    const { headers, secrets } = stripHeaders({ authorization: 'Bearer abcdef123', cookie: 'a=one111; b=two222', 'User-Agent': 'x' });
    expect(headers).toEqual({ 'User-Agent': 'x' });
    expect(secrets).toEqual(expect.arrayContaining(['Bearer abcdef123', 'abcdef123', 'one111', 'two222']));
  });
});

describe('slice D — the recording transport is the seam index.mjs gives every reader', () => {
  it('a real codex read through index.mjs records the usage response with no Authorization header and no token', async () => {
    const s = await store();
    const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Date.parse('2026-10-18T12:00:00Z');
    const access = `${b64url({ alg: 'none' })}.${b64url({ exp: now / 1000 + 3600, sub: 'access-SECRET-seam' })}.c2ln`;
    const home = temp();
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: access, refresh_token: 'refresh-SECRET-seam', account_id: 'acct-seam' } }));
    const usage = JSON.stringify({ rate_limit: { primary_window: { used_percent: 5, reset_at: now / 1000 + 60, limit_window_seconds: 18000 } }, echo: access });
    const transport = fixedResponse(usage);
    const r = await readProviderUsage('codex', { rawStore: s, transport, env: { CODEX_HOME: home }, homeDir: temp(), now: () => now,
      sleep: async () => {}, resolveCodexBinary: () => null, sourceMode: 'oauth' });
    expect(r.status).toBe('ok');
    const [row] = fetches(s);
    expect(row.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    const headers = JSON.parse(row.request_headers);
    expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('authorization');
    const text = blob(s, row.body_sha256!)!.text;
    expect(text).toContain('"used_percent":5');
    expect(text).not.toContain(access);
    expect(JSON.stringify(fetches(s)) + allBlobText(s)).not.toContain('SECRET-seam');
  });

  it('an index read with no store injected opens nothing (test process): rawStore defaults off', async () => {
    const transport = fixedResponse('{}');
    const r = await readProviderUsage('glm', { transport, env: {}, configPath: join(temp(), 'c.json'), cookieSource: null });
    expect(r.status).not.toBe('ok');
  });
});
