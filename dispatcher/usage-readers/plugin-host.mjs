/**
 * A1 — Node host for CodexBar's JavaScript provider plugins.
 *
 * Ported from CodexBar @ 6480977 (MIT, © 2026 Peter Steinberger; LICENSE-CodexBar beside the plugins):
 *   Sources/CodexBarCore/Plugins/ProviderPluginRuntime.swift (host object, watchdog, redaction),
 *   ProviderPluginManifest.swift (manifest + origin policy), ProviderPluginHTTPResponse.swift (request policy),
 *   ProviderHTTPClient.swift (same-origin HTTPS redirect guard), ProviderPluginSnapshotMapper.swift +
 *   ProviderPluginResult.swift (snapshot / envelope validation), ProviderPluginDate.swift,
 *   ProviderDetailSection.swift (detail bounds). Contract: docs/plugin-prototype.md.
 * A2 adds the https-or-private-network-http policy (ProviderEndpointOverrideValidator.swift), retryPolicy
 *   (ProviderHTTPRetryPolicy in ProviderHTTPClient.swift) and getWithOptional (ProviderPluginHTTPResponse.fetch).
 * A3 adds the result policy (result-policy.mjs: persist grants + config writer, OpenAI card), costUsage
 *   (ProviderPluginSnapshotMapper.costUsage), persistent storage (plugin-storage.mjs) and OpenRouter management auth
 *   (ProviderPluginHTTPResponse.request + ProviderPluginManifest.openRouterManagementAuthSecret).
 * The `ctx` surface itself is CodexBar's own prelude (plugins/provider-plugin-prelude.js, vendored unchanged);
 * this file supplies the `host` object the prelude calls, so a plugin sees exactly the API it was written for.
 *
 * Isolation: each plugin runs in a fresh node:vm context (null-prototype global, no string code generation)
 * holding only ECMAScript built-ins and `defineProvider`. Every value handed into the context is built from that
 * context's own intrinsics, so no outer-realm object (and so no `process`) is reachable from plugin code.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPersist, defaultConfigPath, loadConfigDocument, persistSettings, resultPolicyFor, resultString as policyString } from './result-policy.mjs';
import { createPluginStorage } from './plugin-storage.mjs';
import { createCredentialStore, USAGE_READERS_KEYCHAIN_SERVICE, isRealKeychainBlocked } from './credentials.mjs';
import { createChromiumCookieReader } from './cookies/chromium.mjs';
import { createCookieAccessGate } from './cookies/gate.mjs';
import { createCookieBroker } from './cookies/broker.mjs';

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'plugins');
export const WATCHDOG_MS = 20_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const PRELUDE = readFileSync(join(PLUGIN_DIR, 'provider-plugin-prelude.js'), 'utf8');

const PREFIX = {
  load: 'Provider plugin load failed', 'invalid-manifest': 'Invalid provider plugin manifest',
  'network-policy': 'Provider plugin network policy rejected the request', http: 'Provider plugin HTTP error',
  'secret-access': 'Provider plugin secret access denied', 'invalid-snapshot': 'Invalid provider plugin snapshot',
  script: 'Provider plugin script failed',
};
const HOST_KINDS = new Set([...Object.keys(PREFIX), 'timeout', 'network']);
const CLASSIFIED = new Set(['authentication-expired', 'missing-credential', 'permission-denied', 'rate-limited',
  'provider-unavailable', 'parse-failure', 'network-failure', 'api-failure']);

/** A typed host failure; `kind` becomes the reading's `plugin:<kind>` reason. */
export class PluginError extends Error {
  constructor(kind, detail = '', extra = {}) {
    super(kind === 'timeout' ? 'Provider plugin timed out' : PREFIX[kind] ? `${PREFIX[kind]}: ${detail}` : String(detail));
    this.kind = kind;
    Object.assign(this, extra);
  }
}
const fail = (kind, detail) => { throw new PluginError(kind, detail); };
const rawError = (kind, message, extra) => Object.assign(new PluginError(kind, ''), { message, ...extra });

// Foundation's whitespacesAndNewlines also covers NEL and ZERO WIDTH SPACE (CodexBar's zai bounds test relies on it).
const trim = s => String(s).replace(/^[\s\u0085​]+|[\s\u0085​]+$/g, '');
const SEGMENTER = new Intl.Segmenter();
const graphemes = s => [...SEGMENTER.segment(s)].length;
const utf8Length = s => Buffer.byteLength(s, 'utf8');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

// ---------------------------------------------------------------- manifest

function requiredString(obj, prop) {
  const v = obj?.[prop];
  if (typeof v !== 'string') fail('invalid-manifest', `'${prop}' must be a string`);
  const s = trim(v);
  if (!s) fail('invalid-manifest', `'${prop}' must not be empty`);
  return s;
}
function boundedString(obj, prop, max) {
  const s = requiredString(obj, prop);
  if (utf8Length(s) > max) fail('invalid-manifest', `'${prop}' exceeds ${max} UTF-8 bytes`);
  return s;
}
const isHeaderName = v => v.length > 0 && /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(v);

function fixedOrigin(raw) {
  let u;
  try { u = new URL(raw); } catch { u = null; }
  if (!u || u.protocol !== 'https:' || !u.hostname || u.username || u.password || raw.includes('?') || raw.includes('#')
    || !(u.pathname === '' || u.pathname === '/') || /%/.test(u.host)) {
    fail('invalid-manifest', `endpoint '${raw}' must be an HTTPS origin`);
  }
  return `https://${u.host}`;
}

function cookieDomainName(raw) {
  const v = trim(raw).toLowerCase();
  const ok = v && utf8Length(v) <= 253 && !v.startsWith('.') && !v.endsWith('.') && !/[/:]/.test(v)
    && v.split('.').every(l => l && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[0-9a-z-]+$/.test(l));
  if (!ok) fail('invalid-manifest', `cookie domain '${raw}' is invalid`);
  return v;
}

const PRIVATE_NETWORK_POLICY = 'https-or-private-network-http';
const ENDPOINT_POLICIES = new Set(['https', 'https-or-loopback-http', PRIVATE_NETWORK_POLICY]);
// ProviderPluginManifest.swift:445-448 `bundledPrivateNetworkHTTPProviders` — the only providers that may declare
// https-or-private-network-http (CodexBar also allows it for dynamic-id user plugins; this port has none).
const PRIVATE_NETWORK_HTTP_PROVIDERS = new Set(['llmproxy', 'litellm', 'bifrost', 'aixy', 'llmman']);

/** Validates the defineProvider(...) object exactly as ProviderPluginManifest.init does (A1: any well-formed id). */
export function parseManifest(def) {
  if (!def || typeof def !== 'object') fail('invalid-manifest', 'defineProvider(...) requires an object');
  const id = requiredString(def, 'id');
  if (!/^[a-z0-9-]{1,64}$/.test(id)) fail('invalid-manifest', 'provider id must contain 1-64 lowercase ASCII letters, digits, or hyphens');
  const name = boundedString(def, 'name', 80);
  if (!Array.isArray(def.endpoints) || def.endpoints.length < 1 || def.endpoints.length > 16) {
    fail('invalid-manifest', "'endpoints' must be a non-empty array of HTTPS origins");
  }
  const endpoints = def.endpoints.map((e, i) => {
    if (typeof e === 'string') return { fixed: fixedOrigin(e) };
    if (!isObject(e)) fail('invalid-manifest', `endpoint at index ${i} must be an HTTPS origin or setting endpoint`);
    const policy = requiredString(e, 'policy');
    if (!ENDPOINT_POLICIES.has(policy)) fail('invalid-manifest', `unsupported endpoint policy '${policy}'`);
    if (policy === PRIVATE_NETWORK_POLICY && !PRIVATE_NETWORK_HTTP_PROVIDERS.has(id)) {
      fail('invalid-manifest', `private-network HTTP is not allowed for bundled provider '${id}'`);
    }
    return { setting: requiredString(e, 'setting'), policy };
  });
  if (!Array.isArray(def.settings)) fail('invalid-manifest', "'settings' must be an array");
  if (def.settings.length > 32) fail('invalid-manifest', "'settings' exceeds 32 entries");
  const settings = [];
  for (const [i, s] of def.settings.entries()) {
    if (!isObject(s)) fail('invalid-manifest', `setting at index ${i} must be an object`);
    const key = requiredString(s, 'key');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) fail('invalid-manifest', `setting key '${key}' must contain 1-64 ASCII letters, digits, or underscores and start with a letter`);
    if (settings.some(x => x.key === key)) fail('invalid-manifest', `duplicate setting key '${key}'`);
    boundedString(s, 'title', 80);
    const kind = s.type === undefined || s.type === null ? 'secure' : s.type;
    if (kind !== 'secure' && kind !== 'plain') fail('invalid-manifest', `unsupported setting type '${kind}'`);
    settings.push({ key, kind });
  }
  for (const e of endpoints) {
    if (e.setting && settings.find(s => s.key === e.setting)?.kind !== 'plain') {
      fail('invalid-manifest', `endpoint setting '${e.setting}' must be declared as a plain setting`);
    }
  }
  let auth = null;
  if (def.auth !== undefined && def.auth !== null) {
    if (!isObject(def.auth)) fail('invalid-manifest', "'auth' must be an object when present");
    const type = requiredString(def.auth, 'type');
    if (!['bearer', 'x-api-key', 'header', 'authorization-scheme'].includes(type)) fail('invalid-manifest', `unsupported auth type '${type}'`);
    const secret = requiredString(def.auth, 'secret');
    const header = type === 'header' ? requiredString(def.auth, 'header') : type === 'x-api-key' ? 'X-API-Key' : 'Authorization';
    const scheme = type === 'authorization-scheme' ? requiredString(def.auth, 'scheme') : null;
    if (!isHeaderName(header)) fail('invalid-manifest', `auth header '${header}' is invalid`);
    if (scheme !== null && !(scheme.length <= 32 && isHeaderName(scheme))) fail('invalid-manifest', `authorization scheme '${scheme}' is invalid`);
    if (settings.find(s => s.key === secret)?.kind !== 'secure') fail('invalid-manifest', `auth secret '${secret}' must be declared as a secure setting`);
    auth = { type, header, secret, scheme };
  }
  const capabilities = new Set();
  if (def.capabilities !== undefined && def.capabilities !== null) {
    if (!Array.isArray(def.capabilities)) fail('invalid-manifest', "'capabilities' must be an array when present");
    def.capabilities.forEach((c, i) => {
      if (!['browser-cookies', 'http-status', 'persistent-storage'].includes(c)) fail('invalid-manifest', `unsupported capability at index ${i}`);
      capabilities.add(c);
    });
  }
  const cookieDomains = new Set();
  if (def.cookieDomains !== undefined && def.cookieDomains !== null) {
    if (!capabilities.has('browser-cookies') || !Array.isArray(def.cookieDomains)) {
      fail('invalid-manifest', "'cookieDomains' requires the browser-cookies capability and must be an array");
    }
    def.cookieDomains.forEach((d, i) => {
      if (typeof d !== 'string') fail('invalid-manifest', `cookie domain at index ${i} must be a string`);
      cookieDomains.add(cookieDomainName(d));
    });
  }
  if (capabilities.has('browser-cookies') && cookieDomains.size === 0) {
    fail('invalid-manifest', 'the browser-cookies capability requires at least one declared cookie domain');
  }
  let percentPolicy = 'clamp';
  if (def.snapshotPolicy !== undefined) {
    const p = def.snapshotPolicy;
    if (!isObject(p) || Object.keys(p).join() !== 'percent' || !['clamp', 'preserve-overage'].includes(p.percent)) {
      fail('invalid-manifest', 'snapshotPolicy requires a valid percent policy');
    }
    percentPolicy = p.percent;
  }
  return { id, name, endpoints, auth, settings, capabilities: [...capabilities], cookieDomains: [...cookieDomains], percentPolicy };
}

function declaredCookieDomain(manifest, raw) {
  const domain = trim(raw).toLowerCase();
  if (!manifest.capabilities.includes('browser-cookies') || !manifest.cookieDomains.includes(domain)) {
    fail('secret-access', 'cookie domain is not declared');
  }
  return domain;
}

// ---------------------------------------------------------------- request policy

const isLoopback = h => h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

// ProviderEndpointOverrideValidator.swift:140-226, applied to the WHATWG-normalized hostname (brackets stripped).
const isUInt8 = s => /^\+?\d+$/.test(s) && Number(s) <= 255;
function codexbarLoopback(host) {
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets.every(isUInt8) && Number(octets[0]) === 127;
}
function ipv4Octets(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  if (!parts.every(p => /^\d+$/.test(p) && (p === '0' || p[0] !== '0') && Number(p) <= 255)) return null;
  return parts.map(Number);
}
function ipv6GroupCount(part) {
  if (part === '') return 0;
  const groups = part.split(':');
  return groups.every(g => /^[0-9A-Fa-f]{1,4}$/.test(g)) ? groups.length : null;
}
function isValidIPv6Address(host) {
  if (!host.includes(':')) return false;
  let address = host;
  if (address.includes('.')) {
    const last = address.lastIndexOf(':');
    if (last < 0 || !ipv4Octets(address.slice(last + 1))) return false;
    address = `${address.slice(0, last + 1)}0:0`;
  }
  const compressed = address.split('::');
  if (compressed.length > 2) return false;
  const counts = compressed.map(ipv6GroupCount);
  if (counts.some(c => c === null)) return false;
  const total = counts.reduce((a, b) => a + b, 0);
  return compressed.length === 2 ? total < 8 : total === 8;
}
/** ProviderEndpointOverrideValidator.isPrivateNetworkHost: loopback, *.local, 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10. */
export function isPrivateNetworkHost(host) {
  if (codexbarLoopback(host)) return true;
  const hostname = host.endsWith('.') ? host.slice(0, -1) : host;
  if (hostname.endsWith('.local') && hostname.length > '.local'.length) return true;
  const o = ipv4Octets(host);
  if (o) return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254);
  if (!isValidIPv6Address(host)) return false;
  const first = host.split(':')[0];
  if (!first) return false;
  const value = parseInt(first, 16);
  return (value & 0xFE00) === 0xFC00 || (value & 0xFFC0) === 0xFE80;
}
const bareHost = h => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);
const httpAllowed = (policy, hostname) => (policy === 'https-or-loopback-http' ? isLoopback(hostname)
  : policy === PRIVATE_NETWORK_POLICY ? isPrivateNetworkHost(bareHost(hostname)) : false);

/** ProviderPluginOrigin.normalizedOrigin(of:policy:) over WHATWG URL parsing. */
function originOf(u, raw, policy) {
  const scheme = u.protocol.slice(0, -1);
  const ok = (scheme === 'https' || (scheme === 'http' && httpAllowed(policy, u.hostname)))
    && u.hostname && !u.username && !u.password && !u.hash && !String(raw).includes('#') && !/%/.test(u.host);
  if (!ok) fail('network-policy', 'URL does not satisfy the declared endpoint policy');
  return `${scheme}://${u.host}`;
}

function allowedOrigin(manifest, u, raw, settings) {
  for (const e of manifest.endpoints) {
    if (e.fixed) {
      try { if (originOf(u, raw, 'https') === e.fixed) return true; } catch { /* not this endpoint */ }
      continue;
    }
    const configured = settings[e.setting];
    if (!configured) continue;
    let cu;
    try { cu = new URL(configured); } catch { continue; }
    if (cu.hash || configured.includes('#')) continue;
    if (originOf(u, raw, e.policy) === originOf(cu, configured, e.policy)) return true;
  }
  return false;
}

function timeoutSeconds(options) {
  const v = options.timeoutSeconds;
  if (v === undefined) return 15;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 90) fail('http', 'timeoutSeconds must be a number from 1 through 90');
  return v;
}

/**
 * ProviderPluginManifest.openRouterManagementAuthSecret (ProviderPluginManifest.swift:103-120): only provider
 * `openrouter`, with OPENROUTER_MANAGEMENT_API_KEY declared secure, GET https://openrouter.ai/api/v1/activity — no port,
 * user, password or fragment (a query is allowed). Checked on the raw URL too, because WHATWG parsing drops `:443` and
 * resolves dot segments that Foundation's URL keeps (and so rejects).
 */
export function openRouterManagementAuthSecret(manifest, method, rawURL) {
  const secret = 'OPENROUTER_MANAGEMENT_API_KEY';
  const raw = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(rawURL));
  let u = null;
  try { u = new URL(rawURL); } catch { /* refused below */ }
  const ok = manifest.id === 'openrouter' && manifest.settings.find(s => s.key === secret)?.kind === 'secure' && method === 'GET'
    && raw && raw[1].toLowerCase() === 'https' && raw[2].toLowerCase() === 'openrouter.ai' && raw[3] === '/api/v1/activity'
    && raw[5] === undefined && u && u.protocol === 'https:' && u.hostname === 'openrouter.ai' && u.port === ''
    && !u.username && !u.password && u.pathname === '/api/v1/activity';
  if (!ok) fail('secret-access', 'OpenRouter management auth is unavailable for this plugin');
  return secret;
}

/** ProviderPluginHTTPResponse.request(...): origin, method, deadline, body, headers, manifest-owned auth. */
export function buildRequest(manifest, rawURL, options, method, settings, secrets) {
  let u;
  try { u = new URL(rawURL); } catch { fail('network-policy', 'request URL is invalid'); }
  if (!allowedOrigin(manifest, u, rawURL, settings)) {
    let rejected = 'invalid';
    try { rejected = originOf(u, rawURL, u.protocol === 'http:' ? 'https-or-loopback-http' : 'https'); } catch { /* invalid */ }
    fail('network-policy', `origin '${rejected}' is not declared`);
  }
  if (method !== 'GET' && method !== 'POST') fail('network-policy', 'HTTP method is not allowed');
  const timeout = timeoutSeconds(options);
  let body;
  if (method === 'POST') {
    if (options.form !== undefined) {
      if (!isObject(options.form) || options.bodyJSON !== undefined || Object.values(options.form).some(v => typeof v !== 'string')) {
        fail('http', 'POST form requires a string-to-string map and no JSON body');
      }
      body = new URLSearchParams(options.form).toString();
    } else {
      if (typeof options.bodyJSON !== 'string') fail('http', 'POST JSON body is missing');
      body = options.bodyJSON;
    }
  }
  const headers = new Map();
  const set = (name, value) => headers.set(name.toLowerCase(), [name, value]);
  if (isObject(options.headers)) {
    for (const [name, value] of Object.entries(options.headers)) {
      if (typeof value !== 'string') fail('http', `request header '${name}' must be a string`);
      if (manifest.auth && name.toLowerCase() === manifest.auth.header.toLowerCase()) {
        fail('network-policy', 'plugins may not override the auth header');
      }
      set(name, value);
    }
  }
  if (!headers.has('accept')) set('Accept', 'application/json');
  if (method === 'POST') set('Content-Type', options.form === undefined ? 'application/json' : 'application/x-www-form-urlencoded');
  if (manifest.auth) {
    let secretName = manifest.auth.secret;
    // Provider-specific by design (CodexBar): first-party OpenRouter Activity uses a separately scoped management key,
    // pinned to the official read-only endpoint.
    if (options.openRouterManagementAuth !== undefined) {
      if (options.openRouterManagementAuth !== true) fail('secret-access', 'OpenRouter management auth is unavailable for this plugin');
      secretName = openRouterManagementAuthSecret(manifest, method, rawURL);
    }
    const credential = secrets[secretName];
    if (!credential) fail('secret-access', 'required auth secret is unavailable');
    const { type, scheme, header } = manifest.auth;
    set(header, type === 'bearer' ? `Bearer ${credential}` : type === 'authorization-scheme' ? `${scheme} ${credential}` : credential);
  }
  return { url: u.href, method, headers: Object.fromEntries(headers.values()), body, timeoutSeconds: timeout };
}

// ProviderHTTPClient.swift:38-106 `ProviderHTTPRetryPolicy.transientIdempotent` (maxRetries 1, base 1 s, cap 10 s).
export const RETRY_POLICY = Object.freeze({
  maxRetries: 1, statuses: new Set([408, 429, 500, 502, 503, 504]), methods: new Set(['GET', 'HEAD', 'OPTIONS']),
  // URLError .timedOut / .networkConnectionLost / .cannotConnectToHost / .cannotFindHost / .dnsLookupFailed,
  // as the transport classes ProviderPluginHTTPResponse.failure assigns them.
  transportClasses: new Set(['timeout', 'connection', 'dns']), baseDelaySeconds: 1, maxDelaySeconds: 10,
});
// Swift's Double(String): decimal or inf/infinity/nan, optionally signed (hex floats are not accepted here).
const swiftDouble = s => (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s)
  : /^[+-]?(inf|infinity)$/i.test(s) ? (s.startsWith('-') ? -Infinity : Infinity) : /^[+-]?nan$/i.test(s) ? NaN : null);
/** ProviderHTTPRetryPolicy.delaySeconds(attempt:response:): Retry-After seconds (≥ 0, capped) or exponential base. */
export function retryDelaySeconds(attempt, retryAfter, policy = RETRY_POLICY) {
  const seconds = typeof retryAfter === 'string' ? swiftDouble(trim(retryAfter)) : null;
  if (seconds !== null && seconds >= 0) return Math.min(seconds, policy.maxDelaySeconds);
  if (!(policy.baseDelaySeconds > 0)) return 0;
  return Math.min(policy.baseDelaySeconds * 2 ** Math.max(0, attempt), policy.maxDelaySeconds);
}

/** URLError code → transport class, the way ProviderPluginHTTPResponse.failure names them, from node's error codes. */
function transportClassOf(error) {
  const code = error?.cause?.code ?? error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'].includes(code)) return 'dns';
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) return 'connection';
  if (['ENETUNREACH', 'ENETDOWN'].includes(code)) return 'offline';
  if (typeof code === 'string' && /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)) return 'tls';
  if (error?.name === 'AbortError') return 'cancelled';
  return 'other';
}

/**
 * ProviderPluginHTTPResponse.Request: optionalBudgetSeconds, retryPolicy, the primary request, then the optional
 * request (getWithOptional) — GET primary only, its own policy-checked request, timeout capped at 5 s, never retried.
 */
export function buildHTTPCall(manifest, rawURL, options, method, settings, secrets) {
  let optionalBudgetMs = 200; // ProviderPluginContextOptions.optionalCollectionBudget
  if (options.optionalBudgetSeconds !== undefined) {
    const v = options.optionalBudgetSeconds;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 5) fail('http', 'optionalBudgetSeconds must be a number from 0 through 5');
    optionalBudgetMs = v * 1000;
  }
  let retry = false;
  if (options.retryPolicy !== undefined) {
    if (options.retryPolicy !== 'transientIdempotent') fail('http', "retryPolicy must be 'transientIdempotent'");
    retry = true;
  }
  const primary = buildRequest(manifest, rawURL, options, method, settings, secrets);
  let optional = null;
  if (options.optionalRequest !== undefined) {
    const v = options.optionalRequest;
    if (method !== 'GET' || !isObject(v) || typeof v.url !== 'string' || (v.method !== 'GET' && v.method !== 'POST') || !isObject(v.options)) {
      fail('http', 'optional request requires a GET primary and GET or POST options');
    }
    optional = buildRequest(manifest, v.url, v.options, v.method, settings, secrets);
    optional.timeoutSeconds = Math.min(optional.timeoutSeconds, 5);
  }
  return { primary, optional, retry, optionalBudgetMs };
}

/** ProviderHTTPRedirectGuardDelegate: follow a redirect only from HTTPS to the same HTTPS origin. */
export function redirectAllowed(fromURL, toURL) {
  const a = new URL(fromURL);
  return a.protocol === 'https:' && toURL.protocol === 'https:' && a.host === toURL.host;
}

/** Default transport: node's fetch, manual redirects (the host applies the guard), body capped while streaming. */
export async function nodeFetchTransport({ url, method, headers, body, signal, maxBytes }) {
  const res = await fetch(url, { method, headers, body, signal, redirect: 'manual' });
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    chunks.push(chunk);
    if (size > maxBytes) { await res.body.cancel?.().catch(() => {}); break; }
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.concat(chunks) };
}

// ---------------------------------------------------------------- dates (ProviderPluginDate)

function zoneParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
  const get = t => Number(parts.find(p => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}
function zonedToUtc(p, timeZone) {
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  const offsetAt = t => { const q = zoneParts(t, timeZone); return Date.UTC(q.y, q.m - 1, q.d, q.h, q.mi, q.s) - Math.floor(t / 1000) * 1000; };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}
function validZone(timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}
export function nextDailyReset(nowMs, timeZone, hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !validZone(timeZone)) fail('script', 'invalid daily reset time zone or hour');
  const today = zoneParts(nowMs, timeZone);
  let candidate = zonedToUtc({ ...today, h: 0, mi: 0, s: 0 }, timeZone) + hour * 3_600_000;
  if (candidate <= nowMs) {
    const p = zoneParts(candidate, timeZone);
    candidate = zonedToUtc({ ...p, d: p.d + 1 }, timeZone);
  }
  return candidate;
}
function addMonths(ms, months, timeZone) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15 || !Number.isInteger(months) || Math.abs(months) > 120_000 || !validZone(timeZone)) {
    fail('script', 'invalid date, calendar month offset, or time zone');
  }
  const p = zoneParts(ms, timeZone);
  const month = p.m - 1 + months;
  const y = p.y + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  const d = Math.min(p.d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  return zonedToUtc({ ...p, y, m: m + 1, d }, timeZone);
}

// ---------------------------------------------------------------- snapshot mapper

const snap = msg => fail('invalid-snapshot', msg);
const present = v => v !== undefined && v !== null;
function optNumber(obj, prop, path) {
  const v = obj[prop];
  if (!present(v)) return null;
  if (typeof v !== 'number') snap(`${path}.${prop} must be a number`);
  if (!Number.isFinite(v)) snap(`${path}.${prop} must be finite`);
  return v;
}
function reqNumber(obj, prop, path) {
  const v = optNumber(obj, prop, path);
  if (v === null) snap(`${path}.${prop} is required`);
  return v;
}
function optString(obj, prop, path, { max = 256, chars = false } = {}) {
  const v = obj[prop];
  if (!present(v)) return null;
  if (typeof v !== 'string') snap(`${path}.${prop} must be a string`);
  const s = trim(v);
  if (chars ? graphemes(s) > max : utf8Length(s) > max) snap(`${path}.${prop} exceeds ${max} ${chars ? 'characters' : 'UTF-8 bytes'}`);
  return s || null;
}
function reqString(obj, prop, path, opts) {
  const v = optString(obj, prop, path, opts);
  if (v === null) snap(`${path}.${prop} is required`);
  return v;
}
function optDate(obj, prop, path) {
  const v = obj[prop];
  if (!present(v)) return null;
  if (isDate(v)) {
    const t = Date.prototype.getTime.call(v);
    return Number.isFinite(t) ? t : snap(`${path}.${prop} is not a valid date`);
  }
  if (typeof v !== 'string') snap(`${path}.${prop} must be a Date or ISO-8601 string`);
  const t = /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) snap(`${path}.${prop} is not a valid ISO-8601 date`);
  return t;
}
function boundedCount(v, max, path) {
  if (!Array.isArray(v) || v.length > max) snap(`${path} exceeds ${max} entries`);
  return v.length;
}
function objectKeys(v, path) {
  if (!isObject(v) || isDate(v)) snap(`${path} must be an object`);
  return Reflect.ownKeys(v).map(String);
}

function mapWindow(v, path, percentPolicy) {
  if (!isObject(v)) snap(`${path} must be an object`);
  const raw = reqNumber(v, 'usedPercent', path);
  const minutes = optNumber(v, 'windowMinutes', path);
  if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0 && minutes <= Number.MAX_SAFE_INTEGER)) {
    snap(`${path}.windowMinutes must be a positive integer`);
  }
  const regen = optNumber(v, 'nextRegenPercent', path);
  return {
    usedPercent: percentPolicy === 'preserve-overage' ? Math.max(0, raw) : Math.min(100, Math.max(0, raw)),
    windowMinutes: minutes, resetsAt: optDate(v, 'resetsAt', path),
    resetDescription: optString(v, 'resetDescription', path), nextRegenPercent: regen === null ? null : Math.min(100, Math.max(0, regen)),
  };
}

const DETAIL = { chars: true, max: 120 };
function mapDetails(root) {
  if (!present(root.details)) return [];
  if (!Array.isArray(root.details)) snap('details must be an array');
  boundedCount(root.details, 8, 'details');
  return root.details.map((section, i) => {
    const path = `details[${i}]`;
    if (!isObject(section)) snap(`${path} must be an object`);
    if (!Array.isArray(section.rows)) snap(`${path}.rows must be an array`);
    boundedCount(section.rows, 24, `${path}.rows`);
    const rows = section.rows.map((row, j) => {
      const rp = `${path}.rows[${j}]`;
      if (!isObject(row)) snap(`${rp} must be an object`);
      const progress = optNumber(row, 'progress', rp);
      if (progress !== null && (progress < 0 || progress > 1)) snap(`${rp}.progress must be between 0 and 1`);
      const out = { label: reqString(row, 'label', rp, DETAIL), value: reqString(row, 'value', rp, DETAIL) };
      const secondary = optString(row, 'secondaryValue', rp, DETAIL);
      if (secondary !== null) out.secondaryValue = secondary;
      if (progress !== null) out.progress = progress;
      const usageValue = optNumber(row, 'usageValue', rp);
      if (usageValue !== null) out.usageValue = usageValue;
      return out;
    });
    const out = { rows };
    const title = optString(section, 'title', path, DETAIL);
    if (title !== null) out.title = title;
    if (present(section.chart)) {
      const cp = `${path}.chart`;
      if (!isObject(section.chart)) snap(`${cp} must be an object`);
      const kind = reqString(section.chart, 'kind', cp, DETAIL);
      if (kind !== 'bars' && kind !== 'line') snap(`${cp}.kind must be 'bars' or 'line'`);
      if (!Array.isArray(section.chart.points)) snap(`${cp}.points must be an array`);
      boundedCount(section.chart.points, 120, `${cp}.points`);
      const chart = { kind };
      const chartTitle = optString(section.chart, 'title', cp, DETAIL);
      if (chartTitle !== null) chart.title = chartTitle;
      const unit = optString(section.chart, 'unit', cp, DETAIL);
      if (unit !== null) chart.unit = unit;
      chart.points = section.chart.points.map((p, k) => {
        const pp = `${cp}.points[${k}]`;
        if (!isObject(p)) snap(`${pp} must be an object`);
        return { label: reqString(p, 'label', pp, DETAIL), value: reqNumber(p, 'value', pp) };
      });
      out.chart = chart;
    }
    return out;
  });
}

// ---------------------------------------------------------------- costUsage (ProviderPluginSnapshotMapper.costUsage)

function optInteger(obj, prop, path, positive) {
  const n = optNumber(obj, prop, path);
  if (n === null) return null;
  if (!(Math.round(n) === n && (positive ? n > 0 : n >= 0) && n <= Number.MAX_SAFE_INTEGER)) {
    snap(`${path}.${prop} must be a ${positive ? 'positive' : 'nonnegative'} integer`);
  }
  return n;
}
function reqInteger(obj, prop, path, positive = false) {
  const n = optInteger(obj, prop, path, positive);
  if (n === null) snap(`${path}.${prop} is required`);
  return n;
}
/** CostUsageDateParser.parse("<day>T12:00:00Z") over a strict YYYY-MM-DD: noon UTC, or null for a non-calendar date. */
function noonUTC(day) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? t : null;
}
function checkedSum(a, b, path) {
  const s = a + b;
  if (!(s <= Number.MAX_SAFE_INTEGER)) snap(`${path} overflowed`);
  return s;
}
const accumulator = () => ({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, hasReasoningTokens: false, requests: 0,
  estimatedRequests: 0, cost: 0, estimatedCost: 0 });

function mapCostUsage(root) {
  const value = root.costUsage;
  if (!present(value)) return null;
  if (!isObject(value)) snap('costUsage must be an object');
  const currency = reqString(value, 'currency', 'costUsage');
  if (!/^[A-Z]{3}$/.test(currency)) snap('costUsage.currency must be a three-letter uppercase currency literal');
  const historyDays = reqInteger(value, 'historyDays', 'costUsage', true);
  if (historyDays > 366) snap('costUsage.historyDays exceeds 366');
  const historyLabel = optString(value, 'historyLabel', 'costUsage');
  const windowEndDate = noonUTC(reqString(value, 'windowEnd', 'costUsage'));
  if (windowEndDate === null) snap('costUsage.windowEnd must be a valid YYYY-MM-DD date');
  const windowStartDate = windowEndDate - (historyDays - 1) * 86_400_000;
  if (!Array.isArray(value.entries)) snap('costUsage.entries must be an array');
  boundedCount(value.entries, 10_000, 'costUsage.entries');
  const entries = value.entries.map((entry, index) => {
    const path = `costUsage.entries[${index}]`;
    if (!isObject(entry)) snap(`${path} must be an object`);
    const date = reqString(entry, 'date', path);
    const entryDate = noonUTC(date);
    if (entryDate === null) snap(`${path}.date must be a valid YYYY-MM-DD date`);
    if (entryDate < windowStartDate || entryDate > windowEndDate) snap(`${path}.date falls outside the declared history window`);
    const inputTokens = reqInteger(entry, 'inputTokens', path);
    const outputTokens = reqInteger(entry, 'outputTokens', path);
    const reasoningTokens = optInteger(entry, 'reasoningTokens', path, false);
    const requests = reqInteger(entry, 'requests', path);
    const cost = reqNumber(entry, 'cost', path);
    if (cost < 0) snap(`${path}.cost must be nonnegative`);
    const estimatedCost = optNumber(entry, 'estimatedCost', path) ?? 0;
    if (estimatedCost < 0 || estimatedCost > cost) snap(`${path}.estimatedCost must be nonnegative and no greater than cost`);
    return { date, inputTokens, outputTokens, reasoningTokens, requests, cost, estimatedCost, model: optString(entry, 'model', path) };
  });
  // aggregateCostUsageEntries: group by (date, model), then by date; keys sorted.
  const grouped = new Map();
  for (const e of entries) {
    const key = `${e.date}\u001F${e.model ?? ''}`;
    const a = grouped.get(key) ?? accumulator();
    a.inputTokens = checkedSum(a.inputTokens, e.inputTokens, 'costUsage input token total');
    a.outputTokens = checkedSum(a.outputTokens, e.outputTokens, 'costUsage output token total');
    if (e.reasoningTokens !== null) {
      a.reasoningTokens = checkedSum(a.reasoningTokens, e.reasoningTokens, 'costUsage reasoning token total');
      a.hasReasoningTokens = true;
    }
    a.requests = checkedSum(a.requests, e.requests, 'costUsage request total');
    a.cost += e.cost;
    a.estimatedCost += e.estimatedCost;
    if (e.estimatedCost > 0) a.estimatedRequests = checkedSum(a.estimatedRequests, e.requests, 'costUsage estimated request total');
    if (!Number.isFinite(a.cost) || !Number.isFinite(a.estimatedCost)) snap('costUsage cost total overflowed');
    grouped.set(key, a);
  }
  const dailyGrouped = new Map();
  const breakdownsByDate = new Map();
  for (const key of [...grouped.keys()].sort()) {
    const sep = key.indexOf('\u001F');
    const date = key.slice(0, sep);
    const model = key.slice(sep + 1) || null;
    const a = grouped.get(key);
    const totalTokens = checkedSum(a.inputTokens, a.outputTokens, 'costUsage token total');
    if (model !== null) {
      const breakdown = { modelName: model, costUSD: a.cost, totalTokens, requestCount: a.requests, inputTokens: a.inputTokens, outputTokens: a.outputTokens };
      if (a.hasReasoningTokens) breakdown.reasoningTokens = a.reasoningTokens;
      breakdownsByDate.set(date, [...(breakdownsByDate.get(date) ?? []), breakdown]);
    }
    const d = dailyGrouped.get(date) ?? accumulator();
    d.inputTokens = checkedSum(d.inputTokens, a.inputTokens, 'costUsage daily input token total');
    d.outputTokens = checkedSum(d.outputTokens, a.outputTokens, 'costUsage daily output token total');
    d.reasoningTokens = checkedSum(d.reasoningTokens, a.reasoningTokens, 'costUsage daily reasoning token total');
    d.hasReasoningTokens ||= a.hasReasoningTokens;
    d.requests = checkedSum(d.requests, a.requests, 'costUsage daily request total');
    d.estimatedRequests = checkedSum(d.estimatedRequests, a.estimatedRequests, 'costUsage daily estimated request total');
    d.cost += a.cost;
    d.estimatedCost += a.estimatedCost;
    if (!Number.isFinite(d.cost) || !Number.isFinite(d.estimatedCost)) snap('costUsage daily cost total overflowed');
    dailyGrouped.set(date, d);
  }
  const daily = [...dailyGrouped.keys()].sort().map(date => {
    const a = dailyGrouped.get(date);
    const out = { date, inputTokens: a.inputTokens, outputTokens: a.outputTokens };
    if (a.hasReasoningTokens) out.reasoningTokens = a.reasoningTokens;
    Object.assign(out, { totalTokens: checkedSum(a.inputTokens, a.outputTokens, 'costUsage token total'), requestCount: a.requests, costUSD: a.cost });
    const breakdowns = breakdownsByDate.get(date);
    if (breakdowns) Object.assign(out, { modelsUsed: breakdowns.map(b => b.modelName), modelBreakdowns: breakdowns });
    if (a.estimatedRequests > 0) out.estimatedRequestCount = a.estimatedRequests;
    return out;
  });
  const totalTokens = daily.reduce((s, d) => checkedSum(s, d.totalTokens, 'costUsage token total'), 0);
  const totalRequests = daily.reduce((s, d) => checkedSum(s, d.requestCount, 'costUsage request total'), 0);
  const totalCost = daily.reduce((s, d) => s + d.costUSD, 0);
  const totalEstimatedCost = entries.reduce((s, e) => s + e.estimatedCost, 0);
  if (!Number.isFinite(totalCost) || !Number.isFinite(totalEstimatedCost)) snap('costUsage cost total overflowed');
  const metered = totalCost - totalEstimatedCost;
  return {
    currencyCode: currency, historyDays, historyLabel, last30DaysTokens: totalTokens, last30DaysCostUSD: totalCost,
    last30DaysRequests: totalRequests, meteredCostUSD: totalEstimatedCost > 0 && metered > 0 ? metered : null,
    costProvenance: totalEstimatedCost > 0 ? (metered > 0 ? 'mixed' : 'listPriceEstimate') : 'vendorMetered',
    daily, updatedAt: windowEndDate,
  };
}

const SNAPSHOT_KEYS = new Set(['primary', 'secondary', 'tertiary', 'extraWindows', 'cost', 'costUsage', 'details', 'identity',
  'subscriptionRenewsAt', 'subscriptionExpiresAt', 'dataConfidence', 'empty']);

function mapSnapshot(v, percentPolicy) {
  if (objectKeys(v, 'usage').some(k => !SNAPSHOT_KEYS.has(k))) snap('usage contains unknown keys');
  const win = p => present(v[p]) ? mapWindow(v[p], p, percentPolicy) : null;
  const usage = { primary: win('primary'), secondary: win('secondary'), tertiary: win('tertiary'), extraWindows: [] };
  if (present(v.extraWindows)) {
    if (!Array.isArray(v.extraWindows)) snap('extraWindows must be an array');
    boundedCount(v.extraWindows, 64, 'extraWindows');
    usage.extraWindows = v.extraWindows.map((item, i) => {
      const path = `extraWindows[${i}]`;
      if (!isObject(item)) snap(`${path} must be an object`);
      const id = reqString(item, 'id', path);
      const title = reqString(item, 'title', path);
      const source = isObject(item.window) ? item.window : item;
      if (present(item.usageKnown) && typeof item.usageKnown !== 'boolean') snap(`${path}.usageKnown must be a boolean`);
      return { id, title, window: mapWindow(source, `${path}.window`, percentPolicy), usageKnown: item.usageKnown !== false };
    });
  }
  usage.cost = null;
  if (present(v.cost)) {
    if (!isObject(v.cost)) snap('cost must be an object');
    const currency = reqString(v.cost, 'currency', 'cost');
    if (!/^[A-Z]{3}$/.test(currency)) snap('cost.currency must be a three-letter uppercase currency literal');
    usage.cost = { used: reqNumber(v.cost, 'used', 'cost'), limit: optNumber(v.cost, 'limit', 'cost') ?? 0, currency,
      period: optString(v.cost, 'period', 'cost'), resetsAt: optDate(v.cost, 'resetsAt', 'cost'),
      nextRegenAmount: optNumber(v.cost, 'nextRegenAmount', 'cost'), balance: optNumber(v.cost, 'balance', 'cost') };
  }
  usage.costUsage = mapCostUsage(v);
  usage.details = mapDetails(v);
  usage.identity = null;
  if (present(v.identity)) {
    if (!isObject(v.identity)) snap('identity must be an object');
    const identity = {};
    for (const key of ['email', 'organization', 'loginMethod', 'accountID']) {
      const s = optString(v.identity, key, 'identity');
      if (s !== null) identity[key] = s;
    }
    usage.identity = identity;
  }
  usage.subscriptionRenewsAt = optDate(v, 'subscriptionRenewsAt', 'snapshot');
  usage.subscriptionExpiresAt = optDate(v, 'subscriptionExpiresAt', 'snapshot');
  const dc = v.dataConfidence;
  if (present(dc) && !['exact', 'estimated', 'percentOnly', 'unknown'].includes(dc)) {
    snap("dataConfidence must be 'exact', 'estimated', 'percentOnly', or 'unknown'");
  }
  usage.dataConfidence = present(dc) ? dc : 'unknown';
  if (v.empty !== undefined && typeof v.empty !== 'boolean') snap('empty must be a boolean');
  usage.empty = v.empty === true;
  const meaningful = usage.identity && Object.keys(usage.identity).length > 0;
  if (!(usage.empty || usage.primary || usage.secondary || usage.tertiary || usage.extraWindows.length || usage.cost
    || usage.costUsage || usage.details.length || meaningful)) {
    snap('snapshot must contain a rate window, cost, detail section, or identity field, or declare empty: true');
  }
  return usage;
}

function resultString(v, path) {
  if (typeof v !== 'string') snap(`${path} must be a string`);
  if (!trim(v) || utf8Length(v) > 256 || /[\u0000-\u001F\u007F-\u009F]/.test(v)) {
    snap(`${path} must contain 1-256 bytes without control characters`);
  }
  return v;
}

/** Runs a result-policy step; its plain errors become invalid-snapshot failures. */
function policyStep(fn) {
  try { return fn(); } catch (error) { if (error instanceof PluginError) throw error; return snap(error?.message ?? String(error)); }
}

/**
 * ProviderPluginSnapshotMapper.mapResult: a bare snapshot or `{ usage, sourceLabel?, card?, persist? }`. Card and
 * persist are allowed only by the grant registered for `manifest.id` (result-policy.mjs); no manifest ⇒ no grants.
 * A persisted key must also be declared a plain setting by the manifest (this port never persists a secure value).
 */
export function mapPluginResult(value, { percentPolicy = 'clamp', manifest = null, now = Date.now() } = {}) {
  const keys = objectKeys(value, 'result');
  if (!keys.includes('usage')) return { usage: mapSnapshot(value, percentPolicy), sourceLabel: null, persist: Object.create(null) };
  if (keys.some(k => !['usage', 'sourceLabel', 'card', 'persist'].includes(k))) snap('result contains unknown keys');
  const policy = resultPolicyFor(manifest?.id);
  let usage = mapSnapshot(value.usage, percentPolicy);
  const sourceLabel = keys.includes('sourceLabel') ? resultString(value.sourceLabel, 'sourceLabel') : null;
  if (keys.includes('card')) {
    if (!policy.cardMapper) snap('card is not allowed for this provider');
    usage = policyStep(() => policy.cardMapper(value.card, usage, now));
  }
  const persist = Object.create(null); // a `__proto__` key must stay a key (and be refused), not set a prototype
  if (keys.includes('persist')) {
    const persistKeys = objectKeys(value.persist, 'persist');
    if (persistKeys.length > 16) snap('persist exceeds 16 keys');
    for (const k of persistKeys) persist[k] = policyStep(() => policyString(value.persist[k], 'persist value'));
    policyStep(() => applyPersist(policy, persist, {}));
    for (const k of Object.keys(persist)) {
      if (manifest.settings.find(s => s.key === k)?.kind !== 'plain') snap(`persist setting '${k}' must be a declared plain setting`);
    }
  }
  return { usage, sourceLabel, persist };
}

const isoOrNull = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Our reading shape. Identity is NEVER part of it; callers get it separately and keep it out of the tree. */
export function toReading(result, providerId, nowMs) {
  const { usage } = result;
  const windows = [];
  for (const which of ['primary', 'secondary', 'tertiary']) {
    const w = usage[which];
    if (w) windows.push({ limitId: `${providerId}-${which}`, usedPercent: w.usedPercent, windowDurationMins: w.windowMinutes, resetsAt: isoOrNull(w.resetsAt) });
  }
  for (const extra of usage.extraWindows) {
    windows.push({ limitId: extra.id, usedPercent: extra.window.usedPercent, windowDurationMins: extra.window.windowMinutes, resetsAt: isoOrNull(extra.window.resetsAt) });
  }
  const reading = { status: 'ok', source: `plugin:${providerId}`, updatedAt: isoOrNull(nowMs), windows };
  if (usage.cost) reading.cost = { ...usage.cost, resetsAt: isoOrNull(usage.cost.resetsAt) };
  if (usage.costUsage) reading.costUsage = { ...usage.costUsage, updatedAt: isoOrNull(usage.costUsage.updatedAt) };
  if (usage.details.length) reading.details = usage.details;
  if (usage.openAIAPIUsage) {
    // projectID is an account identifier (openai.js also puts it in identity) — it stays out of the reading.
    const { historyDays, daily } = usage.openAIAPIUsage;
    reading.openAIAPIUsage = { historyDays, daily: daily.map(d => ({ ...d, startTime: isoOrNull(d.startTime), endTime: isoOrNull(d.endTime) })) };
  }
  return reading;
}

// ---------------------------------------------------------------- failures + redaction

function redactor(values) {
  return text => {
    let out = String(text);
    for (const v of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
    return out;
  };
}

/** ProviderPluginRuntime's failure(from:): classified marker → its kind; host failures keep theirs; else a script error. */
function failureFrom(value, redact) {
  let message;
  try { message = typeof value?.message === 'string' ? value.message : String(value); } catch { message = 'unprintable rejection'; }
  message = redact(message);
  const v2 = /^__CODEXBAR_FAILURE_V2__:([a-z-]+):([^:]*):([\s\S]*)$/.exec(message);
  const v1 = v2 ? null : /^__CODEXBAR_FAILURE__:([a-z-]+):([\s\S]*)$/.exec(message);
  const kind = v2?.[1] ?? v1?.[1];
  if (kind && CLASSIFIED.has(kind)) {
    const retry = v2?.[2] ? Number(v2[2]) : null;
    if (retry === null || Number.isFinite(retry)) return rawError(kind, v2 ? v2[3] : v1[2], { retryAfterSeconds: retry });
  }
  let hostKind = null;
  try { hostKind = isObject(value) && typeof value.kind === 'string' && HOST_KINDS.has(value.kind) ? value.kind : null; } catch { /* plugin getter */ }
  if (hostKind) return rawError(hostKind, message);
  return new PluginError('script', message);
}

// ---------------------------------------------------------------- the engine (one vm context)

// V8 seeds every new context with `console`; QuickJS has none, and a plugin gets ctx.log instead.
const BOOTSTRAP = `(() => {
  delete globalThis.console;
  let definition;
  Object.defineProperty(globalThis, 'defineProvider', { value: function defineProvider(value) { definition = value; },
    writable: false, enumerable: false, configurable: false });
  return () => definition;
})()`;
const INVOKE = new vm.Script('globalThis.__codexbarInvoke()');

function createEngine(source, filename, watchdogMs) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const intrinsics = vm.runInContext('({ Error: Error, JSON: JSON })', context);
  const definition = vm.runInContext(BOOTSTRAP, context);
  const applyPrelude = vm.runInContext(PRELUDE, context, { filename: 'provider-plugin-prelude.js' });
  const thunk = vm.runInContext('(fn, ctx) => () => fn(ctx)', context);
  try {
    vm.runInContext(source, context, { filename, timeout: watchdogMs });
  } catch (error) {
    throw new PluginError('load', typeof error?.message === 'string' ? error.message : String(error));
  }
  const def = definition();
  if (def === undefined) fail('invalid-manifest', 'plugin did not call defineProvider(...)');
  if (typeof def?.fetchUsage !== 'function') fail('invalid-manifest', "'fetchUsage' must be a function");
  return { sandbox, context, intrinsics, applyPrelude, thunk, fetchUsage: def.fetchUsage, manifest: parseManifest(def) };
}

/**
 * Loads one plugin. Options: transport (default node fetch), timers ({setTimeout, clearTimeout}; default the
 * globals at call time), log(line), cookieSource(domain) → Cookie header (A1 default: none → "unavailable"),
 * onRejectCookie(domain, id), watchdogMs (20 s), responseSizeLimit (5 MiB), filename, storageDirectory (persistent
 * storage; default `plugin-storage/` beside the usage-readers config).
 */
/**
 * The default `cookieSource` for a plugin that declares the browser-cookies capability: the B2b broker
 * over the Chromium reader and the access gate. Returns `null` (⇒ browser cookies unavailable) when the
 * plugin declares no cookies, off darwin, or in any test process — the default must never open a real
 * browser profile or the real keychain (tests inject their own `cookieSource`).
 */
export function defaultCookieSource(manifest, { env = process.env, platform = process.platform, log = () => {} } = {}) {
  if (!manifest?.capabilities?.includes('browser-cookies')) return null;
  if (platform !== 'darwin' || isRealKeychainBlocked(env)) return null;
  const credentials = createCredentialStore({ env, log });
  const reader = createChromiumCookieReader({ credentials, log });
  const gate = createCookieAccessGate({ log });
  const broker = createCookieBroker({ reader, gate, domains: manifest.cookieDomains, log });
  return domain => broker.cookieHeader(domain);
}

export function loadPlugin(source, options = {}) {
  const {
    transport = nodeFetchTransport, log = () => {}, onRejectCookie = () => {},
    watchdogMs = WATCHDOG_MS, responseSizeLimit = MAX_RESPONSE_BYTES, filename = 'plugin.js', redactionSet,
  } = options;
  const timers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: id => globalThis.clearTimeout(id),
  };
  let engine = createEngine(source, filename, watchdogMs);
  const manifest = engine.manifest;
  // Default browser cookie source: the B2b broker over the Chromium reader. An explicit `cookieSource`
  // (including `null`) always wins. The default fails closed off darwin and in any test process — it
  // must never open a real browser profile or the real keychain.
  const cookieSource = 'cookieSource' in options ? options.cookieSource : defaultCookieSource(manifest, { log });
  let queue = Promise.resolve();
  // ProviderPluginRuntime: a store only with the persistent-storage capability; default `<config dir>/plugin-storage`.
  const storage = manifest.capabilities.includes('persistent-storage')
    ? createPluginStorage(options.storageDirectory ?? join(dirname(defaultConfigPath()), 'plugin-storage'), manifest.id)
    : null;

  function makeHost(eng, state, settings, secrets, nowMs) {
    const { intrinsics } = eng;
    const toInner = value => intrinsics.JSON.parse(JSON.stringify(value));
    const innerError = error => new intrinsics.Error(state.redact(typeof error?.message === 'string' ? error.message : String(error)));
    const guard = fn => (...args) => { try { return fn(...args); } catch (error) { throw innerError(error); } };
    const rejectWith = (reject, error) => {
      if (state.interrupted) return;
      const payload = { message: state.redact(error?.message ?? String(error)) };
      if (error?.kind) payload.kind = error.kind;
      if (error?.transportClass) {
        Object.assign(payload, { transportClass: error.transportClass, retryable: RETRY_POLICY.transportClasses.has(error.transportClass) });
      }
      reject(toInner(payload));
    };

    /** One attempt: the redirect chain under one per-attempt deadline (URLRequest.timeoutInterval). */
    async function attemptOnce(request) {
      let current = request;
      const controller = new AbortController();
      state.controllers.add(controller);
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = timers.setTimeout(() => {
          controller.abort();
          reject(rawError('network', 'The request timed out.', { transportClass: 'timeout' }));
        }, request.timeoutSeconds * 1000);
      });
      try {
        for (let hop = 0; ; hop += 1) {
          let res;
          try {
            res = await Promise.race([deadline, transport({ ...current, signal: controller.signal, maxBytes: responseSizeLimit })]);
          } catch (error) {
            if (error instanceof PluginError) throw error;
            throw rawError('network', `network error: ${error?.message ?? String(error)}`, { transportClass: transportClassOf(error) });
          }
          const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
          if ([301, 302, 303, 307, 308].includes(res.status) && headers.location && hop < MAX_REDIRECTS) {
            let next = null;
            try { next = new URL(headers.location, current.url); } catch { /* unparseable: hand back the 3xx */ }
            if (next && redirectAllowed(request.url, next)) {
              const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === 'POST');
              current = toGet ? { ...current, url: next.href, method: 'GET', body: undefined } : { ...current, url: next.href };
              continue;
            }
          }
          return { status: res.status, url: current.url, headers, body: res.body };
        }
      } finally {
        timers.clearTimeout(timer);
        state.controllers.delete(controller);
      }
    }

    const sleep = ms => (ms > 0 ? new Promise(resolve => { timers.setTimeout(resolve, ms); }) : Promise.resolve());

    /** ProviderHTTPTransport.response(for:retryPolicy:): retry a retryable status or transport error, then hand back. */
    async function withRetry(request, retry) {
      for (let attempt = 0; ; attempt += 1) {
        const canRetry = retry && attempt < RETRY_POLICY.maxRetries && RETRY_POLICY.methods.has(request.method);
        let res;
        try {
          res = await attemptOnce(request);
        } catch (error) {
          if (!canRetry || state.interrupted || !RETRY_POLICY.transportClasses.has(error?.transportClass)) throw error;
          await sleep(retryDelaySeconds(attempt, null) * 1000);
          continue;
        }
        if (!canRetry || state.interrupted || !RETRY_POLICY.statuses.has(res.status)) return res;
        await sleep(retryDelaySeconds(attempt, res.headers['retry-after']) * 1000);
      }
    }

    /** ProviderPluginHTTPResponse.checkedPayload + payload: size cap, (optional: 2xx only), UTF-8, JSON. */
    function toPayload(res, wantsJSON, requireSuccess = false) {
      const bytes = typeof res.body === 'string' ? Buffer.from(res.body, 'utf8') : Buffer.from(res.body ?? []);
      if (bytes.byteLength > responseSizeLimit) fail('http', `response exceeded the ${responseSizeLimit}-byte limit`);
      if (requireSuccess && !(res.status >= 200 && res.status < 300)) fail('http', `request returned HTTP ${res.status}`);
      const payload = { status: res.status, url: res.url, headers: res.headers };
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('http', 'response body was not valid UTF-8'); }
      if (wantsJSON) {
        try { payload.json = JSON.parse(text); } catch { fail('http', 'response was not valid JSON'); }
      } else {
        payload.bodyText = text;
      }
      return payload;
    }

    /**
     * ProviderPluginHTTPResponse.fetch: the primary (with its retry policy) and the optional request (no retry) run
     * together; once the primary is in, wait for the optional only while the collection budget — started with the
     * primary's first attempt — has not expired, and attach it only to a 2xx primary.
     */
    async function perform(call, wantsJSON) {
      if (!call.optional) return toPayload(await withRetry(call.primary, call.retry), wantsJSON);
      let optionalDone = false;
      let optionalRes = null;
      const optionalRun = withRetry(call.optional, false)
        .then(res => { optionalRes = res; }, () => {})
        .finally(() => { optionalDone = true; });
      let budgetExpired = false;
      let budgetTimer;
      const budget = new Promise(resolve => {
        budgetTimer = timers.setTimeout(() => { budgetExpired = true; resolve(); }, call.optionalBudgetMs);
      });
      try {
        const primary = await withRetry(call.primary, call.retry);
        const ok = primary.status >= 200 && primary.status < 300;
        if (ok && !optionalDone && !budgetExpired) await Promise.race([optionalRun, budget]);
        const kept = optionalRes;
        const payload = toPayload(primary, wantsJSON);
        payload.optional = null;
        if (ok && kept) {
          try { payload.optional = toPayload(kept, wantsJSON, true); } catch { /* try? → null */ }
        }
        return payload;
      } finally {
        timers.clearTimeout(budgetTimer);
      }
    }

    const sessionsServed = new Set();
    async function resolveCookie(rawDomain) {
      const domain = declaredCookieDomain(manifest, rawDomain);
      if (!cookieSource) fail('secret-access', 'browser cookie access is unavailable');
      let header;
      try { header = await cookieSource(domain); } catch (error) { fail('secret-access', state.redact(error?.message ?? String(error))); }
      if (typeof header !== 'string' || !header) fail('secret-access', 'browser cookie access is unavailable');
      state.secrets.add(header);
      for (const pair of header.split(';')) {
        const value = pair.slice(pair.indexOf('=') + 1).trim();
        if (pair.includes('=') && value) state.secrets.add(value);
      }
      return { domain, header };
    }

    return {
      cookieBrowserNames: toInner([]),
      settingGet: guard((key, secure) => {
        if (!manifest.settings.some(s => s.key === key && s.kind === (secure ? 'secure' : 'plain'))) {
          throw new Error(`${secure ? 'secret' : 'plain'} setting '${key}' is not declared`);
        }
        const value = (secure ? secrets : settings)[key];
        return value ? value : null;
      }),
      storage: guard((operation, key, value) => {
        if (!storage) fail('script', 'persistent storage is unavailable or not declared');
        return storage.access(operation, key, value);
      }),
      http: guard((rawURL, options, method, wantsJSON, resolve, reject) => {
        let call;
        try {
          call = buildHTTPCall(manifest, rawURL, options ?? {}, method, settings, secrets);
        } catch (error) { rejectWith(reject, error); return; }
        if (state.interrupted) return;
        perform(call, wantsJSON).then(
          payload => { if (!state.interrupted) resolve(toInner(payload)); },
          error => rejectWith(reject, error));
      }),
      cookieAvailability: guard(domain => { declaredCookieDomain(manifest, domain); return cookieSource ? 'auto' : 'off'; }),
      rejectCookie: guard((domain, id) => { onRejectCookie(declaredCookieDomain(manifest, domain), id); }),
      acceptCookie: guard(domain => { declaredCookieDomain(manifest, domain); fail('secret-access', 'cookie persistence is unavailable'); }),
      cookieHeader: guard((domain, _cachedOnly, resolve, reject) => {
        resolveCookie(domain).then(({ header }) => { if (!state.interrupted) resolve(header); }, error => rejectWith(reject, error));
      }),
      cookieSession: guard((rawDomain, _cachedOnly, resolve, reject) => {
        const key = trim(rawDomain).toLowerCase();
        if (sessionsServed.has(key)) { resolve('null'); return; }
        sessionsServed.add(key);
        resolveCookie(rawDomain).then(({ domain, header }) => {
          if (!state.interrupted) resolve(JSON.stringify({ id: `cookie-source:${domain}`, header, origin: `https://${domain}`, source: 'cookieSource' }));
        }, error => rejectWith(reject, error));
      }),
      cacheGet: guard(key => {
        const entry = state.cache.get(key);
        if (!entry || entry.expiresAt <= Date.now()) { state.cache.delete(key); return undefined; }
        return entry.value;
      }),
      cacheSet: guard((key, value, ttl) => {
        if (!Number.isFinite(ttl) || ttl <= 0) return;
        state.cache.set(key, { value, expiresAt: Date.now() + Math.min(ttl, 86_400) * 1000 });
      }),
      log: guard(message => { log({ category: `${manifest.id}-plugin`, message: state.redact(message) }); }),
      pct: guard((used, limit) => (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 ? 100 : Math.min(100, Math.max(0, (used / limit) * 100)))),
      amountFromPercent: guard((percent, limit) => (percent / 100) * limit),
      isDetailLabel: guard(label => { const s = trim(label); return s.length > 0 && graphemes(s) <= 120; }),
      formatCurrency: guard((amount, code) => {
        try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount); } catch { return `${code} ${amount.toFixed(2)}`; }
      }),
      nextDailyReset: guard((zone, hour) => nextDailyReset(nowMs, zone, hour)),
      addMonths: guard((ms, months, zone) => addMonths(ms, months, zone)),
    };
  }

  async function fetchOnce({ settings = {}, secrets = {}, now = Date.now(), timeZone } = {}) {
    const clean = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, trim(v)]));
    settings = clean(settings);
    secrets = clean(secrets);
    // `redactionSet` (index.mjs): the raw store's live view of this run's secrets — settings + cookies land in it.
    const state = { interrupted: false, controllers: new Set(), secrets: redactionSet ?? new Set(), cache: null };
    for (const v of Object.values(secrets)) if (v) state.secrets.add(v);
    state.redact = redactor(state.secrets);
    if (manifest.auth && !secrets[manifest.auth.secret]) fail('secret-access', `required secret '${manifest.auth.secret}' is unavailable`);
    if (!engine) {
      engine = createEngine(source, filename, watchdogMs);
      if (engine.manifest.id !== manifest.id) fail('load', 'reloaded plugin changed provider id');
    }
    const eng = engine;
    eng.cache ??= new Map();
    state.cache = eng.cache;
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        state.interrupted = true;
        for (const c of state.controllers) c.abort();
        if (engine === eng) engine = null; // the poisoned context is discarded; the next fetch builds a fresh one
        reject(new PluginError('timeout'));
      }, watchdogMs);
    });
    const run = (async () => {
      const ctx = vm.runInContext('({})', eng.context);
      ctx.__codexbarNowMillis = nowMs;
      ctx.env = eng.intrinsics.JSON.parse(JSON.stringify({ timeZone: zone }));
      eng.applyPrelude(ctx, makeHost(eng, state, settings, secrets, nowMs));
      let value;
      try {
        eng.sandbox.__codexbarInvoke = eng.thunk(eng.fetchUsage, ctx);
        value = await INVOKE.runInContext(eng.context, { timeout: watchdogMs });
      } catch (error) {
        throw failureFrom(error, state.redact);
      } finally {
        delete eng.sandbox.__codexbarInvoke;
      }
      try {
        return mapPluginResult(value, { percentPolicy: manifest.percentPolicy, manifest, now: nowMs });
      } catch (error) {
        throw rawError('invalid-snapshot', state.redact(error.message));
      }
    })();
    try {
      return { ...(await Promise.race([run, watchdog])), nowMs };
    } catch (error) {
      if (error instanceof PluginError) { error.message = state.redact(error.message); throw error; }
      throw failureFrom(error, state.redact);
    } finally {
      timers.clearTimeout(timer);
      run.catch(() => {});
    }
  }

  /** Throws a PluginError on failure; one fetch at a time per runtime, like CodexBar's serial worker. */
  function fetchResult(opts) {
    const next = queue.then(() => fetchOnce(opts));
    queue = next.catch(() => {});
    return next;
  }

  /** `{ reading, identity, sourceLabel }`, or `{ reading: unavailable, identity: null, error }` — never throws. */
  async function read(opts = {}) {
    try {
      const result = await fetchResult(opts);
      const identity = result.usage.identity && Object.keys(result.usage.identity).length ? result.usage.identity : null;
      const out = { reading: toReading(result, manifest.id, result.nowMs), identity, sourceLabel: result.sourceLabel };
      if (Object.keys(result.persist).length) out.persist = { ...result.persist };
      return out;
    } catch (error) {
      const kind = error instanceof PluginError ? error.kind : 'script';
      return { reading: { status: 'unavailable', reason: `plugin:${kind}` }, identity: null,
        error: { kind, message: String(error?.message ?? error) } };
    }
  }

  return {
    manifest,
    fetchResult,
    read,
    /** ProviderPluginRuntime.removePersistentStorage. */
    removePersistentStorage: () => { storage?.removeAll(); },
    globalType: name => vm.runInContext(`typeof globalThis[${JSON.stringify(String(name))}]`, (engine ?? createEngine(source, filename, watchdogMs)).context),
  };
}

export function loadBundledPlugin(name, options = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new PluginError('load', `bundled plugin '${name}' was not found`);
  const filename = join(PLUGIN_DIR, `${name}.js`);
  let source;
  try { source = readFileSync(filename, 'utf8'); } catch { throw new PluginError('load', `bundled plugin '${name}.js' was not found`); }
  return loadPlugin(source, { filename, ...options });
}

/**
 * Settings for provider P: env `K` first, then `~/.config/ocli/usage-readers.json` `{ "<P>": { "<K>": "..." } }`
 * (path overridable by env OCLI_USAGE_READERS_CONFIG). Secure settings come back as `secrets` (tracked for redaction).
 */
export function resolvePluginSettings(manifest, { env = process.env, configPath, credentials } = {}) {
  const { section } = readProviderSection(manifest.id, { env, configPath });
  const settings = {};
  const secrets = {};
  let store = credentials;
  for (const { key, kind } of manifest.settings) {
    const fromEnv = typeof env[key] === 'string' ? trim(env[key]) : '';
    let fromKeychain = '';
    if (!fromEnv && kind === 'secure') {
      store ??= createCredentialStore();
      const got = store.read({ service: USAGE_READERS_KEYCHAIN_SERVICE, account: `${manifest.id}.${key}` });
      if (got?.ok && typeof got.value === 'string') fromKeychain = trim(got.value);
    }
    const fromFile = isObject(section) && typeof section[key] === 'string' ? trim(section[key]) : '';
    const value = fromEnv || fromKeychain || fromFile;
    if (value) (kind === 'secure' ? secrets : settings)[key] = value;
  }
  return { settings, secrets };
}

/**
 * The provider's section of the usage-readers config as it is now (`section`: null when the file or the section is
 * absent or unreadable) — the `expected` a later persistSettings compares against.
 */
export function readProviderSection(providerId, { env = process.env, configPath } = {}) {
  const file = configPath ?? defaultConfigPath(env);
  let section = null;
  try {
    const doc = loadConfigDocument(file);
    if (doc && Object.hasOwn(doc, providerId)) section = structuredClone(doc[providerId]);
  } catch { /* unreadable config: env only */ }
  return { file, section };
}

/**
 * One bundled plugin, settings resolved from env + config file. Never throws. A result that persists discovered
 * plain settings is saved into the config file (ProviderPluginConfigWriter) and the outcome is returned as
 * `settingsSave` ('saved' | 'unchanged' | 'stale' | 'failed'); a failed save never fails the reading.
 */
export async function readPluginUsage(name, { env = process.env, configPath, now, timeZone, ...options } = {}) {
  let runtime;
  const file = configPath ?? defaultConfigPath(env);
  try { runtime = loadBundledPlugin(name, { storageDirectory: join(dirname(file), 'plugin-storage'), ...options }); } catch (error) {
    const kind = error instanceof PluginError ? error.kind : 'load';
    return { reading: { status: 'unavailable', reason: `plugin:${kind}` }, identity: null, error: { kind, message: String(error?.message ?? error) } };
  }
  const { section: expected } = readProviderSection(runtime.manifest.id, { configPath: file });
  const { settings, secrets } = resolvePluginSettings(runtime.manifest, { env, configPath: file });
  const result = await runtime.read({ settings, secrets, now, timeZone });
  if (result.persist) {
    result.settingsSave = persistSettings(runtime.manifest.id, result.persist, expected, { configPath: file });
  }
  return result;
}
