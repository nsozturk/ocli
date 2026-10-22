import { describe, expect, it, vi } from 'vitest';

// Lead pin (B1 survivor): the default store must never spawn `security` from a test process.
// child_process is mocked, so even a broken guard cannot reach the real keychain.
const spawnSync = vi.fn(() => ({ status: 44, stdout: '', stderr: '' }));
vi.mock('node:child_process', () => ({ spawnSync }));

// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
const { createCredentialStore, isRealKeychainBlocked } = await import('../dispatcher/usage-readers/credentials.mjs');

describe('B1 keychain test-process guard', () => {
  it('blocks the real keychain under VITEST, NODE_ENV=test or OCLI_DISABLE_KEYCHAIN=1', () => {
    expect(isRealKeychainBlocked({ VITEST: 'true' })).toBe(true);
    expect(isRealKeychainBlocked({ NODE_ENV: 'test' })).toBe(true);
    expect(isRealKeychainBlocked({ OCLI_DISABLE_KEYCHAIN: '1' })).toBe(true);
    expect(isRealKeychainBlocked({})).toBe(false);
  });

  it('a default store in a test process never spawns security', () => {
    const store = createCredentialStore({ platform: 'darwin', env: { VITEST: 'true' } });
    expect(store.read({ service: 'ocli-usage-readers', account: 'zai.Z_AI_API_KEY' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
