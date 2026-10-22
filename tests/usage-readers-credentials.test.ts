import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCredentialStore, isRealKeychainBlocked, CredentialError, SECURITY_BINARY, SECURITY_READ_TIMEOUT_MS,
  USAGE_READERS_KEYCHAIN_SERVICE, CODEXBAR_KEYCHAIN_SERVICE,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/credentials.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { loadPlugin, resolvePluginSettings } from '../dispatcher/usage-readers/plugin-host.mjs';

// Every `run` here is a stub — the real /usr/bin/security is never spawned and no real keychain item is read.
type Call = { file: string; args: unknown; options: Record<string, unknown> };
type Out = { status?: number | null; stdout?: string; stderr?: string; signal?: string | null; error?: Error & { code?: string } };
function stub(out: Out | ((call: Call) => Out)) {
  const calls: Call[] = [];
  const run = vi.fn((file: string, args: unknown, options: Record<string, unknown>) => {
    const call = { file, args, options };
    calls.push(call);
    const o = typeof out === 'function' ? out(call) : out;
    return { status: 0, stdout: '', stderr: '', signal: null, ...o };
  });
  return { run, calls };
}

const VALUE = 'kc-SECRET-value-9f8e7d';
const item = { service: 'ocli-usage-readers', account: 'fixture.API_KEY' };

describe('B1 credentials — darwin /usr/bin/security reader', () => {
  it('spawns /usr/bin/security with an exact argv array, no shell, stdin closed, CodexBar timeout', () => {
    const { run, calls } = stub({ stdout: `${VALUE}\n` });
    const store = createCredentialStore({ platform: 'darwin', run });
    expect(store.read(item)).toEqual({ ok: true, value: VALUE });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/usr/bin/security');
    expect(SECURITY_BINARY).toBe('/usr/bin/security');
    expect(calls[0].args).toEqual(['find-generic-password', '-s', 'ocli-usage-readers', '-a', 'fixture.API_KEY', '-w']);
    expect(calls[0].options.shell).toBe(false);
    expect((calls[0].options.stdio as unknown[])[0]).toBe('ignore');
    expect(calls[0].options.timeout).toBe(1500);
    expect(SECURITY_READ_TIMEOUT_MS).toBe(1500);
  });

  it('strips exactly one trailing newline', () => {
    expect(createCredentialStore({ platform: 'darwin', run: stub({ stdout: 'a b\n\n' }).run }).read(item)).toEqual({ ok: true, value: 'a b\n' });
    expect(createCredentialStore({ platform: 'darwin', run: stub({ stdout: 'abc' }).run }).read(item)).toEqual({ ok: true, value: 'abc' });
  });

  it('an empty value is not-found', () => {
    expect(createCredentialStore({ platform: 'darwin', run: stub({ stdout: '\n' }).run }).read(item)).toEqual({ ok: false, reason: 'not-found' });
  });

  it.each([
    [{ status: 44 }, 'not-found'],             // errSecItemNotFound (-25300) & 0xff
    [{ status: 51 }, 'denied'],                // errSecAuthFailed (-25293) & 0xff
    [{ status: 128 }, 'denied'],               // errSecUserCanceled (-128) & 0xff
    [{ status: 36 }, 'interaction-required'],  // errSecInteractionNotAllowed (-25308) & 0xff
    [{ status: 1 }, 'unavailable'],
    [{ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync /usr/bin/security ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 'timeout'],
    [{ status: null, error: Object.assign(new Error('spawnSync /usr/bin/security ENOENT'), { code: 'ENOENT' }) }, 'unavailable'],
  ] as [Out, string][])('exit %j ⇒ %s', (out, reason) => {
    expect(createCredentialStore({ platform: 'darwin', run: stub(out).run }).read(item)).toEqual({ ok: false, reason });
  });

  it('a run that throws is unavailable, never a thrown error', () => {
    const run = () => { throw new Error(`boom ${VALUE}`); };
    expect(createCredentialStore({ platform: 'darwin', run }).read(item)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('the value and stderr never reach a thrown error, the reason, or the log', () => {
    const logs: unknown[] = [];
    const log = (entry: unknown) => { logs.push(entry); };
    const denied = stub({ status: 51, stdout: VALUE, stderr: `security: password "${VALUE}" for item` });
    const store = createCredentialStore({ platform: 'darwin', run: denied.run, log });
    const result = store.read(item);
    expect(result).toEqual({ ok: false, reason: 'denied' });
    let thrown: unknown;
    try { store.readValue(item); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(CredentialError);
    expect((thrown as Error).message).toBe('keychain read failed: denied');
    expect((thrown as CredentialError).reason).toBe('denied');
    const ok = createCredentialStore({ platform: 'darwin', run: stub({ stdout: VALUE, stderr: VALUE }).run, log });
    expect(ok.readValue(item)).toBe(VALUE);
    const everything = JSON.stringify({ result, logs, thrown: String(thrown), props: Object.entries(thrown as object) });
    expect(everything).not.toContain(VALUE);
    expect(everything).not.toContain('security: password');
    expect(logs.length).toBeGreaterThan(0);
  });

  it.each(['linux', 'win32', 'freebsd'])('platform %s ⇒ unavailable without spawning', platform => {
    const { run } = stub({ stdout: VALUE });
    const store = createCredentialStore({ platform, run });
    expect(store.read(item)).toEqual({ ok: false, reason: 'unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a missing service or account never spawns', () => {
    const { run } = stub({ stdout: VALUE });
    const store = createCredentialStore({ platform: 'darwin', run });
    expect(store.read({ service: '', account: 'x' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(store.read({ service: 's', account: '' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it('the real keychain is blocked in test processes and by OCLI_DISABLE_KEYCHAIN=1 (KeychainTestSafety)', () => {
    expect(isRealKeychainBlocked({ VITEST: 'true' })).toBe(true);
    expect(isRealKeychainBlocked({ NODE_ENV: 'test' })).toBe(true);
    expect(isRealKeychainBlocked({ OCLI_DISABLE_KEYCHAIN: '1' })).toBe(true);
    expect(isRealKeychainBlocked({})).toBe(false);
  });

  it('names the services; CodexBar\'s own service is a constant only', () => {
    expect(USAGE_READERS_KEYCHAIN_SERVICE).toBe('ocli-usage-readers');
    expect(CODEXBAR_KEYCHAIN_SERVICE).toBe('com.steipete.CodexBar');
  });
});

describe('B1 resolvePluginSettings — secure: env > keychain > file; plain never touches the keychain', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const source = `defineProvider({ id: "fixture", name: "Fixture", endpoints: ["https://api.fixture.test"],
    auth: { type: "bearer", secret: "API_KEY" },
    settings: [ { key: "API_KEY", title: "Key", type: "secure" }, { key: "MODE", title: "Mode", type: "plain" } ],
    async fetchUsage() { return {}; } });`;
  function setup(file: Record<string, unknown> = { fixture: { API_KEY: 'from-file', MODE: 'file-mode' } }) {
    dir = mkdtempSync(join(tmpdir(), 'b1-settings-'));
    const path = join(dir, 'usage-readers.json');
    writeFileSync(path, JSON.stringify(file));
    return { manifest: loadPlugin(source, {}).manifest, path };
  }
  const keychain = (answers: Record<string, { ok: boolean; value?: string; reason?: string }>) => {
    const reads: { service: string; account: string }[] = [];
    return { reads, read: (q: { service: string; account: string }) => { reads.push(q); return answers[q.account] ?? { ok: false, reason: 'not-found' }; } };
  };

  it('env wins over keychain and file; keychain is not even queried', () => {
    const { manifest, path } = setup();
    const credentials = keychain({ 'fixture.API_KEY': { ok: true, value: 'from-keychain' } });
    const out = resolvePluginSettings(manifest, { env: { API_KEY: 'from-env' }, configPath: path, credentials });
    expect(out.secrets).toEqual({ API_KEY: 'from-env' });
    expect(credentials.reads).toEqual([]);
  });

  it('keychain wins over the file, queried at service ocli-usage-readers / account <providerId>.<KEY>', () => {
    const { manifest, path } = setup();
    const credentials = keychain({ 'fixture.API_KEY': { ok: true, value: 'from-keychain' } });
    const out = resolvePluginSettings(manifest, { env: {}, configPath: path, credentials });
    expect(out.secrets).toEqual({ API_KEY: 'from-keychain' });
    expect(credentials.reads).toEqual([{ service: 'ocli-usage-readers', account: 'fixture.API_KEY' }]);
  });

  it('the file is the fallback when the keychain has nothing', () => {
    const { manifest, path } = setup();
    for (const reason of ['not-found', 'denied', 'timeout', 'unavailable', 'interaction-required']) {
      const out = resolvePluginSettings(manifest, { env: {}, configPath: path, credentials: keychain({ 'fixture.API_KEY': { ok: false, reason } }) });
      expect(out.secrets).toEqual({ API_KEY: 'from-file' });
    }
  });

  it('plain settings never query the keychain, even when the env and file lack them', () => {
    const { manifest, path } = setup({ fixture: {} });
    const credentials = keychain({ 'fixture.MODE': { ok: true, value: 'from-keychain' } });
    const out = resolvePluginSettings(manifest, { env: {}, configPath: path, credentials });
    expect(out.settings).toEqual({});
    expect(credentials.reads.map(r => r.account)).toEqual(['fixture.API_KEY']);
  });

  it('a keychain value is redacted from the plugin\'s failures like every secret', async () => {
    const { path } = setup({ fixture: {} });
    const rt = loadPlugin(`defineProvider({ id: "fixture", name: "Fixture", endpoints: ["https://api.fixture.test"],
      auth: { type: "bearer", secret: "API_KEY" }, settings: [ { key: "API_KEY", title: "Key", type: "secure" } ],
      async fetchUsage(ctx) { throw new Error("bad key " + ctx.settings.getSecret("API_KEY")); } });`, {});
    const { settings, secrets } = resolvePluginSettings(rt.manifest, { env: {}, configPath: path, credentials: keychain({ 'fixture.API_KEY': { ok: true, value: VALUE } }) });
    expect(secrets).toEqual({ API_KEY: VALUE });
    const result = await rt.read({ settings, secrets });
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });
});
