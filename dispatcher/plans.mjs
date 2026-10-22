// Provider plans (schema v1): what each subscription allows, read from one file. Strict on purpose —
// a missing or misspelled field is an error naming its path, never a silent default, because a
// defaulted reserve or cap is a quota overrun nobody chose.
import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLE_PLANS = fileURLToPath(new URL('./provider-plans.example.json', import.meta.url));

const SIZES = ['S', 'M', 'L'];
const fail = (p, msg) => { throw new Error(`plans: ${p}: ${msg}`); };

function obj(v, p, keys, optional = []) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(p, 'expected an object');
  for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) fail(`${p}.${k}`, 'unknown key');
  for (const k of keys) if (!(k in v)) fail(`${p}.${k}`, 'missing');
  return v;
}
const oneOf = (v, p, values) => { if (!values.includes(v)) fail(p, `expected one of ${values.map(x => JSON.stringify(x)).join('|')}`); };
const num = (v, p, min = -Infinity, max = Infinity) => {
  if (!Number.isFinite(v) || v < min || v > max) fail(p, `expected a number in ${min}..${max}`);
};
const posInt = (v, p) => { if (!Number.isInteger(v) || v < 1) fail(p, 'expected a positive integer'); };
const bool = (v, p) => { if (typeof v !== 'boolean') fail(p, 'expected true|false'); };
const str = (v, p) => { if (typeof v !== 'string' || !v) fail(p, 'expected a non-empty string'); };
function sizes(v, p) {
  if (v === null) return;
  obj(v, p, SIZES);
  for (const s of SIZES) num(v[s], `${p}.${s}`, 0);
}

function checkWindow(w, p) {
  obj(w, p, ['kind', 'capacity', 'source', 'priorCost']);
  oneOf(w.kind, `${p}.kind`, ['5h', 'weekly']);
  const c = obj(w.capacity, `${p}.capacity`, ['unit', 'value']);
  oneOf(c.unit, `${p}.capacity.unit`, ['percent', 'tokens', 'unknown']);
  if (c.unit === 'unknown') { if (c.value !== null) fail(`${p}.capacity.value`, 'must be null when unit is unknown'); }
  else num(c.value, `${p}.capacity.value`, Number.MIN_VALUE);
  oneOf(w.source, `${p}.source`, ['counter', 'declared', 'learned']);
  sizes(w.priorCost, `${p}.priorCost`);
}

function checkProvider(v, p) {
  obj(v, p, ['pool', 'plan', 'meteredBy', 'limitIds', 'reservePercent', 'onUnknown', 'uncalibratedMaxSize',
    'overflow', 'maxSize', 'priorTokens', 'windows'], ['_note', 'limitScopes']);
  // Q17, additive: an optional free-text `_note` saying why a field is what it is. Never read by code.
  if ('_note' in v) str(v._note, `${p}._note`);
  str(v.pool, `${p}.pool`);
  str(v.plan, `${p}.plan`);
  oneOf(v.meteredBy, `${p}.meteredBy`, ['counter', 'tokens', 'ms']);
  if (v.limitIds !== null) {
    if (!Array.isArray(v.limitIds)) fail(`${p}.limitIds`, 'expected an array or null');
    v.limitIds.forEach((id, i) => str(id, `${p}.limitIds[${i}]`));
  }
  if ('limitScopes' in v) checkScopes(v.limitScopes, v.limitIds, `${p}.limitScopes`);
  num(v.reservePercent, `${p}.reservePercent`, 0, 50);
  oneOf(v.onUnknown, `${p}.onUnknown`, ['refuse', 'until-stop']);
  oneOf(v.uncalibratedMaxSize, `${p}.uncalibratedMaxSize`, [...SIZES, null]);
  bool(v.overflow, `${p}.overflow`);
  oneOf(v.maxSize, `${p}.maxSize`, [...SIZES, null]);
  sizes(v.priorTokens, `${p}.priorTokens`);
  if (!Array.isArray(v.windows)) fail(`${p}.windows`, 'expected an array');
  const seen = new Set();
  v.windows.forEach((w, i) => {
    checkWindow(w, `${p}.windows[${i}]`);
    if (seen.has(w.kind)) fail(`${p}.windows[${i}].kind`, `duplicate window ${w.kind}`);
    seen.add(w.kind);
  });
}

// Q19, additive: `limitScopes: { <limitId>: { models: [...] } }` — that bucket counts only for routes
// whose model is listed (an exact id, or a prefix ending in one trailing `*`; never a regex).
const MODEL_PATTERN = /^[^*]+\*?$/;
function checkScopes(v, limitIds, p) {
  obj(v, p, Object.keys(v ?? {}));
  for (const [id, scope] of Object.entries(v)) {
    if (!Array.isArray(limitIds) || !limitIds.includes(id)) fail(`${p}.${id}`, "expected one of this provider's limitIds");
    obj(scope, `${p}.${id}`, ['models']);
    if (!Array.isArray(scope.models) || !scope.models.length) fail(`${p}.${id}.models`, 'expected a non-empty array');
    scope.models.forEach((m, i) => {
      if (typeof m !== 'string' || !MODEL_PATTERN.test(m)) fail(`${p}.${id}.models[${i}]`, 'expected a model id, or a prefix with one trailing *');
    });
  }
}

/** Whether `model` is one of `patterns`: equal, or starting with a `prefix*` pattern's prefix. */
export function modelMatches(model, patterns) {
  if (typeof model !== 'string') return false;
  return patterns.some(m => (m.endsWith('*') ? model.startsWith(m.slice(0, -1)) : model === m));
}

/**
 * Q19: the limitIds that bind a route on `model` — THE seam gateFor, the dispatch candidate gate and
 * quota.decide all scope through. A scoped id stays only when the model matches its scope. No model
 * (a pool-wide question: summaries, the usage printout) keeps every id, which is today's behaviour.
 * `limitIds: null` (every window) is returned as is.
 */
export function scopedLimitIds({ limitIds, limitScopes = null }, model) {
  if (!Array.isArray(limitIds) || !limitScopes || model == null) return limitIds ?? null;
  return limitIds.filter(id => !Object.hasOwn(limitScopes, id) || modelMatches(model, limitScopes[id].models));
}

/** Strict schema-v1 parse; throws `plans: <path>: <reason>` on the first violation. */
export function parsePlans(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { fail('(root)', `not JSON: ${e.message}`); }
  obj(doc, '(root)', ['schemaVersion', 'decision', 'lead', 'providers']);
  if (doc.schemaVersion !== 1) fail('schemaVersion', 'expected 1');
  const d = obj(doc.decision, 'decision', ['headroomFactor', 'minLearnedSamples', 'costHistory', 'readingMaxAgeMins']);
  num(d.headroomFactor, 'decision.headroomFactor', 1);
  posInt(d.minLearnedSamples, 'decision.minLearnedSamples');
  posInt(d.costHistory, 'decision.costHistory');
  posInt(d.readingMaxAgeMins, 'decision.readingMaxAgeMins');
  const providers = obj(doc.providers, 'providers', Object.keys(doc.providers ?? {}));
  if (!Object.keys(providers).length) fail('providers', 'expected at least one provider');
  for (const [name, v] of Object.entries(providers)) checkProvider(v, `providers.${name}`);
  const lead = obj(doc.lead, 'lead', ['provider', 'snapshotFile', 'throttle']);
  if (!Object.hasOwn(providers, lead.provider)) fail('lead.provider', 'expected a key of providers');
  str(lead.snapshotFile, 'lead.snapshotFile');
  const t = obj(lead.throttle, 'lead.throttle', ['leanBelowPercent', 'closeBelowPercent']);
  num(t.leanBelowPercent, 'lead.throttle.leanBelowPercent', 0, 100);
  num(t.closeBelowPercent, 'lead.throttle.closeBelowPercent', 0, 100);
  return doc;
}

// The readRegular idiom of tree-read.mjs, synchronous so callers can keep reading caps synchronously.
function readRegularSync(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${file}`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function loadFrom(file, source) {
  let text;
  try { text = readRegularSync(file); } catch (e) {
    throw Object.assign(new Error(`plans: cannot read ${file}: ${e.code ?? e.message}`), { code: e.code });
  }
  try { return { plans: parsePlans(text), source }; } catch (e) { throw new Error(`${e.message} (in ${file})`); }
}

/**
 * ORCHESTRA_PLANS → ~/.config/agent-rules/provider-plans.json → the shipped example. Only an absent
 * global file falls through; a file that exists and cannot be read or parsed (a symlink included) throws.
 */
export function loadPlans({ env = process.env, home = homedir() } = {}) {
  if (env.ORCHESTRA_PLANS) return loadFrom(env.ORCHESTRA_PLANS, 'env');
  const global = path.join(home, '.config', 'agent-rules', 'provider-plans.json');
  try {
    return loadFrom(global, 'global');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return loadFrom(EXAMPLE_PLANS, 'example');
}

/** Counter providers stop at 100 - reserve; token/ms providers have no percent cap (null). */
export function stopAtPercentFor(plans, provider) {
  const p = Object.hasOwn(plans.providers, provider) ? plans.providers[provider] : fail(`providers.${provider}`, 'unknown provider');
  // Q17: every non-claude counter pool caps at 100 - reserve, even when `onUnknown` is `until-stop` -
  // the cap binds on a readable counter; the until-stop half (what happens with no reading) is
  // gateFor/quota's, not this number's. Deliberately not "counter pools WITH a reader": a counter
  // without a reader (or without limitIds, muse/cline today) simply never has a reading, so its cap
  // never binds - the number is harmless and starts working the day a reader returns one.
  // Claude is the one exception until Q13 wires its lead snapshot, so `--budget` councils keep
  // @claude on an unreadable counter (Q5 lead decision): it caps only when it must refuse.
  if (provider === 'claude') return p.meteredBy === 'counter' && p.onUnknown === 'refuse' ? 100 - p.reservePercent : null;
  return p.meteredBy === 'counter' ? 100 - p.reservePercent : null;
}
