/**
 * macOS keychain reader behind a platform seam — a port of CodexBar's `/usr/bin/security` CLI path:
 *   Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthCredentials+SecurityCLIReader.swift
 *   (binary L13, 1.5 s timeout L14, argv L258-266, stdin nil L207, timeout ⇒ timedOut L227-229, status ≠ 0 L236-238;
 *   stderr is only ever measured, never surfaced, L233/L237).
 * CodexBar's CLI path only distinguishes "non-zero exit"; the reason split below follows its Security.framework
 * statuses (KeychainAccessPreflight.swift L273-282, KeychainSecurity.swift L107), which `security` reports as the
 * low byte of the OSStatus. Test processes fail closed like KeychainSecurity.swift L26 (KeychainTestSafety).
 * The value is never logged and never put in an error or a reason; stderr from `security` is dropped.
 */
import { spawnSync } from 'node:child_process';

export const SECURITY_BINARY = '/usr/bin/security';
export const SECURITY_READ_TIMEOUT_MS = 1500;
export const USAGE_READERS_KEYCHAIN_SERVICE = 'ocli-usage-readers';
// CodexBar's own items (KeychainStringStore.swift). Reading them is NOT done — user decision pending. Unused.
export const CODEXBAR_KEYCHAIN_SERVICE = 'com.steipete.CodexBar';

const EXIT_REASONS = new Map([
  [44, 'not-found'],             // errSecItemNotFound -25300
  [51, 'denied'],                // errSecAuthFailed -25293
  [128, 'denied'],               // errSecUserCanceled -128
  [36, 'interaction-required'],  // errSecInteractionNotAllowed -25308
]);

export class CredentialError extends Error {
  constructor(reason) {
    super(`keychain read failed: ${reason}`);
    this.name = 'CredentialError';
    this.reason = reason;
  }
}

/** KeychainTestSafety: never touch the real keychain from a test process or when disabled by env. */
export function isRealKeychainBlocked(env = process.env) {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test' || env.OCLI_DISABLE_KEYCHAIN === '1';
}

const realRun = (file, args, options) => spawnSync(file, args, options);

export function createCredentialStore({ platform = process.platform, run, log = () => {}, env = process.env } = {}) {
  const runner = run ?? (isRealKeychainBlocked(env) ? null : realRun);
  const note = (account, reason) => { log({ category: 'credentials', message: `keychain ${account}: ${reason}` }); };
  // `anyAccount: true` (explicit, with no account) omits `-a`, as CodexBar's background Claude read does
  // (ClaudeOAuthCredentials+SecurityCLIReader.swift L258-266 with a nil account). Without it a missing account never spawns.
  function read({ service, account, anyAccount = false } = {}) {
    const unscoped = anyAccount === true && !account;
    if (platform !== 'darwin' || !runner || !service || (!account && !unscoped)) return { ok: false, reason: 'unavailable' };
    const args = unscoped ? ['find-generic-password', '-s', service, '-w'] : ['find-generic-password', '-s', service, '-a', account, '-w'];
    const label = account || service;
    let out;
    try {
      out = runner(SECURITY_BINARY, args, {
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: SECURITY_READ_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8',
      });
    } catch {
      note(label, 'unavailable');
      return { ok: false, reason: 'unavailable' };
    }
    let reason = null;
    if (out?.error) reason = out.error.code === 'ETIMEDOUT' ? 'timeout' : 'unavailable';
    else if (out?.status !== 0) reason = EXIT_REASONS.get(out?.status) ?? 'unavailable';
    if (reason) { note(label, reason); return { ok: false, reason }; }
    let value = typeof out.stdout === 'string' ? out.stdout : String(out.stdout ?? '');
    if (value.endsWith('\n')) value = value.slice(0, -1);
    if (!value) { note(label, 'not-found'); return { ok: false, reason: 'not-found' }; }
    note(label, 'ok');
    return { ok: true, value };
  }
  function readValue(query) {
    const result = read(query);
    if (!result.ok) throw new CredentialError(result.reason);
    return result.value;
  }
  return { read, readValue };
}
