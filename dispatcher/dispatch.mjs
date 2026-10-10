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
//   orchestra/tree/<task>.jsonl              one record per finished run
//
// Usage:
//   node dispatcher/dispatch.mjs --role implement --task fix-parser --prompt "..." [--verify "npm test"]
//                     [--title <what it is for>] [--phase <card phase, default: the role>]
//                     [--parent <nodeId>] [--root <dir>] [--suffix <per-run text, appended LAST for cache stability>]

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, mkdirSync } from 'node:fs';
import { normalize, createLineSplitter } from './events.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCodexUsage, readGlmUsage, claudeUsageFromLead, usageDelta, gateFor } from './usage.mjs';

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

function run(command, args, cwd, live = null) {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const splitters = { stdout: createLineSplitter(), stderr: createLineSplitter() };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      currentChild = null;
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      for (const stream of ['stdout', 'stderr']) {
        for (const line of splitters[stream].end()) live?.line(stream, line);
      }
      resolve({ code, signal, stdout, stderr: error ? String(error) : stderr,
        ms: Date.now() - started, spawnError: error !== null });
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

/** Untrusted text made safe for the pane: markdown heading marks, ANSI escapes and control
 * characters removed, whitespace folded, at most `max` code points. */
function paneLabel(source, max) {
  const text = String(source ?? '')
    .replace(/[\u001b\u009d]\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, '') // OSC, e.g. hyperlinks
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI
    // C0/C1, bidi controls (U+061C ALM among them) and the invisible U+200B/U+2060, as the pane's
    // clean() strips them; ZWNJ/ZWJ stay, scripts and emoji join with them and they reorder nothing.
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069]/g, '')
    .replace(/^\s*#+\s*/, '').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join(''); // code points, so a cut never splits a surrogate pair
}

/** What a run is for, for the pane: --title, else the prompt's first non-empty line, at most 120. */
export function runTitle(title, prompt) {
  // || not ??: an empty --title falls back to the prompt as well.
  return paneLabel(title || String(prompt ?? '').split('\n').find(line => line.trim()) || '', 120);
}

/** Which phase of the task a run belongs to, for the pane's card: --phase, cleaned like the title
 * and at most 40 code points; absent, or empty once cleaned, the route's role. */
export function runPhase(phase, role) {
  return paneLabel(phase, 40) || role;
}

function createLive(args, route, workspace) {
  const runId = randomUUID();
  // ORCHESTRA_LIVE_DIR (read per call, so tests can point it at a temp dir) moves the live root;
  // liveFile is then that absolute path, otherwise the cwd-relative one.
  const override = process.env.ORCHESTRA_LIVE_DIR;
  const file = path.join(override ? path.resolve(override) : path.resolve('orchestra', 'live'), args.task, `${runId}.jsonl`);
  const liveFile = override ? file : `orchestra/live/${args.task}/${runId}.jsonl`;
  const rawFile = file.replace(/\.jsonl$/, '.raw.jsonl');
  const state = { dropped: Object.create(null), cliErrors: [] };
  let seq = 0;
  let errors = 0;
  let finalText = null;
  const attempt = action => { try { action(); } catch { errors++; } };
  attempt(() => mkdirSync(path.dirname(file), { recursive: true }));
  // Create both per-run files even when the child produces no output.
  attempt(() => appendFileSync(file, '', LIVE_WRITE));
  attempt(() => appendFileSync(rawFile, '', LIVE_WRITE));
  const emit = (event, at = new Date().toISOString()) => {
    const record = { v: 1, runId, seq, at, task: args.task, role: args.role, cli: route.cli, ...event };
    // seq advances only once the record is on disk: a failed write must not leave a gap.
    attempt(() => { appendFileSync(file, `${JSON.stringify(record)}\n`, LIVE_WRITE); seq++; });
  };
  return {
    runId, liveFile, state, emit,
    get errors() { return errors; },
    get finalText() { return finalText; },
    start(pid) {
      emit({ kind: 'run.start', model: route.model, root: workspace, parentId: args.parent ?? null, pid,
        title: runTitle(args.title, args.prompt), phase: runPhase(args.phase, args.role) });
    },
    line(stream, line) {
      const at = new Date().toISOString();
      attempt(() => appendFileSync(rawFile, `${JSON.stringify({ at, stream, line })}\n`, LIVE_WRITE));
      if (stream === 'stdout') {
        for (const event of normalize(route.cli, line, state)) {
          if (event.kind === 'message') finalText = event.text;
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
  if (!hit) return { blocked: false, blockedEvidence: null, blockedCheck: 'no usage-limit text in the transcript' };
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
  let blockedCheck;
  if (exhausted) blockedCheck = `usage confirms exhaustion (${where})`;
  else if (refused) blockedCheck = `run failed with exit ${result.code} and limit wording, but the counter shows room (${where}) — a transient refusal, not exhaustion`;
  else blockedCheck = `TEXT MATCHED BUT NOTHING CONFIRMS IT: exit 0 and ${where} — treated as quoted text, not a refusal`;
  return { blocked, blockedEvidence, blockedCheck };
}


/** The work tree as git sees it, minus the dispatcher's own files (live, tree, codex -o) and
 * node_modules: what the developer CLI could have changed. null when it is not a readable git tree. */
async function treeState(workspace) {
  const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], workspace);
  if (status.code !== 0) return null;
  return status.stdout.split('\n')
    .filter(line => line.trim() && !/node_modules|(^|[\s/"])orchestra\/(live|tree)\/|\.orchestra-last\.md"?$/.test(line))
    .join('\n');
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

export async function main(argvInput = process.argv.slice(2)) {
  const args = parseArgs(argvInput);
  for (const required of ['role', 'task', 'prompt']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  // --task becomes a path segment under orchestra/live/ and orchestra/tree/,
  // and a CLI argv value ({task} -> opencode --title). A leading alphanumeric rules out '.', '..' and
  // a value that the CLI would parse as a flag ('--share').
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.task)) {
    throw new Error(`--task must match [A-Za-z0-9][A-Za-z0-9._-]* (got ${JSON.stringify(args.task)})`);
  }
  const workspace = path.resolve(args.root ?? process.cwd());
  // Your own dispatcher/policy.json (gitignored) wins; without one, the shipped example is used.
  const policyText = await readFile(path.join(HERE, 'policy.json'), 'utf8').catch(error => {
    if (error?.code !== 'ENOENT') throw error;
    return readFile(path.join(HERE, 'policy.example.json'), 'utf8');
  });
  const policy = JSON.parse(policyText);
  const route = policy.routes[args.role];
  if (!route) throw new Error(`no route named ${args.role}; the policy declares ${Object.keys(policy.routes).join(', ')}`);
  if (!route.argv) throw new Error(`route ${args.role} is not dispatchable (${route.note ?? 'no argv'})`);
  if (route.status !== 'ok') {
    throw new Error(
      `route ${args.role} (${route.cli}) is ${route.status}${route.verifiedAt ? ` as of ${route.verifiedAt}` : ''}: ${route.statusDetail ?? ''}\n`
      + 'Re-probe it and set status to "ok" in dispatcher/policy.json before dispatching. A known-dead provider is not retried blind.',
    );
  }

  // {root} exists for CLIs that do not honour the process cwd (agy keeps its own workspace).
  // Cache discipline: providers key their prompt cache on a byte-stable PREFIX, so the shared spec
  // (--prompt) goes first and any per-dispatch text (--suffix: workdir, parent node) goes LAST.
  const prompt = args.suffix ? `${args.prompt}\n\n${args.suffix}` : args.prompt;
  // Null prototype: {constructor} or {toString} must not find an inherited value.
  const argv = resolveArgv(route, Object.assign(Object.create(null), { model: route.model, effort: route.effort,
    variant: route.variant, task: args.task, root: workspace, prompt }));
  const usageBefore = await readRouteUsage(route);
  const live = createLive(args, route, workspace);
  process.stderr.write(`[dispatch] live: ${live.liveFile}\n`);
  // Ctrl-C or a kill: the finally below never runs, and the pane would show this run as running,
  // then stale, for a day. Write run.end, pass the signal to the CLI, then die by the same signal.
  let ended = false;
  const onSignal = signal => {
    for (const name of SIGNALS) process.removeListener(name, onSignal);
    if (ended) return;
    ended = true;
    if (currentChild?.pid) { try { process.kill(currentChild.pid, signal); } catch { /* already gone */ } }
    live.emit({ kind: 'run.end', exitCode: null, signal, ms: null, status: 'failed', nodeId: null, score: null,
      dropped: live.state.dropped });
    process.kill(process.pid, signal);
  };
  for (const name of SIGNALS) process.once(name, onSignal);
  let result = null;
  let finished = false;
  let score = null;
  let nodeId = null;
  let blocked = false;
  try {
    // Taken before the CLI runs, so a tree that was already dirty does not count as the CLI's work.
    const treeBefore = args.verify ? await treeState(workspace) : null;
    result = await run(route.cli, argv, workspace, live);
    // The pane cannot see the finally: run.end lands only after the usage read and the verifier
    // (minutes, with a slow test suite), so a finished CLI would look "running" until then.
    live.emit({ kind: 'step', label: `cli.exit code=${result.code} signal=${result.signal}` });
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
    const { blockedEvidence, blockedCheck } = decision;

    // A verifier that passes on an UNCHANGED tree proves nothing about the developer — it proves the
    // base was green (a run cut off by its quota, or a CLI that failed on a missing model, before
    // writing a byte would otherwise score 1). A blocked or failed run that left the tree as it was,
    // or whose tree git cannot read, is unscored, not passed.
    if (score !== null && (blocked || result.code !== 0)) {
      const treeAfter = await treeState(workspace);
      if (treeBefore === null || treeAfter === null || treeAfter === treeBefore) score = null;
    }
    const node = {
      schemaVersion: 1,
      runId: live.runId,
      liveFile: live.liveFile,
      finalText: live.finalText,
      nodeId: randomUUID(),
      parentId: args.parent ?? null,
      task: args.task,
      role: args.role,
      cli: route.cli,
      model: route.model,
      promptBytes: Buffer.byteLength(args.prompt, 'utf8'),
      prompt: args.prompt,
      exitCode: result.code,
      signal: result.signal,
      ms: result.ms,
      usageBefore,
      usageAfter,
      usageDelta: usageDelta(usageBefore, usageAfter, route.cli, result.ms),
      // `blocked` is observed from the provider's own words, so later analysis can tell "this route
      // failed the task" apart from "this route never ran". They are not the same evidence.
      blocked,
      blockedEvidence,
      // How `blocked` was decided. A bare flag is unfalsifiable later; this says whether the
      // provider's counter confirmed the transcript or contradicted it.
      blockedCheck,
      score,
      verify,
      stdoutTail: result.stdout.slice(-4000),
      stderrTail: result.stderr.slice(-2000),
      recordedAt: new Date().toISOString(),
    };

    const treeDir = path.resolve('orchestra', 'tree');
    await mkdir(treeDir, { recursive: true });
    await appendFile(path.join(treeDir, `${args.task}.jsonl`), `${JSON.stringify(node)}\n`, 'utf8');

    nodeId = node.nodeId;
    process.stdout.write(`${live.finalText ?? '[dispatch] no assistant message'}\n`);
    if (blocked) process.stderr.write(`\n[dispatch] ${route.cli} usage limit CONFIRMED against its counter: ${blockedCheck}\n`);
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
      nodeId, score, dropped: live.state.dropped });
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
