// Q21: for a reader that came back unavailable, say WHICH setting it needs and where it may come from. Names and
// commands only — never a value, an identity, or anything read from the reading beside its status/reason.
import { loadBundledPlugin, readProviderSection } from './plugin-host.mjs';
import { USAGE_READERS_KEYCHAIN_SERVICE } from './credentials.mjs';

const PLUGIN_FOR = { glm: 'zai', muse: 'muse', cline: 'clinepass' };

function secureKeys(provider) {
  try {
    const { manifest } = loadBundledPlugin(PLUGIN_FOR[provider]);
    return { id: manifest.id, keys: manifest.settings.filter(s => s.kind === 'secure').map(s => s.key) };
  } catch { return { id: PLUGIN_FOR[provider], keys: [] }; }
}

/** Has the user consented to reading Claude Code's keychain item? env === '1' or config === true; default off. */
export function claudeConsentGiven({ env = process.env, configPath } = {}) {
  const section = readProviderSection('claude', { env, configPath }).section;
  return env.OCLI_CLAUDE_KEYCHAIN_CONSENT === '1' || section?.keychainReadConsent === true;
}

function secureNeeds(id, keys) {
  return {
    needs: keys.map(k => `${k}: env ${k}, keychain service ${USAGE_READERS_KEYCHAIN_SERVICE} account ${id}.${k}, or usage-readers.json { "${id}": { "${k}": ... } }`),
    command: keys.map(k => `security add-generic-password -s ${USAGE_READERS_KEYCHAIN_SERVICE} -a ${id}.${k} -w`),
  };
}

/** { provider, reason, needs: string[], command?: string[] } or null when there is nothing actionable to say. */
export function setupHint(provider, reading, { claudeConsent = false } = {}) {
  const reason = typeof reading?.reason === 'string' ? reading.reason : '';
  if (reading?.status === 'ok' || !reason) return null;
  if (provider === 'claude' && reason.includes('credentials-keychain-access-revoked')) {
    return { provider, reason: 'credentials-keychain-access-revoked', needs: [
      'keychain access to Claude Code\'s item was denied: re-allow it in Keychain Access, or unset OCLI_CLAUDE_KEYCHAIN_CONSENT / keychainReadConsent'] };
  }
  if (provider === 'claude' && reason.includes('credentials-not-found')) {
    if (claudeConsent) return { provider, reason: 'credentials-not-found', needs: ['Claude Code has no stored credential: run `claude` once and sign in'] };
    return { provider, reason: 'credentials-not-found', needs: [
      'consent to read Claude Code\'s keychain item (read-only, never written; default off):',
      'env OCLI_CLAUDE_KEYCHAIN_CONSENT=1, or usage-readers.json { "claude": { "keychainReadConsent": true } }'] };
  }
  if (!PLUGIN_FOR[provider]) return null;
  if (reason.includes('plugin:secret-access')) {
    const { id, keys } = secureKeys(provider);
    if (!keys.length) return null;
    return { provider, reason: 'secret-access', ...secureNeeds(id, keys) };
  }
  if (reason.includes('plugin:authentication-expired')) {
    // The plugin throws this when its secure setting is absent as well as when it is rejected: name the setting.
    const { id, keys } = secureKeys(provider);
    const { needs, command } = secureNeeds(id, keys);
    return { provider, reason: 'authentication-expired',
      needs: [`the ${provider} login is missing or expired: log in to ${provider === 'muse' ? 'Muse Code' : provider} again, then store the new credential:`, ...needs],
      ...(command.length ? { command } : {}) };
  }
  return null;
}
