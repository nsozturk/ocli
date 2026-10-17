#!/usr/bin/env node
// Read each developer CLI's remaining allowance, so dispatch can route by measured burn instead of
// guesswork. Usage: node dispatcher/usage.mjs [--json]
//
// The point of this file is that every number it prints was OBSERVED. Where a provider exposes no
// source, it says `unknown` and why — it never estimates a percentage and presents it as read.

import { spawn } from 'node:child_process';
import { loadPlans, stopAtPercentFor } from './plans.mjs';

const WEEK_MINS = 10080;
const FIVE_HOUR_MINS = 300;

/**
 * codex speaks JSON-RPC over stdio via `codex app-server`. `account/rateLimits/read` returns a
 * RateLimitSnapshot per limit id: {primary, secondary} windows of
 * {usedPercent:int, resetsAt:unix-seconds, windowDurationMins}.
 *
 * A fresh app-server per call is deliberate: two calls per dispatch is nothing, and a long-lived
 * daemon would be one more thing to own and leak.
 */
export async function readCodexUsage({ timeoutMs = 60_000 } = {}) {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  let failure = null;
  const fail = error => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.on('close', () => fail(new Error('codex app-server closed before usage read completed')));
  child.stdin.on('error', fail);
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const timer = setTimeout(() => fail(new Error('codex usage read timed out')), timeoutMs);
  try {
    const init = await call('initialize', {
      clientInfo: { name: 'ocli-usage', title: 'ocli usage reader', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    if (init.error) return { status: 'unavailable', reason: `initialize failed: ${JSON.stringify(init.error)}`, windows: [] };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const response = await call('account/rateLimits/read', { excludeResetCreditDetails: true });
    if (response.error) return { status: 'unavailable', reason: JSON.stringify(response.error), windows: [] };
    const byId = response.result?.rateLimitsByLimitId ?? {};
    const windows = [];
    for (const [limitId, snapshot] of Object.entries(byId)) {
      for (const which of ['primary', 'secondary']) {
        const window = snapshot?.[which];
        if (!window) continue;
        windows.push({
          limitId,
          model: snapshot.normalModelSlug ?? snapshot.limitName ?? null,
          usedPercent: window.usedPercent,
          windowDurationMins: window.windowDurationMins ?? null,
          resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
        });
      }
    }
    return { status: 'ok', ordinaryUsageAllowed: response.result?.ordinaryUsageAllowed ?? null, windows };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/**
 * Claude Code exposes plan limits only through the `get_usage` MCP tool, which lives in the lead's
 * session and not in this process: `claude --help` has no usage flag and nothing on disk carries the
 * percentages. So the lead reads it and writes the snapshot in, exactly as it hand-records the tree
 * node for an Agent-tool developer.
 *
 * CAVEAT the caller must carry: this account number covers the LEAD as well as any Opus subagent, so
 * a before/after pair around a subagent slice is only clean while the lead sits idle waiting on it.
 */
export function claudeUsageFromLead(snapshot) {
  if (!snapshot) {
    return {
      status: 'unknown',
      reason: 'no lead-supplied snapshot; read it with the get_usage MCP tool and pass it in',
      windows: [],
    };
  }
  return {
    status: 'ok',
    attribution: 'account-wide: includes the lead session, not only the subagent',
    windows: (snapshot.windows ?? []).map(w => ({
      limitId: w.label,
      model: null,
      usedPercent: w.percentUsed,
      windowDurationMins: /5-hour/i.test(w.label) ? FIVE_HOUR_MINS : /week/i.test(w.label) ? WEEK_MINS : null,
      resetsAt: w.resetsAt ?? null,
    })),
  };
}

/**
 * GLM-5.3 runs on a zai-coding-plan subscription. `opencode stats` reports LOCAL token and cost
 * accounting, which is a different quantity from the plan's remaining allowance — reporting it as a
 * percentage would be inventing a number. Until a real source is found this stays `unknown`.
 */
export async function readGlmUsage() {
  return {
    status: 'unknown',
    reason: 'zai-coding-plan exposes no verified local quota source; `opencode stats` is local token/cost accounting, not plan allowance',
    windows: [],
  };
}

/**
 * The window a cap binds on: a 5-hour window when there is one, otherwise the weekly one. Among
 * equals, the fullest window wins — that is the one that stops work.
 *
 * `limitIds` matters more than it looks. codex reports a separate limit per pool, and one pool can be
 * nearly spent while the pool a route actually draws on is almost empty. Folding them together would
 * stop a developer with most of its week left. A quota only binds on the pool the route consumes.
 */
export function bindingWindow(windows, limitIds = null) {
  const scoped = limitIds ? windows.filter(w => limitIds.includes(w.limitId)) : windows;
  if (!scoped.length) return null;
  const fiveHour = scoped.filter(w => w.windowDurationMins === FIVE_HOUR_MINS);
  const pool = fiveHour.length ? fiveHour : scoped;
  return pool.reduce((worst, w) => (w.usedPercent > worst.usedPercent ? w : worst), pool[0]);
}

/** Which limit pool each configured route draws on. Anything unlisted is reported, never bound on. */
export const ROUTE_LIMIT_IDS = {
  codex: ['codex'],
  claude: ['5-hour limit', 'Weekly · all models'],
};

/**
 * Spending caps, derived from the provider plans (plans.mjs: ORCHESTRA_PLANS, else
 * ~/.config/agent-rules/provider-plans.json, else the shipped provider-plans.example.json): a counter
 * pool that refuses when unread stops at 100 − reservePercent on its limitIds; every other pool runs
 * until the provider itself stops it. A cap is a decision, not a measurement: `stopAtPercent` says
 * when to stop using a developer, independent of how fast it is burning.
 *
 * `null` means deliberately uncapped. Uncapped is not "unknown": `gateFor` returns `ok` for it without
 * needing a reading, which is why a provider with no readable percentage does not block dispatch.
 *
 * Loaded once per process, for the BUDGETED developers only. A plans file that cannot be read or
 * parsed, or omits one of them, leaves NO row and sets plansError(): every budgeted developer then
 * gates `unknown` — no cap can be honoured, so none is room.
 */
// ponytail: gemini/cline/muse stay unmanaged here (no row, `no-budget`) until token pools are ranked;
// widening this list changes the gateSource recorded for them.
export const BUDGETED = ['codex', 'glm', 'claude'];
let loaded = null;
function load() {
  if (loaded) return loaded;
  try {
    const { plans, source } = loadPlans();
    if (source === 'example') {
      process.stderr.write('[usage] using the shipped example plans; create ~/.config/agent-rules/provider-plans.json\n');
    }
    const rows = {};
    for (const provider of BUDGETED) {
      const stopAtPercent = stopAtPercentFor(plans, provider); // throws on a plans file without it
      const p = plans.providers[provider];
      rows[provider] = stopAtPercent === null
        ? { stopAtPercent: null, note: `${p.plan}: runs until the provider stops it (metered by ${p.meteredBy}; no percent cap)` }
        : { stopAtPercent, limitIds: p.limitIds };
    }
    loaded = { rows, error: null };
  } catch (error) {
    process.stderr.write(`[usage] ${error.message}; every budgeted developer gates unknown until the plans file is fixed\n`);
    loaded = { rows: {}, error: error.message };
  }
  return loaded;
}

/** provider -> { stopAtPercent, limitIds } | { stopAtPercent: null, note }, from the plans. */
export const budget = () => load().rows;
/** The plans load error (a string), or null when the plans were read. */
export const plansError = () => load().error;

/**
 * Should this provider still be dispatched to? Returns one of:
 *   {state:'ok'}        — under the cap, or deliberately uncapped
 *   {state:'stop'}      — the cap is reached; the caller must not dispatch and must tell the user
 *   {state:'unknown'}   — capped but unreadable, so the cap cannot be honoured; escalate, never assume
 * A cap that cannot be read is NOT treated as room: a quota claim has to be checkable before it
 * changes what we do.
 */
export function gateFor(provider, report) {
  if (!BUDGETED.includes(provider)) return { state: 'ok', reason: 'no budget configured' };
  const error = plansError();
  if (error) return { state: 'unknown', reason: `no cap can be honoured: ${error}` };
  const budget = load().rows[provider];
  if (budget.stopAtPercent === null) return { state: 'ok', reason: budget.note ?? 'uncapped' };
  if (report?.status !== 'ok') {
    return { state: 'unknown', reason: `capped at ${budget.stopAtPercent}% but usage is ${report?.status ?? 'missing'}` };
  }
  const { window, headroomPercent } = headroomOf(report.windows ?? [], budget.limitIds ?? null, budget.stopAtPercent);
  if (!window) return { state: 'unknown', reason: 'no readable window (a number for every scoped window) in the pools this route consumes' };
  if (window.usedPercent >= budget.stopAtPercent) {
    return { state: 'stop', reason: `${window.limitId} at ${window.usedPercent}% has reached the ${budget.stopAtPercent}% cap`, window };
  }
  return { state: 'ok', reason: `${window.limitId} at ${window.usedPercent}% of a ${budget.stopAtPercent}% cap`, window, headroomPercent };
}

/**
 * Room left before the cap, measured on the FULLEST scoped window of any duration. Unlike
 * bindingWindow this has no 5-hour preference: a weekly window at the cap stops work even while the
 * 5-hour window has room (codex reports both under limitId 'codex'). bindingWindow keeps its
 * preference because usageDelta needs before/after bound on the same window.
 */
export function headroomOf(windows, limitIds, stopAtPercent) {
  const scoped = limitIds ? windows.filter(w => limitIds.includes(w.limitId)) : windows;
  if (!scoped.length) return { window: null, headroomPercent: null };
  // One unreadable scoped window means the fullest one cannot be known — it may be the one without a
  // number. Unknown, never the best of the readable rest.
  if (scoped.some(w => !Number.isFinite(w.usedPercent))) return { window: null, headroomPercent: null };
  const window = scoped.reduce((worst, w) => (w.usedPercent > worst.usedPercent ? w : worst));
  return { window, headroomPercent: stopAtPercent - window.usedPercent };
}

/** Observed percentage-point change, not a token estimate. Null means no comparable pair. */
export function usageDelta(before, after, provider, ms) {
  if (before?.status !== 'ok' || after?.status !== 'ok') return null;
  const limitIds = ROUTE_LIMIT_IDS[provider];
  if (!limitIds || !Array.isArray(before.windows) || !Array.isArray(after.windows)) return null;
  const first = bindingWindow(before.windows, limitIds);
  const last = bindingWindow(after.windows, limitIds);
  if (!first || !last || first.limitId !== last.limitId) return null;
  // A new/reset window is not a measurement of this dispatch's burn.
  if (first.windowDurationMins !== last.windowDurationMins || first.resetsAt !== last.resetsAt) return null;
  if (!Number.isInteger(first.usedPercent) || !Number.isInteger(last.usedPercent)) return null;
  const percentDelta = last.usedPercent - first.usedPercent;
  if (percentDelta < 0 || !Number.isFinite(ms) || ms <= 0) return null;
  const minutes = ms / 60_000;
  return { limitId: first.limitId, percentDelta, windowDurationMins: first.windowDurationMins,
    minutes, percentPerHour: percentDelta * 60 / minutes };
}

/**
 * Q6: usageDelta's rules applied to EVERY scoped window kind (limitId + windowDurationMins), so the
 * 5-hour and weekly codex windows each get their own delta instead of one binding window. A window
 * that reset, decreased, is non-integer or is missing from `after` gives no entry — for itself only.
 * [] when the pair is not comparable at all (status, provider, elapsed time).
 */
export function usageDeltas(before, after, provider, ms) {
  if (before?.status !== 'ok' || after?.status !== 'ok') return [];
  const limitIds = ROUTE_LIMIT_IDS[provider];
  if (!limitIds || !Array.isArray(before.windows) || !Array.isArray(after.windows)) return [];
  if (!Number.isFinite(ms) || ms <= 0) return [];
  const minutes = ms / 60_000;
  const out = [];
  // ponytail: one entry per before-window; a reading with two windows of one kind (same limitId and
  // duration, never seen in captured shapes) would emit two, both matched to the first after-window.
  for (const first of before.windows) {
    if (!limitIds.includes(first.limitId)) continue;
    const last = after.windows.find(w => w.limitId === first.limitId && w.windowDurationMins === first.windowDurationMins);
    if (!last || first.resetsAt !== last.resetsAt) continue;
    if (!Number.isInteger(first.usedPercent) || !Number.isInteger(last.usedPercent)) continue;
    const percentDelta = last.usedPercent - first.usedPercent;
    if (percentDelta < 0) continue;
    out.push({ limitId: first.limitId, windowDurationMins: first.windowDurationMins, percentDelta,
      minutes, percentPerHour: percentDelta * 60 / minutes });
  }
  return out;
}

function formatWindow(w) {
  const label = w.windowDurationMins === FIVE_HOUR_MINS ? '5-hour'
    : w.windowDurationMins === WEEK_MINS ? 'weekly'
    : w.windowDurationMins ? `${w.windowDurationMins}min` : 'unknown-window';
  const resets = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : 'unknown';
  return `${String(w.limitId).padEnd(24)} ${label.padEnd(8)} ${String(w.usedPercent).padStart(3)}% used   resets ${resets}${w.model ? `   (${w.model})` : ''}`;
}

export async function readAll({ claudeSnapshot } = {}) {
  const [codex, glm] = await Promise.all([
    readCodexUsage().catch(error => ({ status: 'unavailable', reason: String(error), windows: [] })),
    readGlmUsage(),
  ]);
  return { codex, claude: claudeUsageFromLead(claudeSnapshot), glm, readAt: new Date().toISOString() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await readAll();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
  } else {
    for (const [name, report] of Object.entries(all)) {
      if (name === 'readAt') continue;
      process.stdout.write(`\n${name.toUpperCase()}  [${report.status}]\n`);
      if (report.reason) process.stdout.write(`  ${report.reason}\n`);
      for (const w of report.windows) process.stdout.write(`  ${formatWindow(w)}\n`);
      const binding = bindingWindow(report.windows, ROUTE_LIMIT_IDS[name] ?? null);
      if (binding) process.stdout.write(`  -> binds on: ${binding.limitId} at ${binding.usedPercent}% (${100 - binding.usedPercent}% left)\n`);
      const ignored = report.windows.filter(w => ROUTE_LIMIT_IDS[name] && !ROUTE_LIMIT_IDS[name].includes(w.limitId));
      for (const w of ignored) {
        process.stdout.write(`  -> NOT bound on ${w.limitId} (${w.usedPercent}%) — no configured route draws on it${w.model ? `; that pool is ${w.model}` : ''}\n`);
      }
      const gate = gateFor(name, report);
      const mark = gate.state === 'ok' ? 'DISPATCH OK' : gate.state === 'stop' ? 'STOP — CAP REACHED' : 'UNKNOWN — DO NOT ASSUME ROOM';
      process.stdout.write(`  -> ${mark}: ${gate.reason}${gate.headroomPercent !== undefined ? ` (${gate.headroomPercent}% headroom)` : ''}\n`);
    }
    process.stdout.write('\n');
  }
  process.exit(0);
}
