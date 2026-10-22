import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  spawn: vi.fn(() => { throw new Error('spawn refused in test'); }),
  spawnSync: vi.fn(() => { throw new Error('spawnSync refused in test'); }),
  execFile: vi.fn(() => { throw new Error('execFile refused in test'); }),
}));

// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { readProviderUsage } from '../dispatcher/usage-readers/index.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { setupHint, claudeConsentGiven } from '../dispatcher/usage-readers/doctor.mjs';

const unavailable = (reason: string) => ({ status: 'unavailable', source: null, updatedAt: null, windows: [], reason });
const calls = () => { const seen: Record<string, unknown>[] = []; const read = vi.fn(async (o: Record<string, unknown>) => { seen.push(o); return { reading: unavailable('x') }; }); return { seen, read }; };
const cfg = (body: unknown) => { const d = mkdtempSync(join(tmpdir(), 'q21-')); const p = join(d, 'usage-readers.json'); writeFileSync(p, JSON.stringify(body)); return { d, p }; };

describe('Q21 claude keychain consent', () => {
  it('default is OFF', async () => {
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: {}, configPath: '/nonexistent/q21.json', readers: { claude: { read } } });
    expect(seen[0].keychainReadConsent).toBe(false);
  });
  it('env OCLI_CLAUDE_KEYCHAIN_CONSENT=1 turns it on', async () => {
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: { OCLI_CLAUDE_KEYCHAIN_CONSENT: '1' }, configPath: '/nonexistent/q21.json', readers: { claude: { read } } });
    expect(seen[0].keychainReadConsent).toBe(true);
  });
  it('env other than 1 stays off', async () => {
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: { OCLI_CLAUDE_KEYCHAIN_CONSENT: '0' }, configPath: '/nonexistent/q21.json', readers: { claude: { read } } });
    expect(seen[0].keychainReadConsent).toBe(false);
  });
  it('config { claude: { keychainReadConsent: true } } turns it on', async () => {
    const { d, p } = cfg({ claude: { keychainReadConsent: true } });
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: {}, configPath: p, readers: { claude: { read } } });
    rmSync(d, { recursive: true, force: true });
    expect(seen[0].keychainReadConsent).toBe(true);
  });
  it('config with a non-true value stays off', async () => {
    const { d, p } = cfg({ claude: { keychainReadConsent: 'yes' } });
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: {}, configPath: p, readers: { claude: { read } } });
    rmSync(d, { recursive: true, force: true });
    expect(seen[0].keychainReadConsent).toBe(false);
  });
  // Review pin (mutant M13): a caller's explicit consent is never overridden by env or config.
  it('an explicit keychainReadConsent from the caller wins over env and config', async () => {
    const off = calls();
    await readProviderUsage('claude', { rawStore: null, env: { OCLI_CLAUDE_KEYCHAIN_CONSENT: '1' }, configPath: '/nonexistent/q21.json', keychainReadConsent: false, readers: { claude: { read: off.read } } });
    expect(off.seen[0].keychainReadConsent).toBe(false);
    const on = calls();
    await readProviderUsage('claude', { rawStore: null, env: {}, configPath: '/nonexistent/q21.json', keychainReadConsent: true, readers: { claude: { read: on.read } } });
    expect(on.seen[0].keychainReadConsent).toBe(true);
  });
  it('an uninjected config path fails closed in a test process', async () => {
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: {}, readers: { claude: { read } } });
    expect(seen[0].keychainReadConsent).toBe(false);
  });
  it('an env-pointed consenting config is ignored without an injected path in a test process', async () => {
    const { d, p } = cfg({ claude: { keychainReadConsent: true } });
    const { seen, read } = calls();
    await readProviderUsage('claude', { rawStore: null, env: { OCLI_USAGE_READERS_CONFIG: p }, readers: { claude: { read } } });
    rmSync(d, { recursive: true, force: true });
    expect(seen[0].keychainReadConsent).toBe(false);
  });
});

describe('Q21 doctor hints', () => {
  const cmd = (a: string) => `security add-generic-password -s ocli-usage-readers -a ${a} -w`;
  it('claude credentials-not-found => consent hint', () => {
    const h = setupHint('claude', unavailable('native:claude:credentials-not-found'));
    const t = JSON.stringify(h);
    expect(t).toContain('OCLI_CLAUDE_KEYCHAIN_CONSENT');
    expect(t).toContain('keychainReadConsent');
  });
  it('glm secret-access => key name, keychain account and command', () => {
    const t = JSON.stringify(setupHint('glm', unavailable('plugin:secret-access')));
    expect(t).toContain('Z_AI_API_KEY');
    expect(t).toContain('zai.Z_AI_API_KEY');
    expect(t).toContain(cmd('zai.Z_AI_API_KEY'));
  });
  it('glm hint names only secure keys, each with its keychain account', () => {
    const h = setupHint('glm', unavailable('plugin:secret-access'));
    expect(h.command).toEqual([cmd('zai.Z_AI_API_KEY')]);
    expect(h.needs).toHaveLength(1);
    expect(h.needs[0]).toContain('keychain service ocli-usage-readers account zai.Z_AI_API_KEY');
  });
  it('cline secret-access => CLINE_API_KEY', () => {
    const t = JSON.stringify(setupHint('cline', unavailable('plugin:secret-access')));
    expect(t).toContain(cmd('clinepass.CLINE_API_KEY'));
  });
  it('muse authentication-expired => re-login line plus the secure key, keychain account and command', () => {
    const h = setupHint('muse', unavailable('plugin:authentication-expired'));
    const t = JSON.stringify(h);
    expect(t.toLowerCase()).toContain('log in');
    expect(t).toContain('MUSE_DEVICE_TOKEN');
    expect(h.needs.join('\n')).toContain('keychain service ocli-usage-readers account muse.MUSE_DEVICE_TOKEN');
    expect(h.needs.join('\n')).toContain('"muse": { "MUSE_DEVICE_TOKEN"');
    expect(h.command).toEqual([cmd('muse.MUSE_DEVICE_TOKEN')]);
  });
  it('claude credentials-not-found with consent already given => no consent ask, sign-in hint', () => {
    const h = setupHint('claude', unavailable('native:claude:credentials-not-found'), { claudeConsent: true });
    const t = JSON.stringify(h);
    expect(t).not.toContain('OCLI_CLAUDE_KEYCHAIN_CONSENT');
    expect(t).not.toContain('keychainReadConsent');
    expect(t).toContain('sign in');
  });
  it('claude credentials-keychain-access-revoked => re-allow or unset consent', () => {
    const t = JSON.stringify(setupHint('claude', unavailable('native:claude:credentials-keychain-access-revoked'), { claudeConsent: true }));
    expect(t).toContain('Keychain Access');
    expect(t).toContain('OCLI_CLAUDE_KEYCHAIN_CONSENT');
  });
  it('claudeConsentGiven follows env === 1 or config === true, default off', () => {
    const { d, p } = cfg({ claude: { keychainReadConsent: true } });
    const on = claudeConsentGiven({ env: {}, configPath: p });
    const off = claudeConsentGiven({ env: {}, configPath: '/nonexistent/q21.json' });
    const envOn = claudeConsentGiven({ env: { OCLI_CLAUDE_KEYCHAIN_CONSENT: '1' }, configPath: '/nonexistent/q21.json' });
    const envOther = claudeConsentGiven({ env: { OCLI_CLAUDE_KEYCHAIN_CONSENT: 'true' }, configPath: '/nonexistent/q21.json' });
    rmSync(d, { recursive: true, force: true });
    expect([on, off, envOn, envOther]).toEqual([true, false, true, false]);
  });
  it('ok readings and unknown reasons give no hint', () => {
    expect(setupHint('glm', { status: 'ok', windows: [] })).toBeNull();
    expect(setupHint('codex', unavailable('whatever'))).toBeNull();
  });
  it('never carries a value or identity', () => {
    const h = JSON.stringify([setupHint('glm', { ...unavailable('plugin:secret-access'), email: 'a@b.invalid', token: 'SECRET-q21' }),
      setupHint('claude', { ...unavailable('native:claude:credentials-not-found'), email: 'a@b.invalid' })]);
    expect(h).not.toContain('SECRET-q21');
    expect(h).not.toContain('a@b.invalid');
    expect(h).not.toMatch(/-w\s+\S/);
  });
});
