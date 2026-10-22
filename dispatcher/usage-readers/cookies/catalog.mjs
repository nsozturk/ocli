/**
 * Chromium browser catalog — a port of SweetCookieKit's BrowserCatalog.swift (chromium rows only) and
 * the Chromium profile discovery in ChromeCookieImporter.swift (L477-523) / BrowserCookieModels.swift
 * (ChromiumProfileLocator, L116-154).
 *   Reference: github.com/steipete/SweetCookieKit @ 3960c33 (MIT, © 2026 Peter Steinberger).
 *
 * Only the macOS Chromium stack is ported (node:sqlite + node:crypto reader). Safari (WebKit) and
 * Firefox/Zen (Gecko) engines are intentionally out of scope for this reader.
 */
import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isRealKeychainBlocked } from '../credentials.mjs';

/**
 * Chromium browsers, in BrowserCatalog's defaultImportOrderRank order. Each entry mirrors the Swift
 * metadata fields this reader needs: the profile root under `~/Library/Application Support` and the
 * keychain "Safe Storage" labels. `electron` marks a single-store Electron app whose cookie DB sits
 * directly in the application-support root (ChromeCookieImporter L498-500).
 */
export const CHROMIUM_BROWSERS = [
  { id: 'chrome', displayName: 'Chrome', profileRelativePath: 'Google/Chrome', safeStorageLabels: [{ service: 'Chrome Safe Storage', account: 'Chrome' }] },
  { id: 'edge', displayName: 'Microsoft Edge', profileRelativePath: 'Microsoft Edge', safeStorageLabels: [{ service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }] },
  { id: 'brave', displayName: 'Brave', profileRelativePath: 'BraveSoftware/Brave-Browser', safeStorageLabels: [{ service: 'Brave Safe Storage', account: 'Brave' }] },
  { id: 'arc', displayName: 'Arc', profileRelativePath: 'Arc/User Data', safeStorageLabels: [{ service: 'Arc Safe Storage', account: 'Arc' }] },
  { id: 'dia', displayName: 'Dia', profileRelativePath: 'Dia/User Data', safeStorageLabels: [{ service: 'Dia Safe Storage', account: 'Dia' }] },
  {
    id: 'chatgptAtlas', displayName: 'ChatGPT Atlas', profileRelativePath: 'com.openai.atlas/browser-data/host',
    safeStorageLabels: [
      { service: 'ChatGPT Atlas Safe Storage', account: 'ChatGPT Atlas' },
      { service: 'ChatGPT Atlas Safe Storage', account: 'com.openai.atlas' },
      { service: 'com.openai.atlas Safe Storage', account: 'com.openai.atlas' },
    ],
  },
  { id: 'chromium', displayName: 'Chromium', profileRelativePath: 'Chromium', safeStorageLabels: [{ service: 'Chromium Safe Storage', account: 'Chromium' }] },
  {
    id: 'helium', displayName: 'Helium', profileRelativePath: 'net.imput.helium',
    safeStorageLabels: [
      { service: 'Helium Storage Key', account: 'Helium' },
      { service: 'Helium Safe Storage', account: 'Helium' },
      { service: 'net.imput.helium Safe Storage', account: 'net.imput.helium' },
    ],
  },
  { id: 'vivaldi', displayName: 'Vivaldi', profileRelativePath: 'Vivaldi', safeStorageLabels: [{ service: 'Vivaldi Safe Storage', account: 'Vivaldi' }] },
  { id: 'yandex', displayName: 'Yandex Browser', profileRelativePath: 'Yandex/YandexBrowser', safeStorageLabels: [{ service: 'Yandex Safe Storage', account: 'Yandex' }] },
  { id: 'chromeBeta', displayName: 'Chrome Beta', profileRelativePath: 'Google/Chrome Beta', safeStorageLabels: [] },
  { id: 'chromeCanary', displayName: 'Chrome Canary', profileRelativePath: 'Google/Chrome Canary', safeStorageLabels: [] },
  { id: 'arcBeta', displayName: 'Arc Beta', profileRelativePath: 'Arc Beta/User Data', safeStorageLabels: [{ service: 'Arc Safe Storage', account: 'Arc Beta' }] },
  { id: 'arcCanary', displayName: 'Arc Canary', profileRelativePath: 'Arc Canary/User Data', safeStorageLabels: [{ service: 'Arc Safe Storage', account: 'Arc Canary' }] },
  { id: 'braveBeta', displayName: 'Brave Beta', profileRelativePath: 'BraveSoftware/Brave-Browser-Beta', safeStorageLabels: [] },
  { id: 'braveNightly', displayName: 'Brave Nightly', profileRelativePath: 'BraveSoftware/Brave-Browser-Nightly', safeStorageLabels: [] },
  { id: 'edgeBeta', displayName: 'Microsoft Edge Beta', profileRelativePath: 'Microsoft Edge Beta', safeStorageLabels: [] },
  { id: 'edgeCanary', displayName: 'Microsoft Edge Canary', profileRelativePath: 'Microsoft Edge Canary', safeStorageLabels: [] },
  { id: 'comet', displayName: 'Comet', profileRelativePath: 'Comet', safeStorageLabels: [{ service: 'Comet Safe Storage', account: 'Comet' }] },
  { id: 'aside', displayName: 'Aside', profileRelativePath: 'Aside', safeStorageLabels: [{ service: 'Aside Safe Storage', account: 'Aside' }] },
  { id: 'opera', displayName: 'Opera', profileRelativePath: 'com.operasoftware.Opera', safeStorageLabels: [{ service: 'Opera Safe Storage', account: 'Opera' }] },
  { id: 'operaNeon', displayName: 'Opera Neon', profileRelativePath: 'com.operasoftware.OperaNeon', safeStorageLabels: [{ service: 'Opera Safe Storage', account: 'Opera' }] },
  { id: 'egoLite', displayName: 'Ego Lite', profileRelativePath: 'Citro Labs/ego lite', safeStorageLabels: [{ service: 'ego safe storage', account: 'ego' }] },
  { id: 'claudeDesktop', displayName: 'Claude desktop app', profileRelativePath: 'Claude', electron: true, safeStorageLabels: [{ service: 'Claude Safe Storage', account: 'Claude Key' }] },
];

const CHROMIUM_BY_ID = new Map(CHROMIUM_BROWSERS.map(b => [b.id, b]));

/**
 * The ordered aggregate of Safe Storage labels (BrowserCatalog.safeStorageLabels, L347-368) — the
 * fallback label set used by ChromeCookieImporter.safeStorageLabels(for:) when a browser's own list
 * is empty (L406-412).
 */
export const AGGREGATE_SAFE_STORAGE_LABELS = [
  'chrome', 'chromium', 'brave', 'arc', 'arcBeta', 'arcCanary', 'chatgptAtlas', 'helium', 'edge',
  'vivaldi', 'yandex', 'dia', 'comet', 'aside', 'opera', 'operaNeon', 'egoLite',
].flatMap(id => (CHROMIUM_BY_ID.get(id)?.safeStorageLabels ?? []));

export function getChromiumBrowser(id) {
  return CHROMIUM_BY_ID.get(id);
}

/**
 * Safe Storage labels to try for a browser: its own list, or the aggregate fallback when empty
 * (ChromeCookieImporter.safeStorageLabels(for:), L406-412).
 */
export function safeStorageLabelsFor(id) {
  const meta = CHROMIUM_BY_ID.get(id);
  if (meta && meta.safeStorageLabels.length > 0) return meta.safeStorageLabels;
  return AGGREGATE_SAFE_STORAGE_LABELS;
}

/** Default home directories (ChromeCookieImporter uses the current user's home). */
export function defaultHomeDirectories(env = process.env) {
  const homes = [];
  const h = homedir();
  if (h) homes.push(h);
  const envHome = env.HOME;
  if (envHome && !homes.includes(envHome)) homes.push(envHome);
  return [...new Set(homes)];
}

/**
 * KeychainTestSafety for the filesystem: in a test process (or with OCLI_DISABLE_KEYCHAIN=1) any path
 * under the real home — `os.homedir()` or the passwd home, so an overridden HOME cannot hide it — is
 * refused. Injected temp roots (outside the home) are unaffected.
 */
export function isRealProfilePathBlocked(path, env = process.env) {
  if (!isRealKeychainBlocked(env)) return false;
  const p = resolve(String(path ?? ''));
  let passwdHome;
  try { passwdHome = userInfo().homedir; } catch { passwdHome = undefined; }
  return [homedir(), passwdHome].filter(Boolean).some(h => {
    const home = resolve(h);
    return p === home || p.startsWith(home + sep);
  });
}

/**
 * Chromium profile roots for the given browsers (ChromiumProfileLocator.roots, L116-139):
 * `<home>/Library/Application Support/<profileRelativePath>`.
 */
export function chromiumRoots({ browserIds, homeDirectories } = {}) {
  const ids = browserIds ?? CHROMIUM_BROWSERS.map(b => b.id);
  const homes = [...new Set(homeDirectories ?? defaultHomeDirectories())];
  const roots = [];
  for (const home of homes) {
    const appSupport = join(home, 'Library', 'Application Support');
    for (const id of ids) {
      const meta = CHROMIUM_BY_ID.get(id);
      if (!meta || !meta.profileRelativePath) continue;
      roots.push({ browserId: id, url: join(appSupport, meta.profileRelativePath) });
    }
  }
  return roots;
}

/**
 * Discover the cookie stores under a profile root (ChromeCookieImporter.chromeProfileCookieDBs,
 * L477-523). Profile dirs named `Default`, `Profile *`, or `user-*`, sorted by name. Each yields a
 * Network store and a primary store. Electron apps keep one store at the root itself (L498-500).
 * `fs` is injected: `{ readdirSync(path) -> [{ name, isDirectory() }] }` and `existsSync(path)`.
 */
export function discoverProfileStores({ root, browserId, fs }) {
  const meta = CHROMIUM_BY_ID.get(browserId);
  if (!meta) return [];
  if (isRealProfilePathBlocked(root)) return []; // fail closed before any readdir/exists
  const labelPrefix = meta.displayName;

  let profileDirs;
  if (meta.electron) {
    profileDirs = [root];
  } else {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    profileDirs = entries
      .filter(e => {
        let isDir = false;
        try { isDir = typeof e.isDirectory === 'function' ? e.isDirectory() : false; } catch { isDir = false; }
        if (!isDir) return false;
        const name = e.name;
        return name === 'Default' || name.startsWith('Profile ') || name.startsWith('user-');
      })
      .map(e => join(root, e.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const candidates = [];
  for (const dir of profileDirs) {
    const profileName = dir === root && meta.electron ? meta.displayName : basename(dir);
    const profile = { id: dir, name: profileName };
    const labelBase = `${labelPrefix} ${profileName}`;
    candidates.push({
      browserId, profile, kind: 'network', label: `${labelBase} (Network)`,
      databaseURL: join(dir, 'Network', 'Cookies'),
    });
    candidates.push({
      browserId, profile, kind: 'primary', label: labelBase,
      databaseURL: join(dir, 'Cookies'),
    });
  }
  return candidates.filter(c => {
    try { return fs.existsSync(c.databaseURL); } catch { return false; }
  });
}

function basename(p) {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}
