import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// u4-d-wiring review pins: each test kills one mutant the slice's own tests let survive.
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { openRawStore, recordingTransport } from '../dispatcher/usage-readers/raw-store.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { readProviderUsage } from '../dispatcher/usage-readers/index.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { nodeFetchTransport } from '../dispatcher/usage-readers/plugin-host.mjs';

let dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
async function store() {
  const d = mkdtempSync(join(tmpdir(), 'd-pins-'));
  dirs.push(d);
  const s = await openRawStore(join(d, 'raw_usage.sqlite'));
  stores.push(s);
  return s;
}
const dump = (s: any) => JSON.stringify(s.db.prepare('SELECT * FROM fetches').all())
  + s.db.prepare('SELECT gz FROM blobs').all().map((r: { gz: Uint8Array }) => gunzipSync(r.gz).toString('utf8')).join('\n');
const fixed = (body: string) => vi.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(body) }));

describe('u4-d-wiring review pins', () => {
  it('a token-endpoint row still has its credential headers stripped', async () => {
    const s = await store();
    await recordingTransport(fixed('{"access_token":"x"}'), s)({ url: 'https://auth.openai.com/oauth/token', method: 'POST',
      headers: { Authorization: 'Bearer tokrow-SECRET-01', 'Content-Type': 'application/json' } });
    const [row] = s.db.prepare('SELECT request_headers FROM fetches').all() as Array<{ request_headers: string }>;
    expect(JSON.parse(row.request_headers)).toEqual({ 'Content-Type': 'application/json' });
    expect(dump(s)).not.toContain('tokrow-SECRET-01');
  });

  it('URL userinfo never reaches the stored url', async () => {
    const s = await store();
    await recordingTransport(fixed('{}'), s)({ url: 'https://alice:pw-SECRET-77@api.example.test/u', method: 'GET', headers: {} });
    expect(dump(s)).not.toContain('pw-SECRET-77');
    expect(dump(s)).not.toContain('alice');
  });

  it('opts.secrets reaches the recording transport: an echoed known secret is redacted in the stored body', async () => {
    const s = await store();
    const read = vi.fn(async (options: { transport: (r: unknown) => Promise<unknown> }) => {
      await options.transport({ url: 'https://api.example.test/u', method: 'GET', headers: {} });
      return { reading: { status: 'ok', windows: [] } };
    });
    await readProviderUsage('codex', { rawStore: s, secrets: ['echo-SECRET-xyz9'], transport: fixed('{"e":"echo-SECRET-xyz9"}'), readers: { codex: { read } } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(dump(s)).not.toContain('echo-SECRET-xyz9');
  });

  it('in a test process a plugin read with nothing injected gets a refusing transport and a nonexistent config path', async () => {
    const read = vi.fn(async () => ({ reading: { status: 'unavailable', reason: 'stub', windows: [] } }));
    await readProviderUsage('glm', { readers: { plugin: { read } } });
    const options = (read.mock.calls[0] as unknown as [string, { configPath: string; transport: (r: unknown) => Promise<unknown> }])[1];
    expect(options.configPath.startsWith('/nonexistent/')).toBe(true);
    // Identity check first: a mutant that hands the real node fetch transport must fail here, before any call.
    expect(options.transport).not.toBe(nodeFetchTransport);
    await expect(options.transport({ url: 'https://x.invalid/', method: 'GET', headers: {} })).rejects.toThrow(/refused/);
  });
});
