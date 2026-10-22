// Quota cards, part A: the latest usage reading per provider, kept where the pane can read it —
// <live root>/usage/latest.json. One writer for both callers (usage.mjs runUsageCli, dispatch.mjs).
//
// Schema v1 (docs/specs/quota-cards.md): { v, writtenAt, providers: { <provider>: { readAt, status, source,
// reason, windows, gate, routes?, stop, setup } } }. Every entry is REBUILT field by field — nothing a reader
// returns beside the schema is copied — and every string field goes through text() (scrub, then cap) at
// write time, so identity and secrets never reach a file the pane (and anyone with the live dir) can read.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gateFor, budget } from './usage.mjs';
import { setupHint, claudeConsentGiven } from './usage-readers/doctor.mjs';
import { providerForNode, readNodes, latestProviderStop, providerStopActive, STOP_POOL } from './tree-read.mjs';

// ORCHESTRA_LIVE_DIR / ORCHESTRA_TREE_DIR (read per call, so tests can point them at temp dirs) move the roots.
export const liveRoot = () => (process.env.ORCHESTRA_LIVE_DIR ? path.resolve(process.env.ORCHESTRA_LIVE_DIR) : path.resolve('orchestra', 'live'));
export const treeRoot = () => process.env.ORCHESTRA_TREE_DIR
  ? path.resolve(process.env.ORCHESTRA_TREE_DIR) : path.resolve('orchestra', 'tree');
export const snapshotFile = dir => path.join(dir, 'usage', 'latest.json');

const isTestProcess = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
const PROVIDERS = ['codex', 'claude', 'glm', 'gemini', 'muse', 'cline'];
const STATUSES = ['ok', 'unknown', 'unavailable'];
const REASON_MAX = 200;

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME = homedir();
const SCRUBS = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\beyJ[\w-]{6,}(?:\.[\w-]+)*/g, '[secret]'],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][\w-]{8,}/g, '[secret]'],
  [/\b(Bearer|Basic)\s+\S+/gi, '$1 [secret]'],
  // Mixed case + digit, 24+ chars: a key or token. limitIds (lowercase) and ISO dates (colons) never match.
  [/\b(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{24,}\b/g, '[secret]'],
  ...(HOME && HOME !== '/' ? [[new RegExp(escape(HOME), 'g'), '~']] : []),
  [/\/(?:Users|home)\/[^/\s'"]+/g, '~'],
];
/** Emails, tokens and home paths out. Every string field goes through text(), which calls this before it caps. */
export function scrub(value) {
  if (typeof value !== 'string') return value;
  return SCRUBS.reduce((s, [re, to]) => s.replace(re, to), value);
}
const text = (v, max = REASON_MAX) => (typeof v === 'string' && v ? [...scrub(v)].slice(0, max).join('') : null);
const num = v => (Number.isFinite(v) ? v : null);

/** [{ role, model, provider }] for the policy's dispatchable routes (the scoped-bucket sub-rows). */
export function policyRoutes(policy) {
  return Object.entries(policy?.routes ?? {})
    .filter(([, r]) => r?.argv)
    .map(([role, r]) => ({ role, model: r.model, provider: providerForNode({ cli: r.cli, model: r.model }) }));
}

// gate.window: the window gateFor BOUND on (its scoped fullest), passed through — never re-derived here, so the
// pane's bold window and a gate STOP's `until` (window.resetsAt) are exactly the dispatcher's. null = no window.
const windowOf = w => (w ? { limitId: text(w.limitId, 80), windowDurationMins: num(w.windowDurationMins),
  usedPercent: num(w.usedPercent), resetsAt: text(w.resetsAt, 40) } : null);
const gateOf = g => ({ state: g.state, reason: text(g.reason), window: windowOf(g.window) });

function entry(provider, reading, { readAt, routes, nodes, nowMs, claudeConsent }) {
  const gate = gateFor(provider, reading);
  const out = {
    readAt,
    status: STATUSES.includes(reading?.status) ? reading.status : 'unknown',
    source: text(reading?.source, 60),
    reason: text(reading?.reason),
    windows: (Array.isArray(reading?.windows) ? reading.windows : []).map(w => ({
      limitId: text(w?.limitId, 80), usedPercent: num(w?.usedPercent),
      windowDurationMins: num(w?.windowDurationMins), resetsAt: text(w?.resetsAt, 40),
    })),
    gate: { state: gate.state, reason: text(gate.reason), headroomPercent: num(gate.headroomPercent), window: windowOf(gate.window) },
  };
  if (budget()[provider]?.limitScopes) {
    out.routes = routes.filter(r => r.provider === provider)
      .map(r => ({ role: text(r.role, 60), model: text(r.model, 80), gate: gateOf(gateFor(provider, reading, r.model)) }));
  }
  const found = latestProviderStop(nodes, STOP_POOL[provider] ?? null);
  out.stop = found && providerStopActive(found.providerStop, nowMs)
    ? { until: text(found.providerStop.resetsAt, 40), reason: text(found.providerStop.evidence) }
    : null;
  out.setup = text(setupHint(provider, reading, { claudeConsent })?.needs?.[0], 300);
  return out;
}

function previous(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc?.v === 1 && doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : {};
  } catch { return {}; }
}

/**
 * Merge `readings` ({ provider: reading }) into the snapshot and write it atomically (temp file in the same dir,
 * 0644, rename). Providers not in `readings` keep their entry and its readAt. `stop` comes from the tree at
 * `treeDir`. Never throws: { ok: true, file } or { ok: false, error }.
 * ponytail: read-merge-rename is not locked; two writers racing can drop one's providers until the next read.
 */
export async function writeUsageSnapshot({ dir, treeDir, readings = {}, routes = [],
  now = Date.now(), claudeConsent } = {}) {
  let tmp = null;
  try {
    // A test process never falls back to the cwd's real orchestra/live or orchestra/tree (like usage-readers'
    // config path): without an explicit dir or env override it writes nothing.
    if (isTestProcess() && ((!dir && !process.env.ORCHESTRA_LIVE_DIR) || (!treeDir && !process.env.ORCHESTRA_TREE_DIR))) {
      return { ok: false, error: 'test process without ORCHESTRA_LIVE_DIR / ORCHESTRA_TREE_DIR' };
    }
    // Same consent as runUsageCli (env or usage-readers.json); a test process never reads the real config file.
    claudeConsent ??= claudeConsentGiven(isTestProcess() && !process.env.OCLI_USAGE_READERS_CONFIG
      ? { configPath: '/nonexistent/ocli-test/usage-readers.json' } : {});
    dir ??= liveRoot();
    treeDir ??= treeRoot();
    const nowMs = typeof now === 'number' ? now : Date.now();
    const readAt = new Date(nowMs).toISOString();
    const { nodes } = await readNodes(treeDir);
    const file = snapshotFile(dir);
    const providers = previous(file);
    for (const [provider, reading] of Object.entries(readings ?? {})) {
      if (!PROVIDERS.includes(provider) || !reading) continue;
      providers[provider] = entry(provider, reading, { readAt, routes, nodes, nowMs, claudeConsent });
    }
    const doc = { v: 1, writtenAt: readAt, providers };
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o644 });
    chmodSync(tmp, 0o644); // umask-independent
    renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    if (tmp) try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    try { process.stderr.write(`[usage] snapshot not written: ${error?.code ?? error?.message ?? error}\n`); } catch { /* closed */ }
    return { ok: false, error: String(error?.message ?? error) };
  }
}
