/**
 * Cookie broker — a port of CodexBar's ProviderPluginCookieBroker.swift (the parts that serve a
 * plugin's `ctx.browser.cookieHeader(domain)` from the importers), narrowed to this reader.
 *   Reference: github.com/steipete/CodexBar @ 6480977
 *     — Plugins/ProviderPluginCookieBroker.swift (import order, per-browser attempts, access gate)
 *     — BrowserCookieImportOrder.swift (the candidate order + access gate filtering)
 *     — BrowserCookieProfiles.swift (merge the Network + primary stores within a profile)
 *     — Plugins/ProviderPluginCookiePolicy.swift (declared-domains authority)
 *
 * The plugin host already refuses an undeclared domain before it reaches here (declaredCookieDomain);
 * the broker enforces the same policy as a second wall, and additionally refuses an empty / missing
 * domain list — the B2a finding that `sqlCondition([])` yields `1=1` and would read every cookie.
 *
 * A cookie value is a secret: it is never logged and never put in an error or a reason.
 */
import { cookieHeader as buildCookieHeader, normalizeDomain, CookieReadError } from './chromium.mjs';
import { CHROMIUM_BROWSERS } from './catalog.mjs';
import { isDenialReason } from './gate.mjs';

/** The attempt order, BrowserCatalog.defaultImportOrderRank (catalog.mjs is already in that order). */
export function defaultImportOrder() {
  return CHROMIUM_BROWSERS.map(b => b.id);
}

/** Declared domains, normalised (leading dot stripped, lower-cased, de-duplicated). */
export function normalizeDeclaredDomains(domains) {
  if (!Array.isArray(domains)) return [];
  return [...new Set(domains.map(d => normalizeDomain(d).toLowerCase()).filter(Boolean))];
}

// BrowserCookieProfiles.storePriority (L46-52): the Network store is preferred over the primary store.
function storePriority(kind) {
  if (kind === 'network') return 0;
  if (kind === 'primary') return 1;
  return 2;
}

// BrowserCookieProfiles.shouldReplace (L58-65): on a key collision keep the later-expiring record; a
// record with an expiry beats a session (null) one.
function shouldReplace(existing, candidate) {
  const le = existing.expires, re = candidate.expires;
  if (le != null && re != null) return re > le;
  if (le == null && re != null) return true;
  return false;
}

/**
 * @param {object} deps
 * @param {object} deps.reader       the Chromium reader: `{ availableStores(browserId), read({...}) }`.
 * @param {object} deps.gate         the access gate: `{ shouldAttempt(browserId, now), recordDenied(browserId, now) }`.
 * @param {string[]} deps.domains    the plugin's declared cookie domains (manifest.cookieDomains).
 * @param {string[]} [deps.importOrder]  browser ids to try, in order (default the catalog order).
 * @param {number} [deps.now]        epoch-ms clock (passed through to the gate and the reader).
 * @param {Function} [deps.log]      `({category, message}) -> void`; never receives a value.
 */
export function createCookieBroker({ reader, gate, domains, importOrder = defaultImportOrder(), now, log = () => {} } = {}) {
  const declared = normalizeDeclaredDomains(domains);
  const note = message => log({ category: 'cookie-broker', message });

  function mergeStores(storeRecords) {
    // BrowserCookieProfiles.merge: fold every store's records into one map, Network store first so it
    // wins ties, later-expiring replaces on a key collision.
    const byKey = new Map();
    for (const records of storeRecords) {
      for (const r of records) {
        const key = `${r.name}|${r.domain}|${r.path}`;
        const existing = byKey.get(key);
        if (!existing || shouldReplace(existing, r)) byKey.set(key, r);
      }
    }
    return [...byKey.values()];
  }

  function cookieHeader(rawDomain) {
    // B2a finding: an empty/missing domain list must open nothing, not read the whole profile.
    if (declared.length === 0) throw new CookieReadError('no-domains');
    const domain = normalizeDomain(rawDomain).toLowerCase();
    // Declared-domains authority (ProviderPluginCookiePolicy): only a declared domain is ever served.
    if (!declared.includes(domain)) throw new CookieReadError('undeclared');

    const nowMs = now ?? Date.now();
    for (const browserId of importOrder) {
      // The access gate decides before any store is opened — a cooldown skips the browser (and thus
      // never prompts the keychain again).
      if (!gate.shouldAttempt(browserId, nowMs)) continue;

      let stores;
      try { stores = reader.availableStores(browserId); } catch { continue; }
      if (!stores || stores.length === 0) continue;

      const ordered = [...stores].sort((a, b) => storePriority(a.kind) - storePriority(b.kind));
      const collected = [];
      let denied = false;
      for (const store of ordered) {
        try {
          const { records } = reader.read({ store, browserId, domains: declared, now: nowMs });
          collected.push(records);
        } catch (error) {
          if (error instanceof CookieReadError && isDenialReason(error.reason)) {
            // A keychain refusal: start the cooldown and stop touching this browser.
            gate.recordDenied(browserId, nowMs);
            note(`cookie access denied for ${browserId}`);
            denied = true;
            break;
          }
          // not-found / load-failed / unavailable for this store: try the next store.
        }
      }
      if (denied) continue;

      const header = buildCookieHeader(mergeStores(collected), domain);
      if (header) return header;
    }
    throw new CookieReadError('not-found');
  }

  return { cookieHeader, cookieSource: domain => cookieHeader(domain), declaredDomains: declared };
}
