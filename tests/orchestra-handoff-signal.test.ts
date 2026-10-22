import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// The full-roster plans the suites run on (the shipped starter is provider-plans.example.json).
const EXAMPLE_PLANS: string = fileURLToPath(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url));

// Q8: a signal (Ctrl-C, a kill, a closed terminal) keeps the run's work like a failed exit does:
// dispatch.mjs runs as a real subprocess with a fake CLI that sleeps, in TEMP dirs and a TEMP repo
// only (removed after the test); never this repo, its orchestra/tree/ or orchestra/live/.

const DISPATCH = fileURLToPath(new URL('../dispatcher/dispatch.mjs', import.meta.url));
let dirs: string[] = [];
// Every process a test started that could outlive it (fake CLIs, hook sleepers): SIGKILLed after.
let pids: number[] = [];
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  pids = [];
});

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A temp repo on a feature branch, isolated from the user's global config. */
function repo() {
  const dir = temp('orchestra-signal-repo-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'T');
  sh(dir, 'config', 'user.email', 't@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'core.hooksPath', '.git/hooks');
  writeFileSync(path.join(dir, 'README'), 'base\n');
  sh(dir, 'add', 'README');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

const waitFor = async (check: () => boolean, ms = 8000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const readPid = (file: string) => Number(readFileSync(file, 'utf8').trim());

/** A fake CLI: records its pid, does its work, optionally ignores SIGTERM, then sleeps or exits. */
function fakeCli(env: string, { ignoreTerm = false, exitCode = null as number | null } = {}) {
  const cli = path.join(env, 'fake-cli.mjs');
  writeFileSync(cli, [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    // The handler goes in before the pid file the test waits on: under load a SIGTERM sent between the two would
    // kill the CLI outright and the SIGKILL-after-grace test would measure the wrong path.
    ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
    `writeFileSync(${JSON.stringify(path.join(env, 'cli.pid'))}, String(process.pid));`,
    "mkdirSync('orchestra/live', { recursive: true });",
    "writeFileSync('orchestra/live/x.jsonl', 'j\\n');",
    "writeFileSync('work.txt', 'half\\n');",
    exitCode === null ? 'setTimeout(() => {}, 30000);' : `process.exit(${exitCode});`,
  ].join('\n'));
  return cli;
}

/** A pre-commit hook that records its pid, then sleeps (exec: the recorded pid IS the sleeper). */
function sleepingHook(dir: string, env: string, seconds: number) {
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\necho $$ > ${JSON.stringify(path.join(env, 'hook.pid'))}\nexec sleep ${seconds}\n`);
  chmodSync(hook, 0o755);
}

/** dispatch.mjs as a real subprocess on route `fake` (node + `cli`), temp tree/live dirs only. */
function dispatch(dir: string, env: string, cli: string, { extraEnv = {} as NodeJS.ProcessEnv, extraArgs = [] as string[] } = {}) {
  const policy = path.join(env, 'policy.json');
  writeFileSync(policy, JSON.stringify({ routes: { fake: { cli: process.execPath, model: 'fake', status: 'ok', argv: [cli] } } }));
  const tree = path.join(env, 'tree');
  const liveDir = path.join(env, 'live');
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ORCHESTRA_TREE_DIR: tree, ORCHESTRA_LIVE_DIR: liveDir,
    ORCHESTRA_POLICY: policy, ORCHESTRA_PLANS: EXAMPLE_PLANS, ORCHESTRA_RANKING_FILE: path.join(env, 'absent-ranking.json'),
    ...extraEnv };
  delete childEnv.OPEN_AGENT_SKILLS_DB;
  delete childEnv.OPEN_AGENT_REGISTRY_DB;
  const child = spawn(process.execPath, [DISPATCH, '--role', 'fake', '--task', 'q8', '--prompt', 'p', '--root', dir, ...extraArgs],
    { cwd: env, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  pids.push(child.pid!);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.on('close', (code, signal) => resolve({ code, signal })));
  /** The exit, or a throw past `ms`: a hang must fail fast, not at the vitest timeout. */
  const exited = (ms: number) => Promise.race([closed, new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`dispatch still running after ${ms} ms: ${stderr}`)), ms).unref())]);
  const nodes = () => existsSync(path.join(tree, 'q8.jsonl'))
    ? readFileSync(path.join(tree, 'q8.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const events = (runId: string) => readFileSync(path.join(liveDir, 'q8', `${runId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const runEnds = () => readdirSync(path.join(liveDir, 'q8')).filter(file => !file.endsWith('.raw.jsonl')).flatMap(file =>
    readFileSync(path.join(liveDir, 'q8', file), 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(e => e.kind === 'run.end');
  return { child, stderr: () => stderr, exited, nodes, events, runEnds };
}

it('SIGTERM mid-run: dies by SIGTERM, leaves a WIP commit and a partial node that run.end names', async () => {
  const dir = repo();
  const before = sh(dir, 'rev-parse', 'HEAD');
  const env = temp('orchestra-signal-env-');
  const run = dispatch(dir, env, fakeCli(env));
  await waitFor(() => existsSync(path.join(dir, 'work.txt')) && existsSync(path.join(env, 'cli.pid')))
    .catch(() => { throw new Error(`the fake CLI never started: ${run.stderr()}`); });
  pids.push(readPid(path.join(env, 'cli.pid')));
  const signalledAt = Date.now();
  run.child.kill('SIGTERM');
  const exit = await run.exited(15_000);
  expect(exit, run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
  // A dead child is an unreaped zombie inside the sync handler: a kill(pid, 0) poll alone would wait
  // the whole 5 s grace before every exit.
  expect(Date.now() - signalledAt).toBeLessThan(4000);

  const nodes = run.nodes();
  expect(nodes).toHaveLength(1);
  const [node] = nodes;
  expect(node).toMatchObject({ partial: true, exitCode: null, signal: 'SIGTERM', task: 'q8', role: 'fake', cli: process.execPath });
  expect(node.handoff).toMatchObject({ v: 1, reason: 'signal', exitCode: null, signal: 'SIGTERM', branch: 'feature/x',
    worktree: dir, base: before, commitSkipped: null });
  expect(node.handoff.commit).toBe(sh(dir, 'rev-parse', 'HEAD'));
  expect(sh(dir, 'rev-parse', 'HEAD~1')).toBe(before);
  expect(sh(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x');
  expect(sh(dir, 'log', '-1', '--format=%s')).toBe('wip(q8): signal');
  expect(sh(dir, 'log', '-1', '--format=%(trailers:key=Ocli-Handoff,valueonly)')).toBe(node.runId);
  // The dispatcher's own files stay out of the commit on the signal path too.
  expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('work.txt');

  const events = run.events(node.runId);
  expect(events.filter(e => e.kind === 'run.end')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ kind: 'run.end', status: 'failed', signal: 'SIGTERM', exitCode: null, nodeId: node.nodeId });
}, 30_000);

it('a signalled --continue run: the partial node names the node it continued (Q9)', async () => {
  const dir = repo();
  const env = temp('orchestra-signal-env-');
  mkdirSync(path.join(env, 'tree'), { recursive: true });
  writeFileSync(path.join(env, 'tree', 'hist.jsonl'), `${JSON.stringify({ schemaVersion: 1, nodeId: 'prior-1', task: 'q8',
    role: 'fake', handoff: { v: 1, reason: 'limit', worktree: dir, commit: null, commitSkipped: 'x', changed: [] } })}\n`);
  const run = dispatch(dir, env, fakeCli(env), { extraArgs: ['--continue', 'prior-1'] });
  await waitFor(() => existsSync(path.join(dir, 'work.txt')) && existsSync(path.join(env, 'cli.pid')))
    .catch(() => { throw new Error(`the fake CLI never started: ${run.stderr()}`); });
  pids.push(readPid(path.join(env, 'cli.pid')));
  run.child.kill('SIGTERM');
  expect(await run.exited(15_000), run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
  const [node] = run.nodes();
  expect(node).toMatchObject({ partial: true, signal: 'SIGTERM', continuedFrom: 'prior-1' });
}, 30_000);

it('a CLI that ignores SIGTERM is SIGKILLed after the grace, and the hand-off still lands', async () => {
  const dir = repo();
  const env = temp('orchestra-signal-env-');
  const run = dispatch(dir, env, fakeCli(env, { ignoreTerm: true }), { extraEnv: { ORCHESTRA_SIGNAL_GRACE_MS: '1000' } });
  await waitFor(() => existsSync(path.join(dir, 'work.txt')) && existsSync(path.join(env, 'cli.pid')))
    .catch(() => { throw new Error(`the fake CLI never started: ${run.stderr()}`); });
  const cliPid = readPid(path.join(env, 'cli.pid'));
  pids.push(cliPid);
  const signalledAt = Date.now();
  run.child.kill('SIGTERM');
  expect(await run.exited(8000), run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
  const ms = Date.now() - signalledAt;
  expect(ms).toBeGreaterThanOrEqual(900); // waited the grace: SIGTERM alone did not stop it
  expect(ms).toBeLessThan(5000);
  // SIGKILLed, not left running: an orphan would keep writing into the hand-off's tree. (Reaped by
  // launchd once dispatch dies, so poll.)
  await waitFor(() => gone(cliPid), 3000).catch(() => { throw new Error(`the fake CLI ${cliPid} outlived dispatch`); });
  const [node] = run.nodes();
  expect(node).toMatchObject({ partial: true, signal: 'SIGTERM' });
  expect(node.handoff.commit).toBe(sh(dir, 'rev-parse', 'HEAD'));
}, 30_000);

it('a hanging git hook cannot hold the signal path: the hand-off gives up inside its budget', async () => {
  const dir = repo();
  const before = sh(dir, 'rev-parse', 'HEAD');
  const env = temp('orchestra-signal-env-');
  sleepingHook(dir, env, 60);
  // Load-robust (CI): a 1.5 s budget could expire before git even reached the hook on a busy
  // runner, failing the "the commit did reach the hook" check. 3 s still proves the point against a
  // 60 s hook; the wall-clock bounds below scale with it.
  const run = dispatch(dir, env, fakeCli(env), { extraEnv: { ORCHESTRA_SIGNAL_HANDOFF_MS: '3000' } });
  await waitFor(() => existsSync(path.join(dir, 'work.txt')) && existsSync(path.join(env, 'cli.pid')))
    .catch(() => { throw new Error(`the fake CLI never started: ${run.stderr()}`); });
  pids.push(readPid(path.join(env, 'cli.pid')));
  const signalledAt = Date.now();
  run.child.kill('SIGTERM');
  try {
    expect(await run.exited(15_000), run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
  } finally {
    if (existsSync(path.join(env, 'hook.pid'))) pids.push(readPid(path.join(env, 'hook.pid')));
  }
  // Below the 10 s default budget, so an ignored ORCHESTRA_SIGNAL_HANDOFF_MS still fails here.
  expect(Date.now() - signalledAt).toBeLessThan(9_000);
  expect(existsSync(path.join(env, 'hook.pid'))).toBe(true); // the commit did reach the hook
  const [node] = run.nodes();
  expect(node).toMatchObject({ partial: true, signal: 'SIGTERM' });
  expect(node.handoff.commit).toBeNull();
  expect(node.handoff.commitSkipped).toMatch(/^timeout/);
  expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
}, 30_000);

it('a signal before the CLI spawned hands nothing off: a tree dirty before the run is not its work', async () => {
  const dir = repo();
  const before = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'pre.txt'), 'the user\'s own dirt\n');
  const env = temp('orchestra-signal-env-');
  // A git on PATH whose porcelain-v2 status (treeState, the --verify read before the CLI) sleeps;
  // every other git call goes to the real one.
  const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(env, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'case "$*" in *porcelain=v2*)',
    `  echo $$ > ${JSON.stringify(path.join(env, 'git.pid'))}`,
    '  exec sleep 30;;',
    'esac',
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join('\n'));
  chmodSync(path.join(bin, 'git'), 0o755);
  const run = dispatch(dir, env, fakeCli(env), { extraArgs: ['--verify', 'true'],
    extraEnv: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  await waitFor(() => existsSync(path.join(env, 'git.pid')))
    .catch(() => { throw new Error(`treeState never ran: ${run.stderr()}`); });
  pids.push(readPid(path.join(env, 'git.pid')));
  run.child.kill('SIGTERM');
  expect(await run.exited(8000), run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
  expect(existsSync(path.join(env, 'cli.pid'))).toBe(false);
  const [node] = run.nodes();
  expect(node).toMatchObject({ partial: true, signal: 'SIGTERM' });
  expect(node).not.toHaveProperty('handoff');
  expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
}, 30_000);

it('a signal during the normal path\'s own hand-off neither kills that commit nor writes a second node', async () => {
  const dir = repo();
  const before = sh(dir, 'rev-parse', 'HEAD');
  const env = temp('orchestra-signal-env-');
  sleepingHook(dir, env, 1);
  // Exit 3: Q7's hand-off commits, and its pre-commit hook is where the signal lands.
  const run = dispatch(dir, env, fakeCli(env, { exitCode: 3 }));
  await waitFor(() => existsSync(path.join(env, 'hook.pid')))
    .catch(() => { throw new Error(`the Q7 commit never reached its hook: ${run.stderr()}`); });
  pids.push(readPid(path.join(env, 'hook.pid')));
  run.child.kill('SIGTERM');
  expect(await run.exited(8000), run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
  // The git commit was left to finish (it outlives dispatch by up to the hook's second).
  await waitFor(() => sh(dir, 'rev-parse', 'HEAD') !== before, 5000)
    .catch(() => { throw new Error('the Q7 commit was killed mid-flight'); });
  expect(sh(dir, 'log', '-1', '--format=%s')).toBe('wip(q8): exit');
  await waitFor(() => !existsSync(path.join(dir, '.git', 'index.lock')), 3000);
  expect(run.nodes().filter(node => node.partial)).toHaveLength(0);
  const ends = run.runEnds();
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ status: 'failed', signal: 'SIGTERM', nodeId: null });
}, 30_000);
