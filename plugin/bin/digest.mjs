#!/usr/bin/env node
// The night digest: what the developer CLIs did since a time, per task and phase, from the recorded
// tree and the live run.end lines. Deterministic and read-only: it writes nothing, spawns nothing,
// and invents nothing. A run with no verifier verdict is UNSCORED, never a fail, and is never folded
// into a pass rate: the markdown says `pass 3/5 scored · 4 unscored`, not a percentage.
// Usage: node dispatcher/digest.mjs [--since <ISO>] [--json <any>] [--root <dir holding tree/ and live/>]
// The root defaults to <cwd>/orchestra; without --root, ORCHESTRA_LIVE_DIR moves the live dir as it
// does for the dispatcher.

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paneLabel } from './pane-label.mjs';

const WINDOW_MS = 12 * 3_600_000;

/** A regular file's text, opened with O_NOFOLLOW: a link (even one swapped in after a listing)
 * is refused, never followed. Rejects when the file cannot be read. */
export async function readRegular(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${file}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Every record in the tree's *.jsonl files. A link is never followed and a file that cannot be read
 * is counted (`unreadableFiles`), like a line that does not parse, instead of failing the read. */
export async function readNodes(treeDir) {
  const nodes = [];
  let unreadableLines = 0;
  let unreadableFiles = 0;
  let entries = [];
  try { entries = await readdir(treeDir, { withFileTypes: true }); } catch { return { nodes, unreadableLines, unreadableFiles }; }
  for (const name of entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort()) {
    let text;
    try { text = await readRegular(path.join(treeDir, name)); } catch { unreadableFiles += 1; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { nodes.push(JSON.parse(line)); } catch { unreadableLines += 1; }
    }
  }
  return { nodes, unreadableLines, unreadableFiles };
}
export const STATUSES = ['completed', 'failed', 'blocked', 'spawn-error', 'dispatch-error'];
const FAILED = new Set(['failed', 'spawn-error', 'dispatch-error']);

// Every string from the tree or a live file is untrusted: cleaned as dispatch cleans pane labels.
const label = (value, max) => paneLabel(value, max) || '?';
const time = value => (typeof value === 'string' ? Date.parse(value) : NaN);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// null + null stays null: a measurement nobody reported is unknown, never zero.
const add = (a, b) => (b === null ? a : (a ?? 0) + b);
const byStatus = () => Object.fromEntries(STATUSES.map(s => [s, 0]));
// Witness codes are untrusted keys: a plain {} would read 'constructor' as Object's own and drop '__proto__'.
const counts = () => Object.create(null);
const findingCodes = findings => (Array.isArray(findings) ? findings : [])
  .map(f => (typeof f === 'string' ? f : f?.code)).filter(code => typeof code === 'string').map(code => label(code, 40));

/**
 * `nodes` are tree nodes; `ends` live records of kind run.end (status, and runs with no node),
 * run.start (the phase of a run with no node) and usage (tokens), others ignored; `plans` [{ task, phases: [{ name }], declaredAt }].
 */
export function digest({ nodes = [], ends = [], plans = [], since = null, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const sinceMs = since == null ? nowMs - WINDOW_MS : time(since);
  if (!Number.isFinite(sinceMs)) throw new Error(`since is not a date: ${since}`);
  const totals = { tasks: 0, runs: 0, byStatus: byStatus(), scored: { pass: 0, fail: 0 }, unscored: 0, ms: null,
    tokens: { input: null, output: null }, witness: counts(), undated: 0, leadCorrections: 0, endsWithoutNode: 0 };

  const endOf = new Map();
  const tokensOf = new Map();
  const startPhase = new Map();
  for (const record of ends) {
    if (typeof record?.runId !== 'string') continue;
    if (record.kind === 'run.end') endOf.set(record.runId, record);
    else if (record.kind === 'run.start' && typeof record.phase === 'string') startPhase.set(record.runId, record.phase);
    else if (record.kind === 'usage') {
      const t = tokensOf.get(record.runId) ?? { input: null, output: null };
      tokensOf.set(record.runId, { input: add(t.input, num(record.input)), output: add(t.output, num(record.output)) });
    }
  }

  const runs = [];
  // Runs recorded before the window, as [task, phase]: not counted, but a phase that ran is done.
  const earlier = [];
  const recorded = new Set();
  for (const node of nodes) {
    if (typeof node?.runId === 'string') recorded.add(node.runId);
    // A lead-correction record is the lead annotating a node, not a run.
    if (node?.role === 'lead-correction') { totals.leadCorrections += 1; continue; }
    const at = time(node?.recordedAt);
    if (!Number.isFinite(at)) { totals.undated += 1; continue; }
    if (at < sinceMs) { earlier.push([label(node.task, 120), label(node.phase ?? node.role, 40)]); continue; }
    const end = typeof node.runId === 'string' ? endOf.get(node.runId) : undefined;
    const status = STATUSES.includes(end?.status) ? end.status
      : node.blocked === true ? 'blocked' : node.exitCode === 0 ? 'completed' : 'failed';
    runs.push({
      task: label(node.task, 120), phase: label(node.phase ?? node.role, 40), runId: node.runId ?? null, cli: label(node.cli, 40),
      status, score: node.score, ms: num(node.ms) ?? num(end?.ms), endMs: at, tokens: tokensOf.get(node.runId) ?? null,
      witness: findingCodes(node.witness?.findings), blockedCheck: status === 'blocked' ? label(node.blockedCheck, 160) : null,
    });
  }
  // A run.end with no node: a dispatcher that threw (dispatch-error) or a run killed by a signal. No
  // node holds its phase: its run.start does (as the pane's card reads it), else its role stands in.
  for (const end of endOf.values()) {
    if (recorded.has(end.runId)) continue;
    const at = time(end.at);
    if (!Number.isFinite(at)) { totals.undated += 1; continue; }
    const phase = label(startPhase.get(end.runId) ?? end.role, 40);
    if (at < sinceMs) { earlier.push([label(end.task, 120), phase]); continue; }
    totals.endsWithoutNode += 1;
    const status = STATUSES.includes(end.status) ? end.status : 'failed';
    runs.push({
      task: label(end.task, 120), phase, runId: end.runId, cli: label(end.cli, 40), status,
      score: end.score, ms: num(end.ms), endMs: at, tokens: tokensOf.get(end.runId) ?? null, witness: findingCodes(end.witness?.findings),
      blockedCheck: status === 'blocked' ? 'no tree node: the evidence was never recorded' : null,
    });
  }

  const tasks = new Map();
  const taskOf = name => {
    if (!tasks.has(name)) tasks.set(name, { task: name, declared: [], phases: new Map() });
    return tasks.get(name);
  };
  const phaseOf = (task, name, declared) => {
    if (!task.phases.has(name)) {
      task.phases.set(name, { name, declared, runs: 0, earlier: 0, byStatus: byStatus(), scored: { pass: 0, fail: 0 }, unscored: 0,
        ms: null, tokens: { input: null, output: null }, witness: counts() });
    }
    return task.phases.get(name);
  };
  // Declared phases come first, in the plan's order. A plan joins when it was declared in the window
  // or its task ran in it: a stale plan alone would flood the digest.
  const ran = new Set(runs.map(run => run.task));
  for (const plan of plans) {
    const name = label(plan?.task, 120);
    if (!(time(plan?.declaredAt) >= sinceMs) && !ran.has(name)) continue;
    const task = taskOf(name);
    for (const phase of Array.isArray(plan.phases) ? plan.phases : []) {
      const phaseName = paneLabel(phase?.name, 40);
      if (!phaseName || task.declared.includes(phaseName)) continue;
      task.declared.push(phaseName);
      phaseOf(task, phaseName, true);
    }
  }

  const decisions = [];
  for (const run of runs) {
    const phase = phaseOf(taskOf(run.task), run.phase, false);
    for (const into of [phase, totals]) {
      if (into === phase) into.runs += 1;
      into.byStatus[run.status] += 1;
      if (run.score === 1) into.scored.pass += 1;
      else if (run.score === 0) into.scored.fail += 1;
      else into.unscored += 1;
      into.ms = add(into.ms, run.ms);
      into.tokens = { input: add(into.tokens.input, run.tokens?.input ?? null), output: add(into.tokens.output, run.tokens?.output ?? null) };
      for (const code of run.witness) into.witness[code] = (into.witness[code] ?? 0) + 1;
    }
    const unscored = run.score !== 1 && run.score !== 0;
    if (run.status === 'blocked' || FAILED.has(run.status) || run.score === 0 || (unscored && run.witness.length)) {
      decisions.push({ task: run.task, phase: run.phase, runId: run.runId, cli: run.cli, status: run.status,
        score: unscored ? null : run.score, witness: run.witness, blockedCheck: run.blockedCheck });
    }
  }
  totals.runs = runs.length;
  // Only phases already in the digest: an earlier run alone neither adds a task nor a phase.
  for (const [task, phase] of earlier) {
    const into = tasks.get(task)?.phases.get(phase);
    if (into) into.earlier += 1;
  }
  // Wall time: the first run's start to the last run's end. Unknown when any run's length is.
  const wallOf = name => {
    const mine = runs.filter(run => run.task === name);
    if (!mine.length || mine.some(run => run.ms === null)) return null;
    return Math.max(...mine.map(run => run.endMs)) - Math.min(...mine.map(run => run.endMs - run.ms));
  };

  const list = [...tasks.values()].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0)).map(task => {
    const phases = [...task.phases.values()];
    // Done as the pane's card counts it: a phase with a run, and none still running (a node or a
    // run.end exists only once a run has ended), whether that run fell in the window or before it.
    return { task: task.task, phases, declared: task.declared, done: phases.filter(p => p.runs > 0 || p.earlier > 0).length,
      total: phases.length, runs: runs.filter(run => run.task === task.task).length, wallMs: wallOf(task.task) };
  });
  totals.tasks = list.length;
  return { since: new Date(sinceMs).toISOString(), tasks: list, decisions, totals };
}

// Markdown syntax in a label must not draw: no links (autolinks too: 'scheme:', 'www.', 'a@b'), html,
// entities, emphasis, strikethrough or code spans from a tree string. CommonMark unescapes each one.
const md = text => String(text).replace(/[\\`*_~[\]<>|&:@]/g, '\\$&').replace(/\b(www)\./gi, '$1\\.');

function duration(ms) {
  if (ms === null) return 'time unknown';
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`
    : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** Runs by status, scores, time, tokens and witness codes: one line's worth, never a percentage. */
function summary(p) {
  const statuses = STATUSES.filter(s => p.byStatus[s]).map(s => `${s} ${p.byStatus[s]}`).join(', ');
  const tokens = p.tokens.input === null && p.tokens.output === null ? 'tokens unreported'
    : `tokens ${p.tokens.input ?? '?'} in / ${p.tokens.output ?? '?'} out`;
  const witness = Object.entries(p.witness).map(([code, count]) => `${md(code)}×${count}`).join(', ');
  return [`${p.runs} run${p.runs === 1 ? '' : 's'} (${statuses})`,
    `pass ${p.scored.pass}/${p.scored.pass + p.scored.fail} scored · ${p.unscored} unscored`,
    p.ms === null ? 'run time unknown' : `run time ${duration(p.ms)} summed`, tokens, ...(witness ? [`witness ${witness}`] : [])].join(' · ');
}

export function renderMarkdown(report) {
  const t = report.totals;
  const lines = [`# ocli digest since ${report.since}`, ''];
  const notes = [
    t.undated ? `${t.undated} undated excluded` : '', t.leadCorrections ? `${t.leadCorrections} lead-corrections skipped` : '',
    t.endsWithoutNode ? `${t.endsWithoutNode} run${t.endsWithoutNode === 1 ? '' : 's'} with no tree node` : '', t.liveDir === 'missing' ? 'no live dir: statuses derived from the tree' : '',
    t.unreadable?.treeLines ? `${t.unreadable.treeLines} unreadable tree lines` : '', t.unreadable?.liveLines ? `${t.unreadable.liveLines} unreadable live lines` : '',
    t.unreadable?.plans ? `${t.unreadable.plans} unreadable plans` : '',
    t.unreadable?.treeFiles ? `${t.unreadable.treeFiles} unreadable tree files` : '', t.unreadable?.liveFiles ? `${t.unreadable.liveFiles} unreadable live files` : '',
  ].filter(Boolean);
  lines.push(t.runs ? `${t.tasks} task${t.tasks === 1 ? '' : 's'} · ${summary(t)}` : `${t.tasks} tasks · no runs`);
  if (notes.length) lines.push('', notes.join(' · '));
  for (const task of report.tasks) {
    const wall = task.runs ? ` · wall ${task.wallMs === null ? 'unknown' : duration(task.wallMs)}` : '';
    lines.push('', `## ${md(task.task)} · ${task.done}/${task.total} phases${wall}`, '');
    for (const p of task.phases) {
      const none = p.earlier ? `no run in the window · ${p.earlier} earlier run${p.earlier === 1 ? '' : 's'}` : 'declared, no run';
      lines.push(`- ${md(p.name)}${p.declared ? '' : ' (undeclared)'}: ${p.runs ? summary(p) : none}`);
    }
  }
  lines.push('', '## Needs a decision', '');
  if (!report.decisions.length) lines.push('none');
  for (const d of report.decisions) {
    const score = d.score === 1 ? 'pass' : d.score === 0 ? 'verify failed' : 'unscored';
    const witness = d.witness.length ? ` · witness ${d.witness.map(md).join(', ')}` : '';
    lines.push(`- ${md(d.task)} / ${md(d.phase)} · ${md(d.cli)} ${d.status} · ${score}${witness}${d.blockedCheck ? ` · ${md(d.blockedCheck)}` : ''}`
      + ` · run ${md(d.runId ?? 'unknown')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The run.start, run.end and usage records and the plans under a live dir. Files whose mtime
 * predates `sinceMs` hold nothing in the window and are not read. Links are never followed. A file
 * that cannot be read is counted, never fatal. */
async function readLive(liveDir, sinceMs) {
  const out = { records: [], plans: [], unreadableLines: 0, unreadablePlans: 0, unreadableFiles: 0, missing: false };
  let tasks;
  try { tasks = await readdir(liveDir, { withFileTypes: true }); } catch { out.missing = true; return out; }
  for (const dir of tasks.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    const files = await readdir(path.join(liveDir, dir), { withFileTypes: true }).catch(() => []);
    for (const file of files.filter(entry => entry.isFile()).map(entry => entry.name).sort()) {
      const where = path.join(liveDir, dir, file);
      if (file === 'plan.json') {
        try {
          const plan = JSON.parse(await readRegular(where));
          out.plans.push({ task: dir, phases: plan.phases, declaredAt: plan.declaredAt });
        } catch { out.unreadablePlans += 1; }
        continue;
      }
      if (!file.endsWith('.jsonl') || file.endsWith('.raw.jsonl')) continue;
      const stat = await lstat(where).catch(() => null);
      if (!stat?.isFile() || stat.mtimeMs < sinceMs) continue;
      let text;
      try { text = await readRegular(where); } catch { out.unreadableFiles += 1; continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { out.unreadableLines += 1; continue; }
        if (record?.kind === 'run.end' || record?.kind === 'usage') out.records.push(record);
        else if (record?.kind === 'run.start') out.records.push({ kind: record.kind, runId: record.runId, phase: record.phase });
      }
    }
  }
  return out;
}

const FLAGS = new Set(['since', 'json', 'root']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !FLAGS.has(flag.slice(2))) throw new Error(`unknown argument ${flag}; expected --since, --json or --root`);
    out[flag.slice(2)] = argv[i + 1];
  }
  return out;
}

export async function main(argvInput = process.argv.slice(2)) {
  const args = parseArgs(argvInput);
  const now = new Date();
  let since = null;
  if ('since' in args) {
    const ms = time(args.since);
    if (!Number.isFinite(ms)) throw new Error(`--since is not a date: ${args.since}`);
    since = new Date(ms).toISOString();
  }
  const root = path.resolve(args.root ?? 'orchestra');
  const { nodes, unreadableLines, unreadableFiles } = await readNodes(path.join(root, 'tree'));
  const liveDir = !('root' in args) && process.env.ORCHESTRA_LIVE_DIR ? path.resolve(process.env.ORCHESTRA_LIVE_DIR) : path.join(root, 'live');
  const live = await readLive(liveDir, since === null ? now.getTime() - WINDOW_MS : Date.parse(since));
  const report = digest({ nodes, ends: live.records, plans: live.plans, since, now });
  report.totals.unreadable = { treeLines: unreadableLines, liveLines: live.unreadableLines, plans: live.unreadablePlans,
    treeFiles: unreadableFiles, liveFiles: live.unreadableFiles };
  if (live.missing) report.totals.liveDir = 'missing';
  process.stdout.write('json' in args ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
}

// Only run when invoked; importing this module reads nothing and spawns nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`[digest] ${error.message}\n`);
    process.exitCode = 2;
  });
}
