#!/usr/bin/env node
// ocli dispatcher: one headless coding-CLI invocation, streamed live and recorded.
//
// It spawns the CLI named by a policy route, turns the CLI's native JSON event stream into the
// normalized live-event contract (docs/LIVE-EVENTS.md) as it arrives, and appends one record per run
// to the task's tree file once the run is over.
//
// Two rules it will not bend:
//
//   1. A record states what was OBSERVED, never what was assumed. No verifier run means `score: null`,
//      not zero: unknown and zero are different evidence.
//   2. A route whose policy status is not "ok" is REFUSED, not attempted. Burning a turn on a
//      provider known to be dead to rediscover it is the cost this layer exists to avoid.
//
// Files (relative to the process cwd, normally the project root the ocli pane watches):
//   orchestra/live/<task>/<runId>.jsonl      normalized live events (ORCHESTRA_LIVE_DIR moves the root)
//   orchestra/live/<task>/<runId>.raw.jsonl  every raw CLI line, owner-only
//   orchestra/live/<task>/plan.json          the declared phases (--declare-phases), owner-only
//   orchestra/tree/<task>.jsonl              one record per finished run
//
// Usage:
//   node dispatcher/dispatch.mjs --role implement --task fix-parser --prompt "..." [--verify "npm test"]
//                     [--title <what it is for>] [--phase <card phase, default: the role>]
//                     [--parent <nodeId>] [--root <dir>] [--suffix <per-run text, appended LAST for cache stability>]
//                     [--brief <what the person reads in the pane; default: derived from --suffix and the prompt>]
//                     [--pick-reason <why this route; recorded on the node>]
//                     [--size S|M|L <the slice's size as the lead judged it; recorded on the node>]
//                     [--continue <nodeId> <resume that failed run's hand-off: its worktree, a note LAST>]
//                     [--worktree auto <run in <repo>.worktrees/<task> on ocli/<task>; created or reused>]
//                     [--dry-run <LAST flag, with --worktree auto: print the path, create and spawn nothing>]
//   node dispatcher/dispatch.mjs --role auto [--min-aa 44] ...   (highest-AA eligible route in the rotation; rule aa-rank)
//   node dispatcher/dispatch.mjs --list-routes [--json]           (routes by AA Intelligence Index; spawns nothing)
//   node dispatcher/dispatch.mjs --declare-phases implement,review,merge --task fix-parser
//                                (writes the task's plan for the pane's card; spawns nothing, records no node)

import { appendFile, lstat, mkdir, readFile, readlink, rename, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, mkdirSync } from 'node:fs';
import { normalize, createLineSplitter, stderrCliErrors } from './events.mjs';
import { claimsOf, witness } from './witness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paneLabel } from './pane-label.mjs';
import { readCodexUsage, readGlmUsage, claudeUsageFromLead, usageDelta, usageDeltas, gateFor, budget, plansError, BUDGETED } from './usage.mjs';
import { providerForNode, readNodes, latestReading, stopProviderForNode, latestProviderStop } from './tree-read.mjs';
import { aaFor, loadRanking } from './ranking.mjs';
import { handoff, handoffReason, handoffSync } from './handoff.mjs';
import { resolveWorktree } from './worktree.mjs';

/**
 * Which provider's usage counter backs each route. A role absent here has no readable counter, so a
 * usage-limit claim about it can only ever be an unconfirmed heuristic.
 */
const USAGE_PROVIDER_BY_ROLE = { reason: 'codex', easy: 'codex' };

async function readProviderUsage(provider) {
  try {
    if (provider === 'codex') {
      const report = await readCodexUsage();
      // The provider's own verdict beats any percentage we might interpret.
      if (report.status === 'ok') report.exhausted = report.ordinaryUsageAllowed === false;
      return report;
    }
    return { status: 'unknown', reason: `no reader for ${provider}`, windows: [] };
  } catch (error) {
    return { status: 'unavailable', reason: String(error), windows: [] };
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`expected a --flag at argument ${i + 1}, got ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** Argument arrays only. A prompt is data and never reaches a shell. */
/** The child process running right now (the CLI, then the verifier or git): where a signal goes.
 * Cleared when it exits, so a signal never reaches a pid the OS may already have reused. */
let currentChild = null;

/** `timeoutMs` (optional): past it the child is SIGKILLed and the result says `timedOut: true`. */
export function run(command, args, cwd, live = null, timeoutMs = null) {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const splitters = { stdout: createLineSplitter(), stderr: createLineSplitter() };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let timer = null;
    let timedOut = false;
    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      currentChild = null;
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      for (const stream of ['stdout', 'stderr']) {
        for (const line of splitters[stream].end()) live?.line(stream, line);
      }
      resolve({ code, signal, stdout, stderr: error ? String(error) : stderr,
        ms: Date.now() - started, spawnError: error !== null, timedOut });
    };
    let child;
    try {
      // stdin MUST be closed: an empty open pipe can leave a headless CLI waiting forever.
      child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      live?.start(null);
      finish(null, null, error);
      return;
    }
    currentChild = child;
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    live?.start(child.pid ?? null);
    child.stdout.on('data', chunk => {
      if (settled) return;
      stdout += typeof chunk === 'string' ? chunk : decoders.stdout.write(chunk);
      for (const line of splitters.stdout.push(chunk)) live?.line('stdout', line);
    });
    child.stderr.on('data', chunk => {
      if (settled) return;
      stderr += typeof chunk === 'string' ? chunk : decoders.stderr.write(chunk);
      for (const line of splitters.stderr.push(chunk)) live?.line('stderr', line);
    });
    child.on('error', error => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// Env overrides exist so the signal tests can pin the SIGKILL and git-timeout paths in a second or two.
const SIGNAL_GRACE_MS = Number(process.env.ORCHESTRA_SIGNAL_GRACE_MS) || 5000;
const SIGNAL_HANDOFF_MS = Number(process.env.ORCHESTRA_SIGNAL_HANDOFF_MS) || 10_000;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Q8: whether `pid` still runs, asked synchronously. In a signal handler the event loop never runs,
 * so Node never reaps the child: a dead child stays a zombie and kill(pid, 0) keeps succeeding
 * (measured: 1 s after SIGTERM, ps said Z). So ps decides; a probe that cannot run counts as gone. */
function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    return probe.status === 0 && !probe.stdout.trim().startsWith('Z');
  } catch { return false; }
}

/** Q8: pass the signal to the child, wait up to 5 s for it to die, then SIGKILL. Synchronous.
 * ponytail: kills the direct child only (a grandchild may still write during the commit) —
 * process-group kill later. */
function stopChildSync(child, signal) {
  const pid = child?.pid;
  if (!pid) return;
  try { process.kill(pid, signal); } catch { return; }
  const until = Date.now() + SIGNAL_GRACE_MS;
  while (running(pid)) {
    if (Date.now() >= until) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } return; }
    pause(50);
  }
}

/** Q8: git for the signal path's hand-off: spawnSync, every call inside one 10 s budget. */
function gitSync(cwd) {
  const deadline = Date.now() + SIGNAL_HANDOFF_MS;
  return (args, timeoutMs) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())) });
    return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
  };
}

function resolveArgv(route, values) {
  const allowed = new Set(['model', 'effort', 'variant', 'task', 'root', 'prompt']);
  // Validate templates before inserting data: prompts and paths may legitimately contain braces.
  for (const item of route.argv) {
    for (const [, name] of item.matchAll(/\{([^{}]+)\}/g)) {
      if (!allowed.has(name)) throw new Error(`unknown placeholder {${name}}`);
      if (values[name] == null) throw new Error(`missing value for placeholder {${name}}`);
    }
  }
  return route.argv.map(item => item.replace(/\{([^{}]+)\}/g, (_, name) => values[name]));
}

// Raw lines hold prompts and absolute paths: owner-only. mode applies when a call creates the file.
const LIVE_WRITE = { encoding: 'utf8', mode: 0o600 };
// Ctrl-C, a kill, a closed terminal: each would otherwise leave the run without a run.end.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** What a run is for, for the pane: --title, else the prompt's first non-empty line, at most 120. */
export function runTitle(title, prompt) {
  // || not ??: an empty --title falls back to the prompt as well.
  return paneLabel(title || String(prompt ?? '').split('\n').find(line => line.trim()) || '', 120);
}

const BRIEF_MAX = 600;
const isHeading = line => /^\s*#{1,6}\s/.test(line);
// Markdown that reads as noise in the pane: emphasis, code ticks, heading marks and bullets.
const unmark = line => line.replace(/\*\*|__|`/g, '').replace(/^\s*#+\s*/, '').replace(/^\s*[-*]\s+/, '');
// "Your worktree (…): <path>": the pane draws the run's root on its own row.
const WORKTREE_CLAUSE = /(?:\byour\s+)?\bworktree\b[^:\n]*:\s*\S+/gi;

/** The prompt's paragraphs: runs of non-blank, non-heading lines. */
function paragraphs(lines) {
  const out = [];
  let current = [];
  for (const line of [...lines, '']) {
    if (line.trim() && !isHeading(line)) current.push(line);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  }
  return out;
}

/** What the run was asked to do, for the person reading the pane's expanded card: --brief, else the
 * prompt's first markdown heading, its first task paragraph (the first one that does not open in
 * emphasis: those are constraints, "**RUN ONLY …**"; else the first) and the --suffix less its
 * worktree clause, joined with " · ". Markdown markers are stripped, each part whitespace-folded
 * (paneLabel strips a newline rather than folding it), then cleaned like the title; at most 600 code
 * points. Never the whole prompt: the pane shows the opening of --prompt, so keep secrets out of it. */
export function runBrief(brief, prompt, suffix) {
  const label = text => paneLabel(String(text ?? '').replace(/\s+/g, ' '), BRIEF_MAX);
  // || not ??: an empty (or all-control) --brief falls back to the derived one, as --title does.
  const own = label(brief);
  if (own) return own;
  const lines = String(prompt ?? '').split('\n');
  const heading = unmark(lines.find(isHeading) ?? '');
  const found = paragraphs(lines);
  const task = found.find(para => !/^\s*(\*\*|__)/.test(para[0])) ?? found[0] ?? [];
  const rest = String(suffix ?? '').split('\n').map(line => unmark(line.replace(WORKTREE_CLAUSE, '')));
  return label([heading, task.map(unmark).join(' '), rest.join(' ')].map(label).filter(Boolean).join(' · '));
}

/** Which phase of the task a run belongs to, for the pane's card: --phase, cleaned like the title
 * and at most 40 code points; absent, or empty once cleaned, the route's role. */
export function runPhase(phase, role) {
  return paneLabel(phase, 40) || role;
}

// ORCHESTRA_LIVE_DIR (read per call, so tests can point it at a temp dir) moves the live root.
const liveRoot = () => (process.env.ORCHESTRA_LIVE_DIR ? path.resolve(process.env.ORCHESTRA_LIVE_DIR) : path.resolve('orchestra', 'live'));

// Shared by candidate reads and node appends; preserve the package cwd-relative default.
const treeRoot = () => process.env.ORCHESTRA_TREE_DIR
  ? path.resolve(process.env.ORCHESTRA_TREE_DIR) : path.resolve('orchestra', 'tree');

// --task becomes a path segment under orchestra/live/ and orchestra/tree/,
// and a CLI argv value ({task} -> opencode --title). A leading alphanumeric rules out '.', '..' and
// a value that the CLI would parse as a flag ('--share').
function checkTask(task) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task ?? '')) {
    throw new Error(`--task must match [A-Za-z0-9][A-Za-z0-9._-]* (got ${JSON.stringify(task)})`);
  }
}

const MAX_PHASES = 50;

/** --declare-phases: the task's whole plan, for the pane's card to draw before any run starts. Each
 * name is cleaned as --phase is, so a run's phase and its declared row compare equal. Atomic: the
 * pane never reads a half-written plan. Nothing is spawned and nothing enters the tree. */
async function declarePhases(args) {
  checkTask(args.task);
  const names = [...new Set(String(args['declare-phases'] ?? '').split(',').map(name => runPhase(name, '')).filter(Boolean))]
    .slice(0, MAX_PHASES);
  if (names.length === 0) throw new Error('--declare-phases names no phase');
  const dir = path.join(liveRoot(), args.task);
  await mkdir(dir, { recursive: true });
  // An unguessable name opened O_EXCL: a link planted in the live dir (a CLI under --yolo can write
  // there) is refused, never written through. ponytail: <task> itself being a linked dir is followed,
  // as createLive follows it.
  const temp = path.join(dir, `plan.json.${randomUUID()}.tmp`);
  const plan = { v: 1, phases: names.map(name => ({ name })), declaredAt: new Date().toISOString() };
  await writeFile(temp, `${JSON.stringify(plan)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, path.join(dir, 'plan.json'));
  process.stderr.write(`[dispatch] declared ${names.length} phases for ${args.task}\n`);
}

function createLive(args, route, workspace, prefixSha) {
  const runId = randomUUID();
  // liveFile is the absolute path under an ORCHESTRA_LIVE_DIR override, otherwise the cwd-relative one.
  const override = process.env.ORCHESTRA_LIVE_DIR;
  const file = path.join(liveRoot(), args.task, `${runId}.jsonl`);
  const liveFile = override ? file : `orchestra/live/${args.task}/${runId}.jsonl`;
  const rawFile = file.replace(/\.jsonl$/, '.raw.jsonl');
  const state = { dropped: Object.create(null), cliErrors: [] };
  let seq = 0;
  let errors = 0;
  let finalText = null;
  // Q6: the run's token totals, summed from the normalized usage events. null until one arrives.
  let tokens = null;
  // The tool.end records written, for the witness: the only kind it reads, so streamed message deltas
  // never push them out. ponytail: the newest 5000; a longer run's oldest edits and test runs fall out.
  const events = [];
  const attempt = action => { try { action(); } catch { errors++; } };
  attempt(() => mkdirSync(path.dirname(file), { recursive: true }));
  // Create both per-run files even when the child produces no output.
  attempt(() => appendFileSync(file, '', LIVE_WRITE));
  attempt(() => appendFileSync(rawFile, '', LIVE_WRITE));
  const emit = (event, at = new Date().toISOString()) => {
    const record = { v: 1, runId, seq, at, task: args.task, role: args.role, cli: route.cli, ...event };
    // seq advances only once the record is on disk: a failed write must not leave a gap.
    attempt(() => {
      appendFileSync(file, `${JSON.stringify(record)}\n`, LIVE_WRITE);
      seq++;
      if (record.kind === 'tool.end') events.push(record);
      if (events.length > 5000) events.shift();
    });
  };
  return {
    runId, liveFile, state, emit,
    get errors() { return errors; },
    get finalText() { return finalText; },
    get events() { return events; },
    // metered = what the provider bills against the plan: cached input is NOT in it. A field no event
    // carried stays null; metered is null when input or output is (reasoning null counts as 0).
    get tokens() {
      if (!tokens) return null;
      const { input, output, reasoning } = tokens;
      return { ...tokens, metered: input === null || output === null ? null : input + output + (reasoning ?? 0) };
    },
    start(pid) {
      emit({ kind: 'run.start', model: route.model, root: workspace, parentId: args.parent ?? null, pid,
        title: runTitle(args.title, args.prompt), phase: runPhase(args.phase, args.role), prefixSha,
        brief: runBrief(args.brief, args.prompt, args.suffix) });
    },
    line(stream, line) {
      const at = new Date().toISOString();
      attempt(() => appendFileSync(rawFile, `${JSON.stringify({ at, stream, line })}\n`, LIVE_WRITE));
      if (stream === 'stdout') {
        for (const event of normalize(route.cli, line, state)) {
          if (event.kind === 'message') finalText = event.text;
          if (event.kind === 'usage') {
            tokens ??= { input: null, output: null, cached: null, reasoning: null };
            for (const field of ['input', 'output', 'cached', 'reasoning']) {
              if (event[field] !== null) tokens[field] = (tokens[field] ?? 0) + event[field];
            }
          }
          emit(event, at);
        }
      }
    },
  };
}

const USAGE_LIMIT = /usage limit|quota exceeded|rate limit|insufficient (credit|quota)/i;

/**
 * Was this run actually cut off by the provider, or did its transcript merely quote the words?
 *
 * Exported and injectable because a plain text match gets this wrong: a developer CLI that quotes
 * its own instructions ("on a rate limit, use the next model") looks exactly like a refusal.
 * `readUsage` is a parameter so a test can exercise every branch without touching a live provider.
 */
// `cliError` is the text of error events the CLI itself emitted (events.mjs state.cliErrors), never
// model-authored text. opencode in json mode reports a session error ONLY that way, on stdout, with
// stderr empty — so for a role with no counter it is refusal evidence on its own, at any exit code.
export async function decideBlocked({ result, role, readUsage, usageReport = null, cliError = '' }) {
  const cliHit = USAGE_LIMIT.exec(cliError);
  // The CLI's own error event comes first: when it decides, it must also be the stored evidence.
  const hit = cliHit ?? USAGE_LIMIT.exec(result.stderr) ?? USAGE_LIMIT.exec(result.stdout);
  if (!hit) return { blocked: false, blockedEvidence: null, blockedCheck: 'no usage-limit text in the transcript', blockedBasis: null };
  const blockedEvidence = hit.input.slice(Math.max(0, hit.index - 200), hit.index + 200);
  const provider = USAGE_PROVIDER_BY_ROLE[role] ?? null;
  if (!provider) {
    const stderrRefusal = result.code !== 0 && USAGE_LIMIT.test(result.stderr);
    return {
      blocked: stderrRefusal || cliHit !== null,
      blockedEvidence,
      blockedCheck: cliHit
        ? `no usage counter for role ${role}; CLI-emitted error event carries limit wording (exit ${result.code})`
        : `no usage counter for role ${role}; unconfirmed heuristic on stderr + exit ${result.code}`,
      blockedBasis: cliHit ? 'cli-error-event' : stderrRefusal ? 'no-counter-heuristic' : null,
    };
  }
  // Prefer the reading dispatch already took immediately after the run: it is the same moment this
  // decision is about, and re-reading would spawn another app-server for no new information.
  const report = usageReport?.status === 'ok' ? usageReport : await readUsage(provider);
  if (report.status !== 'ok') {
    return {
      blocked: result.code !== 0,
      blockedEvidence,
      blockedCheck: `usage unreadable (${report.status}); fell back to exit code ${result.code}`,
      blockedBasis: result.code !== 0 ? 'counter-unreadable-exit-code' : null,
    };
  }
  const window = gateFor(provider, report).window ?? null;
  // Exhaustion is the PROVIDER's number, never our own 35% routing cap: a policy stop is a decision
  // we made, and recording it as "the provider refused" would corrupt the tree's evidence.
  const exhausted = report.exhausted === true || (window ? window.usedPercent >= 99 : false);
  const where = window ? `${window.limitId} at ${window.usedPercent}%` : 'no bound window';
  // Two different things wear the same words, and only together do they identify a refusal:
  //   - the run FAILED with this text  -> the provider turned it away. That can be a transient rate
  //     limit while the window still has room, which is real and worth recording.
  //   - the counter says EXHAUSTED     -> out of allowance, whatever the exit code.
  // A run that exits 0 against a healthy counter is neither: that is a CLI quoting documentation
  // while it delivers complete work.
  const refused = result.code !== 0;
  const blocked = exhausted || refused;
  // No window bound to this route's pools is the same 'unknown' gateFor reports: the counter was read
  // but says nothing about this route, so it cannot show room. The exit code decided, as when unreadable.
  if (refused && !exhausted && !window) {
    return { blocked, blockedEvidence, blockedBasis: 'counter-unreadable-exit-code',
      blockedCheck: `usage read but no window matched the pools this route consumes; fell back to exit code ${result.code}` };
  }
  let blockedCheck;
  if (exhausted) blockedCheck = `usage confirms exhaustion (${where})`;
  else if (refused) blockedCheck = `run failed with exit ${result.code} and limit wording, but the counter shows room (${where}) — a transient refusal, not exhaustion`;
  else blockedCheck = `TEXT MATCHED BUT NOTHING CONFIRMS IT: exit 0 and ${where} — treated as quoted text, not a refusal`;
  const blockedBasis = exhausted ? 'counter-exhausted' : refused ? 'counter-transient-refusal' : null;
  return { blocked, blockedEvidence, blockedCheck, blockedBasis };
}

// What the stderr line may claim for each blockedBasis. Only the provider's own counter showing
// exhaustion is CONFIRMED; every other route that sets `blocked` says what it actually is.
const BLOCKED_LABEL = {
  'counter-exhausted': 'usage limit CONFIRMED against its counter',
  'counter-transient-refusal': 'refused (transient; counter shows room)',
  'counter-unreadable-exit-code': 'UNCONFIRMED: no readable counter for this route, exit code decided',
  'no-counter-heuristic': 'UNCONFIRMED: no usage counter, heuristic',
  'cli-error-event': "refused by the CLI's own error event",
};

// PS1: a FAILED run carrying the provider's own limit message in a CLI error/warn EVENT is a
// dated routing stop, recorded beside the blocked flag it does not touch. The event
// requirement is the whole point: model text also renders on stderr, so only JSON error
// events (stdout via normalize, stderr via stderrCliErrors) can carry this verdict. Measured
// 2026-10-12: cline's ClinePass message matches no USAGE_LIMIT alternative, hence its arm.
// Window limits only: a transient `rate limit` / 429 stays `blocked`, never a stop.
const PROVIDER_STOP_LIMIT = /usage limit|clinepass limit|quota exceeded|insufficient (credit|quota)/i;
const ABSOLUTE_RESET = /will\s+reset\s+at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const RELATIVE_RESET = /resets?\s+in\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i;
const RETRY_AFTER_RESET = /retry\s+after\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i;

/** The CLI's local wall time as an ISO UTC instant. Exported so tests can inject a zone. */
export function localWallToIso(year, month, day, hour, minute, second) {
  const at = new Date(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(at.getTime())) throw new Error('unparseable reset time');
  // No rollover: Feb 31 becomes Mar 3 in the Date constructor, which would invent a reset.
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day
    || at.getHours() !== hour || at.getMinutes() !== minute || at.getSeconds() !== second) {
    throw new Error('unparseable reset time');
  }
  return at.toISOString();
}

/**
 * The provider-declared reset as an absolute ISO instant, or null when the text carries no
 * parseable reset (an unknown stop, cleared only by a later successful run). Absolute ("will
 * reset at YYYY-MM-DD HH:MM:SS", the CLI's LOCAL wall time) beats relative ("resets in 1h
 * 6m" or "resets in 1 hour 30 minutes", and a "retry after N seconds" phrase on a window
 * message, after runEndMs); a present-but-invalid absolute falls through to the relative phrase.
 */
export function parseProviderReset(text, runEndMs, localToIso = localWallToIso) {
  const words = String(text ?? '');
  const absolute = ABSOLUTE_RESET.exec(words);
  if (absolute) {
    const [, year, month, day, hour, minute, second] = absolute.map(Number);
    const dim = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
    if (month >= 1 && month <= 12 && day >= 1 && day <= dim && hour <= 23 && minute <= 59 && second <= 59) {
      try {
        return localToIso(year, month, day, hour, minute, second);
      } catch { /* fall through to the relative phrase, if any */ }
    }
  }
  const relative = RELATIVE_RESET.exec(words) ?? RETRY_AFTER_RESET.exec(words);
  if (relative && Number.isFinite(runEndMs)) {
    let ms = 0;
    let found = false;
    for (const [, amount, unit] of relative[1].matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi)) {
      found = true;
      const first = unit.toLowerCase()[0];
      const each = first === 'h' ? 3600_000 : first === 'm' ? 60_000 : 1000;
      ms += Number(amount) * each;
    }
    if (found) {
      try {
        return new Date(runEndMs + ms).toISOString();
      } catch { return null; } // absurd durations overflow the Date range: unparseable
    }
  }
  return null;
}

/**
 * P1-P3: only a FAILED run whose window-limit text comes from the CLI's own error/warn event
 * text yields a stop. The exit code must be numeric nonzero — a run that never started
 * (spawnError, code null) or was killed carries no provider verdict — and the CLI must map
 * to a stop provider. Evidence is the FIRST limit-matching line (the whole error object,
 * C0/C1 and bidi/isolate controls stripped, 200 code points); the full text stays in the
 * node's stdoutTail/stderrTail.
 */
export function decideProviderStop({ result, cliErrorText, cli, model, runEndMs, localToIso = localWallToIso }) {
  if (typeof result?.code !== 'number' || result.code === 0) return null;
  const provider = stopProviderForNode({ cli, model });
  if (!provider) return null;
  const line = String(cliErrorText ?? '').split(/\r?\n/).find(candidate => PROVIDER_STOP_LIMIT.test(candidate));
  if (!line) return null;
  const evidence = [...line.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')].slice(0, 200).join('');
  return { provider, resetsAt: parseProviderReset(cliErrorText, runEndMs, localToIso), evidence };
}

/** An uncleared stop still binds. Unknown (or corrupt) resets fail closed — a later success
 * is the only way out — while a dated one ends the instant its reset passes. */
function providerStopActive(stop, nowMs) {
  if (!stop || typeof stop !== 'object') return false;
  if (typeof stop.resetsAt !== 'string') return true;
  const at = Date.parse(stop.resetsAt);
  if (!Number.isFinite(at)) return true;
  return at > nowMs;
}


// Porcelain v2 fields before the path, per entry type (1 changed, 2 renamed, u unmerged, ? untracked).
const PATH_FIELD = { 1: 8, 2: 9, u: 10, '?': 1 };

/** The work tree as git sees it, minus the dispatcher's own files (live, tree, codex -o) and
 * node_modules: what the developer CLI could have changed. null when it is not a readable git tree.
 * HEAD (branch.oid) is in it, so a CLI that committed its work changed it; so is each listed file's
 * content hash, so more work in a file that was already dirty is not invisible. */
async function treeState(workspace) {
  // core.fsmonitor in the repo config is a command git status runs; the CLI could have written it.
  const status = await run('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'], workspace);
  if (status.code !== 0) return null;
  const lines = status.stdout.split('\n')
    .filter(line => line.trim() && !/node_modules|(^|[\s/"])orchestra\/(live|tree)\/|\.orchestra-last\.md"?$/.test(line)
      && (!line.startsWith('# ') || line.startsWith('# branch.oid ')));
  // ponytail: whole-file reads, twice per dispatch; a C-quoted path or a --root below the repo top
  // reads as '-' both times, which falls back to the porcelain line alone.
  return (await Promise.all(lines.map(async line => {
    const skip = PATH_FIELD[line[0]];
    if (skip === undefined) return line;
    const file = line.split(' ').slice(skip).join(' ').split('\t')[0];
    // lstat, never a followed open: the CLI leaves the tree, and a FIFO it left would block the read
    // (and the dispatcher) forever, a link would read outside the workspace. A link is its target string.
    const where = path.join(workspace, file);
    const body = await lstat(where).then(stat => stat.isFile() ? readFile(where) : stat.isSymbolicLink() ? readlink(where) : null, () => null);
    const hash = body === null ? '-' : createHash('sha1').update(body).digest('hex');
    return `${line} ${hash}`;
  }))).join('\n');
}

/** Entries of `after` not in `before`, and the reverse, the branch header aside: 0 iff nothing changed
 * but HEAD. A moved HEAD (a commit) shows as its header changing, so it counts. */
function changedLines(before, after) {
  const entries = state => state.split('\n').filter(line => line && !line.startsWith('# '));
  const a = new Set(entries(before));
  const b = new Set(entries(after));
  const moved = before && before.split('\n').find(line => line.startsWith('# branch.oid ')) !== after.split('\n').find(line => line.startsWith('# branch.oid '));
  return [...a].filter(line => !b.has(line)).length + [...b].filter(line => !a.has(line)).length + (moved ? 1 : 0);
}

async function readRouteUsage(route) {
  try {
    let reading;
    if (route.cli === 'codex') reading = await readCodexUsage();
    else if (route.cli === 'opencode' && route.model.startsWith('zai-coding-plan/')) reading = await readGlmUsage();
    else if (route.cli === 'claude') reading = claudeUsageFromLead();
    else return { status: 'unavailable', reason: `no usage reader for ${route.cli} (${route.model})` };
    if (!reading?.status) throw new Error('usage reader returned no status');
    return reading;
  } catch (error) {
    return { status: 'unavailable', reason: String(error) };
  }
}

// RS1: the candidate set at dispatch time. A node said "role: implement" and nothing about what
// else could have taken the slice; replay cannot traverse choices nobody wrote down. Pure
// recording: it never changes which route runs, and it spawns nothing — a gate is the chosen
// route's own usageBefore reading, a recorded tree reading, or the absence of both. The one
// exception is --role auto: a capped route with no current reading gets ONE usage read (never an
// inference call) before the pick, and that reading is what gets recorded.
const NON_CANDIDATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** One route's gate and where it came from. Precedence, first match wins: the provider has no
 * budget row (or none at all) -> the plans file is unreadable (`plans-error`, unknown) ->
 * deliberately uncapped -> the chosen route's live usageBefore reading -> --role auto's fresh usage
 * read -> the newest recorded tree reading, unless its window has since reset (`tree-expired`,
 * unknown) -> no reading anywhere, which is `unknown`, never assumed room (the rotation's skip rule
 * refuses to spend blind on a capped route). */
function candidateRoute({ role, route, chosenRole, usageBefore, inRotation, treeReadingFor, treeStopFor, liveReadings, ranking, nowMs }) {
  const provider = providerForNode({ cli: route.cli, model: route.model });
  // PS1 first: a provider-declared stop binds even where no budget row exists (cline) or the
  // route is uncapped (glm) — the provider's own verdict beats every reading we took.
  const stopProvider = stopProviderForNode({ cli: route.cli, model: route.model });
  const stopEntry = stopProvider ? treeStopFor(stopProvider) : null;
  if (stopEntry && providerStopActive(stopEntry.providerStop, nowMs)) {
    const stopStatus = route.status ?? null;
    return {
      role,
      cli: route.cli ?? null,
      model: route.model ?? null,
      inRotation: inRotation.has(role),
      status: stopStatus,
      gate: 'stop',
      gateSource: 'provider-declared',
      resetsAt: stopEntry.providerStop?.resetsAt ?? null,
      eligible: false,
      excludedBy: stopStatus !== 'ok' ? 'status' : 'budget-stop',
      aa: aaFor(ranking, route),
    };
  }
  let gate;
  let gateSource;
  let gateReadAt;
  if (provider == null || !BUDGETED.includes(provider)) {
    gate = 'ok';
    gateSource = 'no-budget';
  } else if (plansError()) {
    // Unreadable plans honour no cap, so no budgeted route is room; recorded, the explicit role still runs.
    gate = 'unknown';
    gateSource = 'plans-error';
  } else if (budget()[provider].stopAtPercent === null) {
    gate = 'ok';
    gateSource = 'uncapped';
  } else if (role === chosenRole && usageBefore?.status === 'ok') {
    gate = gateFor(provider, usageBefore).state;
    gateSource = 'live';
  } else if (liveReadings?.get(provider)?.status === 'ok') {
    gate = gateFor(provider, liveReadings.get(provider)).state;
    gateSource = 'live-refresh';
  } else {
    const reading = treeReadingFor(provider);
    if (reading?.expired) {
      // A pre-reset 96% is not today's 96%; neither is it room.
      gate = 'unknown';
      gateSource = 'tree-expired';
      gateReadAt = reading.recordedAt ?? null;
    } else if (reading) {
      gate = gateFor(provider, reading.report).state;
      gateSource = 'tree';
      gateReadAt = reading.recordedAt ?? null;
    } else {
      gate = 'unknown';
      gateSource = 'none';
    }
  }
  const status = route.status ?? null;
  const eligible = status === 'ok' && gate === 'ok';
  const excludedBy = eligible ? null : status !== 'ok' ? 'status' : gate === 'stop' ? 'budget-stop' : 'budget-unknown';
  return {
    role,
    cli: route.cli ?? null,
    model: route.model ?? null,
    inRotation: inRotation.has(role),
    status,
    gate,
    gateSource,
    ...(gateSource === 'tree' || gateSource === 'tree-expired' ? { gateReadAt } : {}),
    eligible,
    excludedBy,
    // AA Intelligence Index of exactly this (cli, model, effort); null = unranked (not measured, or no
    // ranking file). An opinion recorded beside the facts above, never one of them.
    aa: aaFor(ranking, route),
  };
}

/** The full candidate set: every dispatchable route in policy key order, the rotation, the rule
 * that picked (the lead's --role; the dispatcher applies no other), and an optional cleaned
 * --pick-reason. The chosen route MAY be ineligible — that is recorded, never refused.
 * `liveReadings` (provider -> fresh usage reading) is consulted before the tree; with `refresh`
 * (--role auto only) it is first filled with ONE read per capped provider whose in-rotation, ok
 * route has no current tree reading (missing or expired). */
async function buildCandidates({ policy, chosenRole, reasonText, usageBefore, rule = 'lead-explicit-role', liveReadings = new Map(), refresh = false }) {
  const rotationSource = policy?.developers?.rotation?.order;
  const rotation = Array.isArray(rotationSource) ? [...rotationSource] : [];
  const inRotation = new Set(rotation);
  const { nodes } = await readNodes(treeRoot());
  const ranking = await loadRanking();
  const nowMs = Date.now();
  // One tree scan shared by every capped route: provider -> newest recorded reading.
  const readings = new Map();
  const treeReadingFor = provider => {
    if (!readings.has(provider)) readings.set(provider, latestReading(nodes, provider, nowMs));
    return readings.get(provider);
  };
  // One tree scan shared by every stoppable route: pool -> newest uncleared provider stop.
  const stops = new Map();
  const treeStopFor = stopProvider => {
    if (!stops.has(stopProvider)) stops.set(stopProvider, latestProviderStop(nodes, stopProvider));
    return stops.get(stopProvider);
  };
  const dispatchable = Object.keys(policy?.routes ?? {})
    .filter(role => !NON_CANDIDATE_KEYS.has(role) && policy.routes[role]?.argv); // architect: never a candidate
  if (refresh) {
    for (const role of dispatchable) {
      const route = policy.routes[role];
      if (route.status !== 'ok' || !inRotation.has(role)) continue; // could not be picked anyway
      const provider = providerForNode({ cli: route.cli, model: route.model });
      if (provider == null || budget()[provider]?.stopAtPercent == null || liveReadings.has(provider)) continue;
      const reading = treeReadingFor(provider);
      if (reading && !reading.expired) continue;
      liveReadings.set(provider, await readRouteUsage(route));
    }
  }
  const routes = dispatchable.map(role => candidateRoute({ role, route: policy.routes[role], chosenRole, usageBefore,
    inRotation, treeReadingFor, treeStopFor, liveReadings, ranking, nowMs }));
  return {
    v: 1,
    rule,
    chosen: chosenRole,
    reason: paneLabel(reasonText, 200) || null,
    rotation,
    routes,
  };
}

/** ORCHESTRA_POLICY names a policy file outright (tests bring their own routes); otherwise your own
 * dispatcher/policy.json (gitignored) wins, and without one the shipped example is used. */
async function readPolicy() {
  if (process.env.ORCHESTRA_POLICY) return JSON.parse(await readFile(path.resolve(process.env.ORCHESTRA_POLICY), 'utf8'));
  const text = await readFile(path.join(HERE, 'policy.json'), 'utf8').catch(error => {
    if (error?.code !== 'ENOENT') throw error;
    return readFile(path.join(HERE, 'policy.example.json'), 'utf8');
  });
  return JSON.parse(text);
}

/** Routes ordered for the lead's choice: AA desc, unranked last in policy order. Tree-only gates — no
 * provider is called to list them (the RS1 boundary). */
async function rankedCandidates(policy) {
  const set = await buildCandidates({ policy, chosenRole: null, reasonText: null, usageBefore: null });
  const order = new Map(set.routes.map((r, i) => [r.role, i]));
  return [...set.routes].sort((a, b) => (a.aa === null) - (b.aa === null) || (b.aa ?? 0) - (a.aa ?? 0) || order.get(a.role) - order.get(b.role));
}

/** --list-routes [--json]: the picker. Prints and returns; spawns nothing. */
async function listRoutes(args) {
  const policy = await readPolicy();
  const routes = await rankedCandidates(policy);
  if ('json' in args) { process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`); return routes; }
  for (const r of routes) {
    const effort = policy.routes[r.role]?.effort ?? policy.routes[r.role]?.variant ?? '-';
    // PS1: a provider-declared stop names its reset; an unknown one says so, never a time.
    const until = r.gateSource === 'provider-declared'
      ? (typeof r.resetsAt === 'string' && Number.isFinite(Date.parse(r.resetsAt))
        ? ` until ${new Date(r.resetsAt).toISOString().slice(11, 16)}Z`
        : ' (reset unknown)')
      : '';
    process.stdout.write(`${String(r.aa ?? '-').padStart(3)}  ${r.role.padEnd(16)} ${String(r.cli).padEnd(9)} ${String(r.model).padEnd(40)} ${String(effort).padEnd(7)} `
      + `${r.eligible ? 'eligible' : `excluded:${r.excludedBy}`}${until}${r.inRotation ? '  [rotation]' : ''}\n`);
  }
  process.stdout.write('aa = Artificial Analysis Intelligence Index of exactly this (model, effort); - = not measured at this effort (unranked).\n');
  return routes;
}

/** --role auto: the highest-AA eligible route IN THE ROTATION (ties: rotation order), at or above
 * --min-aa. An unranked route is never auto-picked. No such route -> refuse; no developer CLI is spawned (a usage read may have run).
 * A capped route with no current reading is read once first; those readings are returned so the
 * recorded candidate set and the chosen route's usageBefore reuse them instead of re-reading. */
async function pickByAA(policy, minAaRaw) {
  const minAA = minAaRaw === undefined ? null : Number(minAaRaw);
  if (minAA !== null && !Number.isFinite(minAA)) throw new Error(`--min-aa must be a number, got ${minAaRaw}`);
  const rotation = Array.isArray(policy?.developers?.rotation?.order) ? policy.developers.rotation.order : [];
  const liveReadings = new Map();
  const set = await buildCandidates({ policy, chosenRole: null, reasonText: null, usageBefore: null, liveReadings, refresh: true });
  const pool = set.routes
    .filter(r => r.eligible && r.inRotation && r.aa !== null && (minAA === null || r.aa >= minAA))
    .sort((a, b) => b.aa - a.aa || rotation.indexOf(a.role) - rotation.indexOf(b.role));
  if (pool.length === 0) {
    const seen = set.routes.filter(r => r.inRotation).map(r => `${r.role}(aa ${r.aa ?? '-'}, ${r.eligible ? 'eligible' : r.excludedBy})`).join(', ');
    throw new Error(`--role auto: no eligible ranked route in the rotation${minAA !== null ? ` at aa >= ${minAA}` : ''}; rotation: ${seen || 'empty'}. No developer CLI was spawned.`);
  }
  const [first, second] = pool;
  return { role: first.role, reason: `aa-rank: ${first.role} aa=${first.aa}${second ? ` over ${second.role} aa=${second.aa}` : ' (only ranked eligible route)'}`, liveReadings };
}

const CONTINUE_CHANGED_MAX = 20;

/** Q9: --continue <nodeId>. The node's hand-off (Q7/Q8) names the worktree and the WIP commit; the
 * note says so to the next CLI. Refused — before any read or spawn — for an unknown id, a node with
 * no hand-off, or a --root that is not the hand-off's worktree. Every value is tree data a CLI
 * wrote, so each is cleaned like a pane label before it reaches argv. */
async function continuationFor(args) {
  const id = args.continue;
  const { nodes } = await readNodes(treeRoot());
  const prior = id ? nodes.findLast(n => n.nodeId === id) : undefined;
  if (!prior) throw new Error(`--continue: no node ${JSON.stringify(id ?? null)} in the tree`);
  const h = prior.handoff;
  if (!h || typeof h !== 'object') throw new Error(`--continue: node ${id} has no handoff (only a failed or signalled run leaves one)`);
  if (typeof h.worktree !== 'string' || !h.worktree) throw new Error(`--continue: node ${id}'s handoff names no worktree`);
  const root = path.resolve(h.worktree);
  if (args.root !== undefined && path.resolve(args.root) !== root) {
    throw new Error(`--continue: --root ${JSON.stringify(args.root)} is not the hand-off worktree ${JSON.stringify(root)}`);
  }
  const clean = (value, max) => paneLabel(value, max) || 'unknown';
  // Shape-checked, not just cleaned: the sha lands inside a `git show` the next CLI may run.
  const sha = typeof h.commit === 'string' && /^[0-9a-f]{7,64}$/.test(h.commit) ? h.commit : '';
  const changed = (Array.isArray(h.changed) ? h.changed : []).slice(0, CONTINUE_CHANGED_MAX)
    .map(line => paneLabel(String(line).replace('\t', ' '), 300)).filter(Boolean);
  const work = sha
    ? `its work is commit ${sha} on branch ${clean(h.branch, 200)} in this worktree`
    : `no commit — ${clean(h.commitSkipped, 200)}; any work is uncommitted in this worktree`;
  const note = `Continuation: a previous run (${clean(prior.cli, 80)}/${clean(prior.model, 80)}, node ${clean(prior.nodeId, 80)}) `
    + `stopped (${clean(h.reason, 40)}); ${work}; changed: ${changed.join(', ') || 'none'}; `
    + `read \`${sha ? `git show --stat ${sha}` : 'git status'}\` and continue; do not redo finished work.`;
  return { root, note };
}

export async function main(argvInput = process.argv.slice(2)) {
  const args = parseArgs(argvInput);
  // `in`, not `!== undefined`: the flag last with no value parses to undefined and must still be
  // this mode (and fail as naming no phase), not fall through to "--role is required".
  if ('declare-phases' in args) return declarePhases(args);
  if ('list-routes' in args) return listRoutes(args);
  for (const required of ['role', 'task', 'prompt']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  checkTask(args.task);
  // Q6: `in`, so a trailing --size with no value is refused, not taken as omitted.
  const size = 'size' in args ? args.size : null;
  if (size !== null && !['S', 'M', 'L'].includes(size)) throw new Error(`--size must be S, M or L, got ${JSON.stringify(size ?? null)}`);
  // Q9: resolved before anything is read or spawned, so a refusal costs nothing.
  let continuation = null;
  if ('worktree' in args && 'continue' in args) {
    throw new Error('--worktree and --continue are exclusive: the hand-off already names its worktree');
  }
  if ('continue' in args) {
    continuation = await continuationFor(args);
    args.root ??= continuation.root;
    args.parent = args.continue;
  }
  // Q10: the task's own worktree beside the repo becomes {root}; tree and live dirs stay put. A dry
  // run prints the path and returns before any read or spawn. Never merged or removed here.
  const useWorktree = (dryRun) => {
    const worktree = resolveWorktree({ root: args.root ?? process.cwd(), task: args.task, dryRun });
    process.stderr.write(`[dispatch] --worktree auto -> ${worktree.path} (${worktree.branch}, ${worktree.action})\n`);
    return worktree;
  };
  if ('worktree' in args) {
    if (args.worktree !== 'auto') throw new Error(`--worktree takes only "auto" (got ${JSON.stringify(args.worktree ?? null)})`);
    if ('dry-run' in args) { const worktree = useWorktree(true); process.stdout.write(`${worktree.path}\n`); return worktree; }
  } else if ('dry-run' in args) {
    throw new Error('--dry-run applies only to --worktree auto');
  }
  const policy = await readPolicy();
  let rule = 'lead-explicit-role';
  let liveReadings = new Map();
  if (args.role === 'auto') {
    const picked = await pickByAA(policy, args['min-aa']);
    liveReadings = picked.liveReadings;
    args.role = picked.role;
    args['pick-reason'] = args['pick-reason'] ? `${picked.reason}; ${args['pick-reason']}` : picked.reason;
    rule = 'aa-rank';
    process.stderr.write(`[dispatch] --role auto -> ${picked.role} (${picked.reason})\n`);
  }
  const route = policy.routes[args.role];
  if (!route) throw new Error(`no route named ${args.role}; the policy declares ${Object.keys(policy.routes).join(', ')}`);
  if (!route.argv) throw new Error(`route ${args.role} is not dispatchable (${route.note ?? 'no argv'})`);
  if (route.status !== 'ok') {
    throw new Error(
      `route ${args.role} (${route.cli}) is ${route.status}${route.verifiedAt ? ` as of ${route.verifiedAt}` : ''}: ${route.statusDetail ?? ''}\n`
      + 'Re-probe it and set status to "ok" in dispatcher/policy.json before dispatching. A known-dead provider is not retried blind.',
    );
  }
  // Created only once the route is known to run: a bad --role leaves no worktree or branch behind.
  if ('worktree' in args) args.root = useWorktree(false).path;
  const workspace = path.resolve(args.root ?? process.cwd());

  // {root} exists for CLIs that do not honour the process cwd (agy keeps its own workspace).
  // Cache discipline: providers key their prompt cache on a byte-stable PREFIX, so the shared spec
  // (--prompt) goes first and any per-dispatch text (--suffix: workdir, parent node) goes LAST.
  // Q9: a --continue note goes after the suffix, so the prefix stays the spec's.
  const prompt = [args.prompt, args.suffix, continuation?.note].filter(Boolean).join('\n\n');
  // The cache prefix's fingerprint: --prompt ONLY, never the suffix, so runs sharing a spec share it
  // and the pane can flag a phase whose prefix drifted. Recorded, never sent to the CLI.
  const prefixSha = createHash('sha256').update(args.prompt, 'utf8').digest('hex').slice(0, 12);
  // Null prototype: {constructor} or {toString} must not find an inherited value.
  const argv = resolveArgv(route, Object.assign(Object.create(null), { model: route.model, effort: route.effort,
    variant: route.variant, task: args.task, root: workspace, prompt }));
  // A reading --role auto took moments ago is this route's usageBefore: no second app-server.
  const refreshed = liveReadings.get(providerForNode({ cli: route.cli, model: route.model }));
  const usageBefore = refreshed?.status === 'ok' ? refreshed : await readRouteUsage(route);
  // Recording is additive and must never prevent the selected route from running.
  let candidates;
  try {
    candidates = await buildCandidates({ policy, chosenRole: args.role, reasonText: args['pick-reason'], usageBefore, rule, liveReadings });
  } catch (error) {
    candidates = { v: 1, error: String(error?.message ?? error) };
  }
  // PS1 P5: an explicit --role into a provider-declared stop still runs — the lead may
  // knowingly retry — but says so once, naming the reset. (--role auto cannot land here: it
  // only picks eligible routes. A stop racing the pick still warns, honestly late.)
  const chosenStop = candidates.routes?.find?.(candidate => candidate.role === args.role);
  if (chosenStop?.gateSource === 'provider-declared') {
    const reset = typeof chosenStop.resetsAt === 'string' && Number.isFinite(Date.parse(chosenStop.resetsAt))
      ? `until ${chosenStop.resetsAt}` : 'reset time unknown';
    process.stderr.write(`[dispatch] warning: ${stopProviderForNode({ cli: route.cli, model: route.model })} window stopped ${reset}; explicit --role ${args.role} dispatches anyway\n`);
  }
  const live = createLive(args, route, workspace, prefixSha);
  process.stderr.write(`[dispatch] live: ${live.liveFile}\n`);
  // Ctrl-C or a kill: the finally below never runs, and the pane would show this run as running,
  // then stale, for a day. Stop the child, keep its work (Q8), write a partial node and run.end,
  // then die by the same signal. All synchronous: an await would let the child's close resume main,
  // which would write a second node. A throw costs the node, never run.end or the re-raise.
  let ended = false;
  let cliStarted = false;
  // Set once the normal path starts its own Q7 hand-off and node write. A signal from then on must
  // not kill that git commit mid-flight (index.lock) nor write a second node for the same runId.
  // ponytail: such a signal leaves run.end but maybe no node (the git child is left to finish, not
  // waited for) — defer the re-raise until the node lands if that window ever loses work.
  let finishing = false;
  const onSignal = signal => {
    for (const name of SIGNALS) process.removeListener(name, onSignal);
    if (ended) return;
    ended = true;
    let partialId = null;
    if (!finishing) try {
      stopChildSync(currentChild, signal);
      // A CLI that never started left nothing to keep (handoffReason's rule).
      const handoffRecord = cliStarted ? handoffSync({ workspace, task: args.task, runId: live.runId, reason: 'signal',
        exitCode: null, signal, finalText: live.finalText, git: gitSync(workspace) }) : null;
      const node = {
        schemaVersion: 1, partial: true, runId: live.runId, liveFile: live.liveFile, finalText: live.finalText,
        nodeId: randomUUID(), parentId: args.parent ?? null, task: args.task, role: args.role,
        title: runTitle(args.title, args.prompt), phase: runPhase(args.phase, args.role), cli: route.cli, model: route.model,
        promptBytes: Buffer.byteLength(args.prompt, 'utf8'), prompt: args.prompt, prefixSha,
        exitCode: null, signal, ms: null, usageBefore, usageAfter: null, size, tokens: live.tokens, candidates,
        blocked: false, providerStop: null, score: null,
        ...(handoffRecord ? { handoff: handoffRecord } : {}),
        ...(continuation ? { continuedFrom: args.continue } : {}),
        recordedAt: new Date().toISOString(),
      };
      const treeDir = treeRoot();
      mkdirSync(treeDir, { recursive: true });
      appendFileSync(path.join(treeDir, `${args.task}.jsonl`), `${JSON.stringify(node)}\n`, 'utf8');
      partialId = node.nodeId;
    } catch (error) {
      try { process.stderr.write(`[dispatch] partial node not written: ${error?.message ?? error}\n`); } catch { /* closed */ }
    }
    live.emit({ kind: 'run.end', exitCode: null, signal, ms: null, status: 'failed', nodeId: partialId, score: null,
      dropped: live.state.dropped });
    process.kill(process.pid, signal);
  };
  for (const name of SIGNALS) process.once(name, onSignal);
  let result = null;
  let finished = false;
  let score = null;
  let nodeId = null;
  let blocked = false;
  let witnessResult = null;
  try {
    // Taken before the CLI runs, so a tree that was already dirty does not count as the CLI's work.
    const treeBefore = args.verify ? await treeState(workspace) : null;
    const cliStartedAt = Date.now();
    cliStarted = true;
    result = await run(route.cli, argv, workspace, live);
    const cliEndedAt = Date.now(); // relative provider resets ("resets in 1h 6m") add to this
    // The pane cannot see the finally: run.end lands only after the usage read and the verifier
    // (minutes, with a slow test suite), so a finished CLI would look "running" until then.
    live.emit({ kind: 'step', label: `cli.exit code=${result.code} signal=${result.signal}` });
    // The tree the CLI left, read before the verifier: a report or snapshot the verifier writes is not
    // the CLI's work.
    const treeAfter = args.verify && !result.spawnError ? await treeState(workspace) : null;
    // Codex's app-server read is account/rateLimits/read, not an inference call: reading the
    // account state itself spends no model allowance. Read before the verifier can add work.
    // Account-wide deltas can still include concurrent sessions; they are not isolated token costs.
    const usageAfter = await readRouteUsage(route);

    // The verifier is what turns an opinion into a score. Without one there is no score, and the node
    // says so rather than guessing.
    // A CLI that never started did nothing to verify: the base passing its tests is not its score.
    let verify = null;
    if (args.verify && !result.spawnError) {
      live.emit({ kind: 'step', label: 'verify.start' });
      const verified = await run('/bin/sh', ['-c', args.verify], workspace);
      live.emit({ kind: 'step', label: `verify.end code=${verified.code}` });
      verify = { command: args.verify, code: verified.code, ms: verified.ms };
      score = verified.code === 0 ? 1 : 0;
    }

    // Keep the EVIDENCE, not just the verdict: a `blocked` flag whose matching text is gone cannot be
    // checked later. And TEXT IS A HINT; THE PROVIDER'S OWN COUNTER IS THE VERDICT. A CLI that quotes
    // its instructions about rate limits, writes its reasoning to stderr and still exits 0 would trip
    // a plain regex. When the provider exposes a usage counter (usage.mjs), a text match is only
    // CONFIRMED by reading it; providers with no readable counter keep a narrower heuristic (stderr
    // on a failed run, or the CLI's own error event) and the record says it is unconfirmed.
    const decision = await decideBlocked({
      result, role: args.role, readUsage: readProviderUsage, cliError: live.state.cliErrors.join('\n'),
      // usageAfter was read at exactly the moment this decision is about.
      usageReport: usageAfter?.status === 'ok' ? { ...usageAfter, exhausted: usageAfter.ordinaryUsageAllowed === false } : null,
    });

    blocked = decision.blocked;
    const { blockedEvidence, blockedCheck, blockedBasis } = decision;

    // PS1: the provider's own window verdict, recorded beside the blocked flag it does not
    // touch. Stdout error events plus cline's stderr JSON error lines; never model text.
    const providerStop = decideProviderStop({
      result, cli: route.cli, model: route.model, runEndMs: cliEndedAt,
      cliErrorText: [...(live.state.cliErrors ?? []), ...stderrCliErrors(route.cli, result.stderr)].join('\n'),
    });

    // A verifier that passes on an UNCHANGED tree proves nothing about the developer — it proves the
    // base was green (a run cut off by its quota before writing a byte would score 1 that way).
    // A CLI that failed before writing a byte (a missing model, a crash) would score 1 the same way,
    // and so would one that exited 0 having done nothing. Any run that left the tree as it was, or
    // whose tree git cannot read, is unscored, not passed.
    if (score !== null && (treeBefore === null || treeAfter === null || treeAfter === treeBefore)) score = null;

    // The witness: the CLI's closing claims checked against its own trace. It reports and never
    // decides — score, status and exit code above are final — and its throw costs only itself.
    try {
      const said = claimsOf(live.finalText);
      // Read only when a claim needs it. --verify already read the tree on both sides; without it the
      // tree is read once, after: a tree dirty before the run counts as changed, and so does a HEAD
      // committed since the CLI started (a CLI that committed everything leaves a clean tree).
      // The commits made during the run (full shas), or null when git could not say. A sha merely in
      // the object store (main's HEAD, another branch) was not committed by this CLI.
      // ponytail: by commit time, not HEAD at start: a forged GIT_COMMITTER_DATE, or someone else
      // committing in this worktree during the run, passes.
      const madeDuringRun = async () => {
        const listed = await run('git', ['rev-list', `--max-age=${Math.floor(cliStartedAt / 1000)}`, '--max-count=1000', 'HEAD'], workspace);
        return listed.code === 0 ? listed.stdout.split('\n').filter(Boolean) : null;
      };
      let made;
      let changedFiles = null;
      if (said.done && args.verify) changedFiles = treeBefore === null || treeAfter === null ? null : changedLines(treeBefore, treeAfter);
      else if (said.done && !result.spawnError) {
        const after = await treeState(workspace);
        if (after !== null) {
          made = await madeDuringRun();
          const dirty = changedLines('', after);
          // A clean tree is no change only once git said no commit was made either.
          changedFiles = dirty === 0 && made === null ? null : dirty + (made?.length ? 1 : 0);
        }
      }
      if (said.commits.length && made === undefined) made = await madeDuringRun();
      witnessResult = witness(live.events, live.finalText, {
        verify, changedFiles, testCommandPattern: policy.testCommandPattern ?? null,
        commitExists: sha => (made ? made.some(full => full.startsWith(sha)) : undefined),
      });
    } catch (error) {
      witnessResult = { v: 1, error: String(error) };
    }
    // Q7: a run that started and failed keeps its work as a WIP commit on the feature branch. Its
    // git failure is recorded in the handoff, never the dispatch's; exit 0 unblocked adds no field.
    const reason = handoffReason({ result, blocked, providerStop });
    finishing = true;
    const handoffRecord = reason && await handoff({ workspace, task: args.task, runId: live.runId, reason,
      exitCode: result.code, resetsAt: providerStop?.resetsAt ?? null, finalText: live.finalText,
      git: (gitArgs, timeoutMs) => run('git', gitArgs, workspace, null, timeoutMs) });
    const node = {
      schemaVersion: 1,
      runId: live.runId,
      liveFile: live.liveFile,
      finalText: live.finalText,
      nodeId: randomUUID(),
      parentId: args.parent ?? null,
      task: args.task,
      role: args.role,
      title: runTitle(args.title, args.prompt),
      phase: runPhase(args.phase, args.role),
      cli: route.cli,
      model: route.model,
      promptBytes: Buffer.byteLength(args.prompt, 'utf8'),
      prompt: args.prompt,
      // Additive: sha256(--prompt) first 12 hex, the run.start's prefixSha.
      prefixSha,
      exitCode: result.code,
      signal: result.signal,
      ms: result.ms,
      candidates,
      usageBefore,
      usageAfter,
      usageDelta: usageDelta(usageBefore, usageAfter, route.cli, result.ms),
      // Q6, additive (older nodes lack all three): one delta per scoped window kind (5h and weekly
      // apart), the lead's --size (null when omitted), and the run's summed token totals (null when
      // the CLI emitted no usage events, e.g. muse).
      usageDeltas: usageDeltas(usageBefore, usageAfter, route.cli, result.ms),
      size,
      tokens: live.tokens,
      // `blocked` is observed from the provider's own words, so later analysis can tell "this route
      // failed the task" apart from "this route never ran". They are not the same evidence.
      blocked,
      blockedEvidence,
      // How `blocked` was decided. A bare flag is unfalsifiable later; this says whether the
      // provider's counter confirmed the transcript or contradicted it.
      blockedCheck,
      // Which route set `blocked` (decideBlocked); null when not blocked. Additive: older nodes
      // lack it, and their blockedCheck text keeps its meaning.
      blockedBasis,
      // PS1: the provider's own window stop ({ provider, resetsAt, evidence }), or null.
      // Additive like blockedBasis: older nodes lack it, and lack of it means no verdict.
      providerStop,
      score,
      verify,
      stdoutTail: result.stdout.slice(-4000),
      stderrTail: result.stderr.slice(-2000),
      // The CLI's claims against its own trace (witness.mjs); {v, error} when it threw.
      witness: witnessResult,
      ...(handoffRecord ? { handoff: handoffRecord } : {}),
      // Q9: the node this run resumed (--continue); absent on a fresh run.
      ...(continuation ? { continuedFrom: args.continue } : {}),
      recordedAt: new Date().toISOString(),
    };

    const treeDir = treeRoot();
    await mkdir(treeDir, { recursive: true });
    await appendFile(path.join(treeDir, `${args.task}.jsonl`), `${JSON.stringify(node)}\n`, 'utf8');

    nodeId = node.nodeId;
    process.stdout.write(`${live.finalText ?? '[dispatch] no assistant message'}\n`);
    if (blocked) process.stderr.write(`\n[dispatch] ${route.cli} ${BLOCKED_LABEL[blockedBasis] ?? 'blocked'}: ${blockedCheck}\n`);
    else if (blockedEvidence) process.stderr.write(`\n[dispatch] ${route.cli} transcript matched usage-limit wording but it was NOT a refusal: ${blockedCheck}\n`);
    if (result.spawnError) {
      process.stderr.write(`[dispatch] could not start ${route.cli}: ${result.stderr}\n`);
      process.exitCode = 2;
    } else if (result.code !== 0) {
      const last = result.stderr.trim().split('\n').at(-1) ?? '';
      process.stderr.write(`[dispatch] ${route.cli} exited ${result.code}${last ? `: ${paneLabel(last, 300)}` : ''}\n`);
    }
    if (score === 0) process.exitCode = 1;
    finished = true;
  } finally {
    for (const name of SIGNALS) process.removeListener(name, onSignal);
    if (!ended) live.emit({ kind: 'run.end', exitCode: result?.code ?? null, signal: result?.signal ?? null,
      ms: result?.ms ?? null,
      status: !finished ? 'dispatch-error' : result?.spawnError ? 'spawn-error' : blocked ? 'blocked' : result?.code === 0 ? 'completed' : 'failed',
      nodeId, score, dropped: live.state.dropped,
      // Codes only: the text stays in the tree. Absent when the witness never ran or threw — an
      // empty list would say "witnessed, clean".
      ...(Array.isArray(witnessResult?.findings) ? { witness: { findings: witnessResult.findings.map(f => f.code) } } : {}) });
    ended = true;
    process.stderr.write(`[dispatch] node ${nodeId ?? 'unknown'} role=${args.role} cli=${route.cli} exit=${result?.code ?? 'unknown'} ms=${result?.ms ?? 'unknown'} score=${score ?? 'unknown'} eventWriteErrors=${live.errors}\n`);
  }
}

// Only dispatch when RUN. This module also exports decideBlocked and main so they can be tested
// without a live provider, and importing it must not spawn a CLI or fail on missing arguments.
// pathToFileURL rather than a `file://` template: it survives spaces and Windows paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`[dispatch] ${error.message}\n`);
    process.exitCode = 2;
  });
}
