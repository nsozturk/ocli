/**
 * Browser cookie access gate — a port of CodexBar's BrowserCookieAccessGate.swift (the cooldown parts
 * in scope for this reader).
 *   Reference: github.com/steipete/CodexBar @ 6480977 — Sources/CodexBarCore/BrowserCookieAccessGate.swift
 *
 * After a keychain denial for a Chromium browser, a cooldown suppresses that browser AND the whole
 * Chromium family, so the user is not prompted again until it expires (L52 cooldownInterval = 60*60*6 s;
 * L292-308 recordDenied sets the per-browser and the family cooldown; L122-147 shouldAttempt returns
 * false while blocked and clears an expired cooldown, persisting the change).
 *
 * The state is a small JSON under the usage-readers config dir, mode 0600, holding ONLY timestamps —
 * never a cookie value and never a keychain password. (CodexBar keeps this in UserDefaults; we have no
 * such store, so a 0600 JSON beside the config is the faithful equivalent — CookieHeaderCache.swift,
 * which caches the headers themselves, is explicitly out of scope here, B2c.)
 */
import { readFileSync as realRead, writeFileSync as realWrite, mkdirSync as realMkdir } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from '../result-policy.mjs';

// CodexBar L52: cooldownInterval = 60 * 60 * 6 seconds.
export const COOKIE_GATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The gate state file sits beside the usage-readers config (path overridable via OCLI_USAGE_READERS_CONFIG). */
export function defaultGateStatePath(env = process.env) {
  return join(dirname(defaultConfigPath(env)), 'cookie-access-gate.json');
}

/**
 * Which keychain reasons start a cooldown. CodexBar records a denial only on `.accessDenied`; a
 * not-found / unavailable / timeout is a miss, not a refusal, and must NOT suppress the family
 * (otherwise one absent browser silences the rest).
 */
export function isDenialReason(reason) {
  return reason === 'denied' || reason === 'interaction-required';
}

/**
 * @param {object} [deps]
 * @param {string} [deps.statePath]  JSON state file; default beside the usage-readers config.
 * @param {object} [deps.fs]         `{ readFileSync, writeFileSync, mkdirSync }` (injected in tests).
 * @param {number} [deps.now]        default epoch-ms clock (overridable per call).
 * @param {Function} [deps.log]      `({category, message}) -> void`; never receives a value or password.
 */
export function createCookieAccessGate({
  statePath,
  fs = { readFileSync: realRead, writeFileSync: realWrite, mkdirSync: realMkdir },
  now,
  log = () => {},
} = {}) {
  const file = statePath ?? defaultGateStatePath();
  let state = null; // { deniedUntilBySource: {id: epochMs}, chromiumFamilyDeniedUntil: epochMs|null }

  function load() {
    if (state) return state;
    state = { deniedUntilBySource: {}, chromiumFamilyDeniedUntil: null };
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc === 'object') {
        const raw = doc.deniedUntilBySource;
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v === 'number' && Number.isFinite(v)) state.deniedUntilBySource[k] = v;
          }
        }
        if (typeof doc.chromiumFamilyDeniedUntil === 'number' && Number.isFinite(doc.chromiumFamilyDeniedUntil)) {
          state.chromiumFamilyDeniedUntil = doc.chromiumFamilyDeniedUntil;
        }
      }
    } catch { /* absent or unreadable: a fresh (empty) state */ }
    return state;
  }

  function persist() {
    // Only timestamps are ever written — the shape has no slot for a cookie value or a password.
    const doc = {
      deniedUntilBySource: { ...state.deniedUntilBySource },
      chromiumFamilyDeniedUntil: state.chromiumFamilyDeniedUntil,
    };
    try { fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
    try { fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 }); } catch { /* a failed persist never fails a read */ }
  }

  function clock(arg) { return arg ?? now ?? Date.now(); }

  /** CodexBar shouldAttemptWithPolicy (L122-147): blocked while a per-browser or family cooldown is
   *  active; an expired cooldown is cleared and persisted. */
  function shouldAttempt(browserId, nowArg) {
    const s = load();
    const t = clock(nowArg);
    let changed = false;

    const until = s.deniedUntilBySource[browserId];
    if (typeof until === 'number') {
      if (until > t) { log({ category: 'cookie-gate', message: `cookie access blocked for ${browserId}` }); return false; }
      delete s.deniedUntilBySource[browserId];
      changed = true;
    }

    const fam = s.chromiumFamilyDeniedUntil;
    if (typeof fam === 'number') {
      if (fam > t) {
        log({ category: 'cookie-gate', message: `chromium-family cookie access blocked for ${browserId}` });
        if (changed) persist();
        return false;
      }
      s.chromiumFamilyDeniedUntil = null;
      changed = true;
    }

    if (changed) persist();
    return true;
  }

  /** CodexBar recordDenied (L292-308): set the per-browser and the family cooldown. The arguments are a
   *  browser id and a clock — never a cookie value. */
  function recordDenied(browserId, nowArg) {
    const s = load();
    const blockedUntil = clock(nowArg) + COOKIE_GATE_COOLDOWN_MS;
    s.deniedUntilBySource[browserId] = blockedUntil;
    s.chromiumFamilyDeniedUntil = blockedUntil;
    persist();
    log({ category: 'cookie-gate', message: `cookie access denied; suppressing chromium family after ${browserId}` });
  }

  return { shouldAttempt, recordDenied, statePath: file };
}
