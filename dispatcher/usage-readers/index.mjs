// One entry point for every developer's usage reading (slice D): the in-house ports of CodexBar's readers replace
// the `codexbar` CLI spawn. codex / claude / gemini use the native readers; glm / muse / cline run CodexBar's
// vendored JS plugins in the plugin host (zai / muse / clinepass), whose default cookieSource is the B2b broker.
//
// The reading that leaves this module is a WHITELIST copy — { status, source, updatedAt, windows, reason? } and each
// window { limitId, usedPercent, windowDurationMins, resetsAt } — so identity (email, org, account id, plan) never
// reaches the tree, a log or the CLI output, whatever a reader returns beside it. limitIds pass through unchanged:
// they are what the plans' limitIds bind on (codex, zai-primary, antigravity-quota-summary-gemini-*, claude's
// "5-hour limit" / "Weekly · all models").

import { readCodexNativeUsage, defaultCodexTransport } from './natives/codex.mjs';
import { readClaudeNativeUsage, defaultClaudeTransport } from './natives/claude.mjs';
import { readAntigravityNativeUsage, defaultAntigravityTransport } from './natives/antigravity.mjs';
import { readPluginUsage, nodeFetchTransport } from './plugin-host.mjs';
import { claudeConsentGiven } from './doctor.mjs';
import { defaultRawStore, recordingTransport } from './raw-store.mjs';
import { claudeUsageFromLead } from '../usage.mjs';

export const USAGE_PROVIDERS = ['codex', 'claude', 'glm', 'gemini', 'muse', 'cline'];
/** Plans provider -> the vendored plugin that reads it. */
export const PLUGIN_FOR = { glm: 'zai', muse: 'muse', cline: 'clinepass' };

const isTestProcess = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
const refused = async () => { throw new Error('network refused in a test process'); };

const DEFAULT_READERS = {
  codex: { read: readCodexNativeUsage, transport: defaultCodexTransport },
  claude: { read: readClaudeNativeUsage, transport: defaultClaudeTransport },
  gemini: { read: readAntigravityNativeUsage, transport: defaultAntigravityTransport },
  plugin: { read: (provider, opts) => readPluginUsage(PLUGIN_FOR[provider], opts), transport: nodeFetchTransport },
};

const finiteOrNull = v => (Number.isFinite(v) ? v : null);
const stringOrNull = v => (typeof v === 'string' ? v : null);

/** The whitelist. Anything a reader adds beside these fields (identity, strategy, credits, attempts) stops here. */
export function toTreeReading(reading) {
  const out = {
    status: typeof reading?.status === 'string' ? reading.status : 'unavailable',
    source: stringOrNull(reading?.source),
    updatedAt: stringOrNull(reading?.updatedAt),
    windows: (Array.isArray(reading?.windows) ? reading.windows : []).map(w => ({
      limitId: w?.limitId, usedPercent: w?.usedPercent,
      windowDurationMins: finiteOrNull(w?.windowDurationMins), resetsAt: stringOrNull(w?.resetsAt),
    })),
  };
  if (typeof reading?.reason === 'string') out.reason = reading.reason;
  // Deviation from the bare whitelist: codex's own "may this account keep working" verdict (a boolean, not
  // identity) — dispatch turns it into `exhausted`, which beats any percentage.
  if (typeof reading?.ordinaryUsageAllowed === 'boolean') out.ordinaryUsageAllowed = reading.ordinaryUsageAllowed;
  return out;
}

/**
 * Read one provider. Never throws. `opts` go to the underlying reader unchanged (env, homeDir, configPath, runner,
 * now, log, …) except: `transport` (the inner transport; default the reader's own, refused in a test process),
 * `rawStore` (a store from raw-store.mjs, or null; default defaultRawStore(), off in a test process),
 * `claudeSnapshot` (the lead's get_usage snapshot, claude's fallback), `readers` (test seam: replace a reader).
 */
export async function readProviderUsage(provider, opts = {}) {
  const { transport, rawStore, claudeSnapshot, readers, secrets, ...rest } = opts;
  if (!USAGE_PROVIDERS.includes(provider)) return { status: 'unavailable', source: null, updatedAt: null, windows: [], reason: `no usage reader for ${provider}` };
  const kind = PLUGIN_FOR[provider] ? 'plugin' : provider;
  const reader = { ...DEFAULT_READERS[kind], ...readers?.[kind] };
  try {
    const store = rawStore === undefined ? defaultRawStore() : rawStore;
    const inner = transport ?? (isTestProcess() ? refused : reader.transport);
    // One live Set per run: the reader adds every secret it learns (tokens, CSRF, resolved settings, cookie values)
    // and the recording transport redacts every value in it at write time.
    const redactionSet = new Set(secrets ?? []);
    const options = { ...rest, redactionSet, transport: recordingTransport(inner, store, { secrets: redactionSet, log: rest.log }) };
    // A test process never falls back to the real ~/.config/ocli: an uninjected config path fails closed.
    if ((kind === 'plugin' || provider === 'claude') && isTestProcess() && !options.configPath) options.configPath = '/nonexistent/ocli-test/usage-readers.json';
    // Q21: Claude Code's keychain item is read only with the user's consent (env or config); default OFF.
    if (provider === 'claude' && options.keychainReadConsent === undefined) {
      options.keychainReadConsent = claudeConsentGiven({ env: options.env ?? process.env, configPath: options.configPath });
    }
    const result = kind === 'plugin' ? await reader.read(provider, options) : await reader.read(options);
    const reading = toTreeReading(result?.reading);
    if (provider === 'claude' && reading.status !== 'ok') {
      const lead = toTreeReading({ source: 'lead', ...claudeUsageFromLead(claudeSnapshot) });
      if (lead.status !== 'ok' && reading.reason) lead.reason = `${reading.reason}; ${lead.reason}`;
      return lead;
    }
    return reading;
  } catch (error) {
    return { status: 'unavailable', source: null, updatedAt: null, windows: [], reason: `${provider}: ${error?.name ?? 'error'}` };
  }
}
