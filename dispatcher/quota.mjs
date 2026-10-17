// Quota math, part 1 (Q11a): how much of each provider window is used, how big the window is, and
// how much room is left before our reserve. PURE: every input is handed in (parsePlans output, tree
// nodes, nowMs) — no file, no spawn, no clock. Unknown is a value here (null), never room: a number
// this module cannot back with a reading, a calibration or a declaration is not printed.

import { providerForNode, stopProviderForNode, latestReading, latestProviderStop, providerStopActive } from './tree-read.mjs';
import { headroomOf } from './usage.mjs';

const KIND_MINS = { '5h': 300, weekly: 10080 };
const MIN_MS = 60_000;

const providerOf = (plans, provider) => {
  if (!Object.hasOwn(plans.providers, provider)) throw new Error(`plans: providers.${provider}: unknown provider`);
  return plans.providers[provider];
};
const clockOf = nowMs => {
  if (!Number.isFinite(nowMs)) throw new Error('quota: nowMs must be a finite epoch ms');
  return nowMs;
};
const msOf = iso => (typeof iso === 'string' ? Date.parse(iso) : NaN);
/** Nodes attributed to the same billing pool as `provider` (pool, not role, decides). */
const poolNodes = (plans, nodes, provider) => {
  const pool = providerOf(plans, provider).pool;
  return (nodes ?? []).filter(n => {
    const p = n && typeof n === 'object' ? providerForNode(n) : null;
    return p != null && Object.hasOwn(plans.providers, p) && plans.providers[p].pool === pool;
  });
};

/** Metered tokens of one run: the recorded total, else the provider's size prior (no size ⇒ L);
 * null when neither exists — the caller counts it as unmeasured, never as 0. */
export function meteredOf(node, plans) {
  if (Number.isFinite(node?.tokens?.metered)) return node.tokens.metered;
  const p = providerForNode(node);
  if (p == null || !Object.hasOwn(plans.providers, p)) return null;
  return plans.providers[p].priorTokens?.[node.size ?? 'L'] ?? null;
}

/** Σ meteredOf over the nodes recorded in (fromMs, toMs]. */
function burned(plans, nodes, fromMs, toMs) {
  let tokens = 0;
  let unmeasured = 0;
  for (const n of nodes) {
    const t = msOf(n.recordedAt);
    if (!(t > fromMs && t <= toMs)) continue;
    const m = meteredOf(n, plans);
    if (m == null) unmeasured += 1;
    else tokens += m;
  }
  return { tokens, unmeasured };
}

/** Provider-declared stops of the pool with a datable kind: reset ≤ 5h after the stop ⇒ '5h'. A stop
 * without a parseable resetsAt (or one not after its own recordedAt) has no kind and is skipped. */
function stopsOfKind(nodes, kind) {
  const out = [];
  nodes.forEach((n, index) => {
    if (!n.providerStop || typeof n.providerStop !== 'object') return;
    if (n.providerStop.provider !== stopProviderForNode(n)) return; // a stop tagged for another pool
    const atMs = msOf(n.recordedAt);
    const resetMs = msOf(n.providerStop.resetsAt);
    if (!Number.isFinite(atMs) || !(resetMs > atMs)) return;
    if ((resetMs - atMs <= KIND_MINS['5h'] * MIN_MS ? '5h' : 'weekly') === kind) out.push({ atMs, resetMs, index });
  });
  return out;
}

/** The newest ok reading's fullest scoped window of one kind (null if none, or any is unreadable). */
function counterWindow(plans, nodes, provider, kind, nowMs) {
  const p = providerOf(plans, provider);
  const reading = latestReading(nodes ?? [], provider, nowMs, p.limitIds);
  const ofKind = (reading?.report.windows ?? []).filter(w => w?.windowDurationMins === KIND_MINS[kind]);
  return { window: headroomOf(ofKind, p.limitIds, 0).window, readAt: reading?.recordedAt ?? null };
}

/** Q12f: whether a counter reading recorded at `readAt` is still young enough to decide on —
 * within decision.readingMaxAgeMins. The one age rule: windowUsage applies it per window, and
 * dispatch's sized --role auto refreshes a reading it fails (or one already expired). */
export function readingFresh(plans, readAt, nowMs) {
  const readMs = msOf(readAt);
  return Number.isFinite(readMs) && nowMs - readMs <= plans.decision.readingMaxAgeMins * MIN_MS;
}

/**
 * Use of one window kind. Counter providers: the newest ok reading's scoped window of that kind,
 * `fresh` only when it was read within decision.readingMaxAgeMins AND its resetsAt is still ahead —
 * an undatable reset is NOT fresh (stricter than latestReading's "undatable ⇒ not expired"); stale ⇒
 * usedPercent null. Token (and ms) providers: Σ metered tokens of the pool since the window start,
 * the later of the latest known reset of that kind (provider stops, ≤ nowMs) and nowMs − duration.
 */
export function windowUsage(plans, nodes, provider, kind, nowMs) {
  clockOf(nowMs);
  const p = providerOf(plans, provider);
  const mins = KIND_MINS[kind];
  if (p.meteredBy === 'counter') {
    const { window, readAt } = counterWindow(plans, nodes, provider, kind, nowMs);
    const fresh = window != null && readingFresh(plans, readAt, nowMs) && msOf(window.resetsAt) > nowMs;
    return { usedPercent: fresh ? window.usedPercent : null, source: 'counter', readAt, fresh };
  }
  const pool = poolNodes(plans, nodes, provider);
  let startMs = nowMs - mins * MIN_MS;
  for (const s of stopsOfKind(pool, kind)) if (s.resetMs <= nowMs && s.resetMs > startMs) startMs = s.resetMs;
  const { tokens, unmeasured } = burned(plans, pool, startMs, nowMs);
  return { usedTokens: tokens, unmeasured, source: 'tokens', windowStart: new Date(startMs).toISOString() };
}

/**
 * Size of one window. Counter: 100 (percent). Tokens: the MIN, over the newest decision.costHistory
 * provider stops of that kind, of the tokens the pool burned in the window before each stop; else the
 * declared capacity when its unit is tokens; else null. Never an invented number.
 */
export function capacityFor(plans, nodes, provider, kind) {
  const p = providerOf(plans, provider);
  if (p.meteredBy === 'counter') return 100;
  const pool = poolNodes(plans, nodes, provider);
  const span = KIND_MINS[kind] * MIN_MS;
  // spec: decision.calibrationSamples (not in schema v1) — costHistory is the existing newest-N bound.
  const samples = stopsOfKind(pool, kind)
    .sort((a, b) => b.atMs - a.atMs || b.index - a.index)
    .slice(0, plans.decision.costHistory)
    .map(s => burned(plans, pool, s.atMs - span, s.atMs).tokens)
    // A window that measured 0 tokens (every node unmeasured) is no sample: capacity 0 would block forever.
    .filter(t => t > 0);
  if (samples.length) return Math.min(...samples);
  const declared = p.windows.find(w => w.kind === kind)?.capacity;
  return declared?.unit === 'tokens' ? declared.value : null;
}

/**
 * Room before our reserve, per declared window: cap·(100 − reserve)/100 − used, in percent (counter)
 * or tokens; `unknown` (headroom null) when any input is — an unmeasured run in a token window included. `min` is the route's headroom — the smallest
 * window — and is unknown when any window is.
 */
export function headroomFor(plans, nodes, provider, nowMs) {
  clockOf(nowMs);
  const p = providerOf(plans, provider);
  const unit = p.meteredBy === 'counter' ? 'percent' : 'tokens';
  const windows = p.windows.map(({ kind }) => {
    const cap = capacityFor(plans, nodes, provider, kind);
    const u = windowUsage(plans, nodes, provider, kind, nowMs);
    // An unmeasured run is unknown use, not zero: leaving it out would print room we cannot back.
    const used = unit === 'percent' ? u.usedPercent : u.unmeasured > 0 ? null : u.usedTokens;
    const headroom = cap != null && used != null ? (cap * (100 - p.reservePercent)) / 100 - used : null;
    return { kind, headroom, unit, unknown: headroom == null };
  });
  const min = !windows.length || windows.some(w => w.unknown)
    ? { kind: null, headroom: null, unit, unknown: true }
    : windows.reduce((a, b) => (b.headroom < a.headroom ? b : a));
  return { windows, min };
}

// ---------------------------------------------------------------------------------------------
// Part 2 (Q11b): what a run of a given size will cost, and which route (if any) can afford it.
// ---------------------------------------------------------------------------------------------
const SIZE_RANK = { S: 0, M: 1, L: 2 };
const sizeOf = size => {
  if (!Object.hasOwn(SIZE_RANK, size)) throw new Error(`quota: size must be S|M|L, got ${String(size)}`);
  return size;
};
const fitsSize = (size, cap) => cap == null || SIZE_RANK[size] <= SIZE_RANK[cap]; // null = no cap
/** Newest first by recordedAt, the later line winning a tie (capacityFor's order). */
const newestFirst = list => list
  .map((n, index) => ({ n, atMs: msOf(n.recordedAt), index }))
  .sort((a, b) => (b.atMs || 0) - (a.atMs || 0) || b.index - a.index)
  .map(x => x.n);
const endedOk = n => n.exitCode === 0 && n.blocked !== true && !n.providerStop;
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** %-per-token of one counter window kind, pooled over the pool's runs carrying both a Q6 delta of
 * that kind (scoped to the plan limitIds; the largest if several) and metered tokens. */
function percentPerToken(plans, nodes, provider, kind) {
  const p = providerOf(plans, provider);
  let percent = 0;
  let tokens = 0;
  for (const n of poolNodes(plans, nodes, provider)) {
    if (!Number.isFinite(n.tokens?.metered) || !Array.isArray(n.usageDeltas)) continue;
    const ds = n.usageDeltas.filter(d => d?.windowDurationMins === KIND_MINS[kind]
      && (p.limitIds == null || p.limitIds.includes(d.limitId)) && Number.isFinite(d.percentDelta));
    if (!ds.length) continue;
    percent += Math.max(...ds.map(d => d.percentDelta));
    tokens += n.tokens.metered;
  }
  return tokens > 0 ? percent / tokens : null;
}

/**
 * Cost of one run of `size` on `provider`. History = the newest decision.costHistory measured runs of
 * the pool at that size that ended ok; with ≥ decision.minLearnedSamples the median of them, else
 * max(prior, worst seen). A prior is no sample (an unmeasured run teaches nothing). Counter providers
 * also get `percent` per window kind: tokens × the pooled %-per-token ratio (null when none is learned).
 */
export function estimateFor(plans, nodes, provider, size) {
  sizeOf(size);
  const p = providerOf(plans, provider);
  const seen = newestFirst(poolNodes(plans, nodes, provider)
    .filter(n => n.size === size && endedOk(n) && Number.isFinite(n.tokens?.metered)))
    .slice(0, plans.decision.costHistory)
    .map(n => n.tokens.metered);
  const prior = p.priorTokens?.[size] ?? null;
  let est;
  if (seen.length >= plans.decision.minLearnedSamples) est = { tokens: median(seen), source: 'learned' };
  else {
    const worst = seen.length ? Math.max(...seen) : null;
    est = worst != null && (prior == null || worst > prior) ? { tokens: worst, source: 'worst-seen' }
      : prior != null ? { tokens: prior, source: 'prior' } : { tokens: null, source: 'unknown' };
  }
  if (p.meteredBy !== 'counter') return est;
  const percent = {};
  for (const { kind } of p.windows) {
    const ratio = percentPerToken(plans, nodes, provider, kind);
    percent[kind] = est.tokens != null && ratio != null ? est.tokens * ratio : null;
  }
  return { ...est, percent };
}

/** Per declared window at `atMs` ≥ nowMs: headroom (null = unknown) and its cap. Counter windows are
 * read as of nowMs (a reading does not age into room) except that a window whose known reset falls in
 * (nowMs, atMs] is taken as empty; token windows are recomputed at atMs (stops reset, runs roll off). */
function windowsAt(plans, nodes, provider, nowMs, atMs) {
  const p = providerOf(plans, provider);
  const counter = p.meteredBy === 'counter';
  return headroomFor(plans, nodes, provider, counter ? nowMs : atMs).windows.map(w => {
    const cap = capacityFor(plans, nodes, provider, w.kind);
    if (counter && atMs > nowMs) {
      const resetMs = msOf(counterWindow(plans, nodes, provider, w.kind, nowMs).window?.resetsAt);
      if (resetMs > nowMs && resetMs <= atMs) return { ...w, cap, headroom: (cap * (100 - p.reservePercent)) / 100 };
    }
    return { ...w, cap };
  });
}

/** Whether `route` can take a run of `size` at `atMs`: `{ ok, slack }` or `{ why }`. */
function check(plans, nodes, route, size, nowMs, atMs) {
  if (route.status !== 'ok') return { why: 'status' };
  const p = providerOf(plans, route.provider);
  const pool = poolNodes(plans, nodes, route.provider);
  const stopPool = pool.map(stopProviderForNode).find(Boolean) ?? null;
  if (providerStopActive(latestProviderStop(pool, stopPool)?.providerStop, atMs)) return { why: 'provider-stop' };
  if (!fitsSize(size, p.maxSize)) return { why: 'size' };
  // The route's last run (stop-bearing runs excluded: their reset governs them) ended blocked, and no
  // later ok run of the provider has cleared it.
  for (const n of newestFirst(pool)) {
    if (providerForNode(n) !== route.provider || n.providerStop) continue;
    if (endedOk(n)) break;
    if (n.role === route.role) {
      if (n.blocked === true) return { why: 'blocked' };
      break;
    }
  }
  const factor = plans.decision.headroomFactor;
  const est = estimateFor(plans, nodes, route.provider, size);
  let slack = Infinity;
  let unknown = false;
  for (const w of windowsAt(plans, nodes, route.provider, nowMs, atMs)) {
    const e = w.unit === 'percent' ? est.percent?.[w.kind] ?? null : est.tokens;
    if (w.headroom == null || e == null) { unknown = true; continue; }
    if (w.headroom < factor * e) return { why: 'headroom' };
    slack = Math.min(slack, (w.headroom - factor * e) / w.cap);
  }
  if (!unknown) return { ok: true, slack };
  if (p.onUnknown !== 'until-stop' || !fitsSize(size, p.uncalibratedMaxSize)) return { why: 'unknown' };
  return { ok: true, slack: -Infinity }; // in on unknown windows: below any route with known room
}

const better = (a, b) => (a.route.aa ?? -Infinity) - (b.route.aa ?? -Infinity)
  || a.slack - b.slack || b.route.rotationIndex - a.route.rotationIndex;

/** One pick at `atMs`: the best main-rotation route, else (size S only) the first overflow route. */
function pickAt(plans, nodes, routes, size, nowMs, atMs) {
  const evals = new Map();
  let best = null;
  for (const r of routes) {
    if (providerOf(plans, r.provider).overflow || !Number.isFinite(r.rotationIndex)) continue;
    const c = check(plans, nodes, r, size, nowMs, atMs);
    evals.set(r, c);
    if (c.ok && (best == null || better({ route: r, slack: c.slack }, best) > 0)) best = { route: r, slack: c.slack };
  }
  const overflowTried = best == null && size === 'S';
  if (overflowTried) {
    for (const r of routes) {
      if (!providerOf(plans, r.provider).overflow) continue;
      const c = check(plans, nodes, r, size, nowMs, atMs);
      evals.set(r, c);
      if (c.ok && best == null) best = { route: r, slack: c.slack };
    }
  }
  return { route: best?.route ?? null, evals, overflowTried };
}

/** Reset times after nowMs that could change a verdict: provider stops and counter windows. */
function resetTimes(plans, nodes, routes, nowMs) {
  const times = new Set();
  for (const r of routes) {
    const p = providerOf(plans, r.provider);
    const pool = poolNodes(plans, nodes, r.provider);
    const stop = latestProviderStop(pool, pool.map(stopProviderForNode).find(Boolean) ?? null)?.providerStop;
    times.add(msOf(stop?.resetsAt));
    if (p.meteredBy === 'counter') {
      for (const { kind } of p.windows) times.add(msOf(counterWindow(plans, nodes, r.provider, kind, nowMs).window?.resetsAt));
    }
  }
  // ponytail: a rolling token window frees as runs age out, not at a reset — not a candidate time;
  // add roll-off times (recordedAt + window) if waits on token pools prove too pessimistic.
  return [...times].filter(t => t > nowMs).sort((a, b) => a - b);
}

/**
 * The routing verdict for one task of `size`. `routes`: the dispatcher's ranked candidates, each
 * `{ role, provider, aa, rotationIndex, status }` (rotationIndex null = not in the rotation).
 * run (best eligible main route, else overflow for S) ⇒ split (a smaller size would run) ⇒ wait
 * until the earliest reset that makes some route eligible ⇒ wait with no time (unknown). `reasons`
 * holds one `{ role, why }` per route not chosen, in input order.
 */
export function decide(plans, nodes, routes, { size, nowMs } = {}) {
  clockOf(nowMs);
  sizeOf(size);
  const { route, evals, overflowTried } = pickAt(plans, nodes, routes, size, nowMs, nowMs);
  const reasons = routes.filter(r => r !== route).map(r => {
    const c = evals.get(r);
    const why = c ? (c.ok ? 'outranked' : c.why)
      : providerOf(plans, r.provider).overflow && !overflowTried ? 'overflow' : 'not-in-rotation';
    return { role: r.role, why };
  });
  if (route) return { action: 'run', route, reasons };
  for (const smaller of Object.keys(SIZE_RANK).filter(s => SIZE_RANK[s] < SIZE_RANK[size])) {
    if (pickAt(plans, nodes, routes, smaller, nowMs, nowMs).route) return { action: 'split', reasons };
  }
  for (const t of resetTimes(plans, nodes, routes, nowMs)) {
    if (pickAt(plans, nodes, routes, size, nowMs, t).route) return { action: 'wait', until: new Date(t).toISOString(), reasons };
  }
  return { action: 'wait', until: null, reason: 'unknown', reasons };
}
