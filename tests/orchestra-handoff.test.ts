import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { handoff, handoffReason } from '../dispatcher/handoff.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { main, run as runChild } from '../dispatcher/dispatch.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { EXAMPLE_PLANS } from '../dispatcher/plans.mjs';

// Q7: a failed run keeps its work as a WIP commit on the feature branch and says so on the node.
// Real git, TEMP repos only (under os.tmpdir(), removed after each test); never this repo.

let dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A temp repo isolated from the user's global config: own identity, no signing, own hooks dir. */
function repo(branch = 'feature/x') {
  const dir = temp('orchestra-handoff-repo-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'T');
  sh(dir, 'config', 'user.email', 't@example.invalid');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'core.hooksPath', '.git/hooks');
  writeFileSync(path.join(dir, 'README'), 'base\n');
  sh(dir, 'add', 'README');
  sh(dir, 'commit', '-q', '-m', 'base');
  if (branch !== 'main') sh(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

/** The dispatcher's own files and a developer's work, as a failed run leaves them. */
function dirty(dir: string) {
  writeFileSync(path.join(dir, 'work.txt'), 'half done\n');
  mkdirSync(path.join(dir, 'orchestra', 'live'), { recursive: true });
  writeFileSync(path.join(dir, 'orchestra', 'live', 'run.jsonl'), '{}\n');
  mkdirSync(path.join(dir, 'orchestra', 'tree'), { recursive: true });
  writeFileSync(path.join(dir, 'orchestra', 'tree', 't.jsonl'), '{}\n');
  writeFileSync(path.join(dir, '.orchestra-last.md'), 'last\n');
  mkdirSync(path.join(dir, 'node_modules', 'p'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'p', 'i.js'), '\n');
}

const realGit = (cwd: string) => async (args: string[], timeoutMs: number) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
};

const base = { task: 'fix-parser', runId: 'run-123', reason: 'exit', exitCode: 3, resetsAt: null, finalText: 'stopped here' };
const run = (dir: string, extra = {}) => handoff({ ...base, workspace: dir, git: realGit(dir), ...extra });

describe('handoffReason', () => {
  it('is null for a run that never started or exited 0 unblocked', () => {
    expect(handoffReason({ result: { code: 0, spawnError: false }, blocked: false, providerStop: null })).toBeNull();
    expect(handoffReason({ result: { code: null, spawnError: true }, blocked: false, providerStop: null })).toBeNull();
    expect(handoffReason({ result: { code: 1, spawnError: true }, blocked: true, providerStop: null })).toBeNull();
  });
  it('orders limit over blocked over exit', () => {
    expect(handoffReason({ result: { code: 1, spawnError: false }, blocked: true, providerStop: { resetsAt: null } })).toBe('limit');
    expect(handoffReason({ result: { code: 1, spawnError: false }, blocked: true, providerStop: null })).toBe('blocked');
    expect(handoffReason({ result: { code: 0, spawnError: false }, blocked: true, providerStop: null })).toBe('blocked');
    expect(handoffReason({ result: { code: 2, spawnError: false }, blocked: false, providerStop: null })).toBe('exit');
  });
});

describe('handoff on real temp repos', () => {
  it('commits the work on a feature branch with the trailer, excluding the dispatcher files', async () => {
    const dir = repo();
    const before = sh(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    const h = await run(dir);
    expect(h).toMatchObject({ v: 1, reason: 'exit', exitCode: 3, signal: null, resetsAt: null, branch: 'feature/x',
      worktree: dir, base: before, commitSkipped: null, finalTextTail: 'stopped here' });
    expect(h.commit).toBe(sh(dir, 'rev-parse', 'HEAD'));
    expect(sh(dir, 'rev-parse', 'HEAD~1')).toBe(before);
    expect(sh(dir, 'log', '-1', '--format=%s')).toBe('wip(fix-parser): exit');
    expect(sh(dir, 'log', '-1', '--format=%(trailers:key=Ocli-Handoff,valueonly)')).toBe('run-123');
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['work.txt']);
    expect(h.changed).toEqual(['?\twork.txt']);
    expect(Number.isFinite(Date.parse(h.at))).toBe(true);
    // The dispatcher's files are still on disk, just not committed.
    expect(readFileSync(path.join(dir, 'orchestra', 'live', 'run.jsonl'), 'utf8')).toBe('{}\n');
  });

  it('never commits on main', async () => {
    const dir = repo('main');
    const before = sh(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    const h = await run(dir);
    expect(h).toMatchObject({ branch: 'main', commit: null, commitSkipped: 'default-branch', base: before });
    expect(h.changed).toEqual(['?\twork.txt']);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('never commits on master or the remote HEAD branch', async () => {
    const master = repo('master');
    dirty(master);
    expect((await run(master)).commitSkipped).toBe('default-branch');
    const trunk = repo('trunk');
    sh(trunk, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    sh(trunk, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const before = sh(trunk, 'rev-parse', 'HEAD');
    dirty(trunk);
    expect((await run(trunk)).commitSkipped).toBe('default-branch');
    expect(sh(trunk, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('never commits on the HEAD branch of a remote not named origin', async () => {
    const trunk = repo('trunk');
    sh(trunk, 'update-ref', 'refs/remotes/upstream/trunk', 'HEAD');
    sh(trunk, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/trunk');
    const before = sh(trunk, 'rev-parse', 'HEAD');
    dirty(trunk);
    expect(await run(trunk)).toMatchObject({ branch: 'trunk', commit: null, commitSkipped: 'default-branch' });
    expect(sh(trunk, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('leaves an excluded path the CLI already staged out of the commit, and still staged', async () => {
    const dir = repo('main');
    mkdirSync(path.join(dir, 'orchestra', 'tree'), { recursive: true });
    writeFileSync(path.join(dir, 'orchestra', 'tree', 't.jsonl'), 'old\n');
    sh(dir, 'add', 'orchestra/tree/t.jsonl');
    sh(dir, 'commit', '-q', '-m', 'track the tree');
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(path.join(dir, 'orchestra', 'tree', 't.jsonl'), 'new\n');
    sh(dir, 'add', '-A'); // as a CLI running `git add -A` would
    writeFileSync(path.join(dir, 'work.txt'), 'half done\n');
    const h = await run(dir);
    expect(h.commitSkipped).toBeNull();
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['work.txt']);
    expect(h.changed).toEqual(['?\twork.txt']);
    expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('orchestra/tree/t.jsonl');
  });

  it('never commits a nested node_modules', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'work.txt'), 'x\n');
    mkdirSync(path.join(dir, 'pkg', 'node_modules', 'p'), { recursive: true });
    writeFileSync(path.join(dir, 'pkg', 'node_modules', 'p', 'i.js'), '\n');
    const h = await run(dir);
    expect(h.changed).toEqual(['?\twork.txt']);
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['work.txt']);
  });

  it('labels a commit failure with no hook to blame git-failed, not hook-refused', async () => {
    const dir = repo();
    sh(dir, 'config', '--unset', 'user.name');
    sh(dir, 'config', '--unset', 'user.email');
    sh(dir, 'config', 'user.useConfigOnly', 'true');
    const before = sh(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    const h = await handoff({ ...base, workspace: dir, git: async (args: string[], ms: number) => {
      // The user's global identity must not rescue the commit: no global or system config.
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: ms,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' } });
      return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false };
    } });
    expect(h.commit).toBeNull();
    expect(h.commitSkipped).toMatch(/^git-failed: /);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('never commits on a detached HEAD', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '--detach');
    const before = sh(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    const h = await run(dir);
    expect(h).toMatchObject({ branch: null, commit: null, commitSkipped: 'detached' });
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('records a clean tree (dispatcher files alone are clean)', async () => {
    const dir = repo();
    const before = sh(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    rmSync(path.join(dir, 'work.txt'));
    const h = await run(dir);
    expect(h).toMatchObject({ commit: null, commitSkipped: 'clean-tree', changed: [] });
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('records a refusing pre-commit hook and leaves the tree dirty', async () => {
    const dir = repo();
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho nope-from-hook >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = sh(dir, 'rev-parse', 'HEAD');
    dirty(dir);
    const h = await run(dir);
    expect(h.commit).toBeNull();
    expect(h.commitSkipped).toMatch(/^hook-refused: .*nope-from-hook/);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(dir, 'status', '--porcelain')).toContain('work.txt');
  });

  it('records a --root outside any git work tree', async () => {
    const dir = temp('orchestra-handoff-nogit-');
    writeFileSync(path.join(dir, 'work.txt'), 'x\n');
    expect(await run(dir)).toMatchObject({ branch: null, worktree: null, base: null, commit: null,
      commitSkipped: 'not-git', changed: [] });
  });

  it('records a git call that timed out, never throwing', async () => {
    const dir = repo();
    dirty(dir);
    const git = realGit(dir);
    const h = await handoff({ ...base, workspace: dir,
      git: async (args: string[], ms: number) => (args.includes('commit') ? { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true } : git(args, ms)) });
    expect(h).toMatchObject({ commit: null, commitSkipped: 'timeout' });
  });

  it('runs every git call with core.fsmonitor=false and never --no-verify', async () => {
    const dir = repo();
    dirty(dir);
    const calls: string[][] = [];
    const git = realGit(dir);
    await handoff({ ...base, workspace: dir, git: (args: string[], ms: number) => { calls.push(args); return git(args, ms); } });
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
    expect(calls.flat()).not.toContain('--no-verify');
    expect(calls.flat()).not.toContain('-n');
  });

  it('caps changed at 200 lines and finalTextTail at 2000 chars', async () => {
    const dir = repo();
    for (let i = 0; i < 205; i++) writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}`), 'x\n');
    const h = await run(dir, { finalText: 'a'.repeat(2500) + 'END' });
    expect(h.changed).toHaveLength(200);
    expect(h.finalTextTail).toHaveLength(2000);
    expect(h.finalTextTail.endsWith('END')).toBe(true);
  });
});

describe('run() timeout', () => {
  it('SIGKILLs a child past timeoutMs and says timedOut', async () => {
    const r = await runChild('/bin/sh', ['-c', 'sleep 5'], temp('orchestra-handoff-run-'), null, 50);
    expect(r).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(r.ms).toBeLessThan(4000);
  });
});

describe('dispatch wiring (real spawn of a /bin/sh fake CLI)', () => {
  let exitCode: typeof process.exitCode;
  let tree: string;
  beforeEach(() => {
    exitCode = process.exitCode;
    const env = temp('orchestra-handoff-env-');
    tree = path.join(env, 'tree');
    vi.stubEnv('ORCHESTRA_TREE_DIR', tree);
    vi.stubEnv('ORCHESTRA_LIVE_DIR', path.join(env, 'live'));
    vi.stubEnv('ORCHESTRA_RANKING_FILE', path.join(env, 'absent-ranking.json'));
    const plans = path.join(env, 'plans.json');
    copyFileSync(EXAMPLE_PLANS, plans);
    vi.stubEnv('ORCHESTRA_PLANS', plans);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  const dispatch = async (dir: string, script: string) => {
    const policy = path.join(path.dirname(tree), 'policy.json');
    writeFileSync(policy, JSON.stringify({ routes: { fake: { cli: '/bin/sh', model: 'fake', status: 'ok', argv: ['-c', script] } } }));
    vi.stubEnv('ORCHESTRA_POLICY', policy);
    await main(['--role', 'fake', '--task', 'q7-wiring', '--prompt', 'p', '--root', dir]);
    return readFileSync(path.join(tree, 'q7-wiring.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  };
  const work = 'echo half > work.txt; mkdir -p orchestra/live; echo j > orchestra/live/x.jsonl';

  it('a non-zero exit leaves a WIP commit and a handoff on the node', async () => {
    const dir = repo();
    const before = sh(dir, 'rev-parse', 'HEAD');
    const [node] = await dispatch(dir, `${work}; exit 3`);
    expect(node.handoff).toMatchObject({ v: 1, reason: 'exit', exitCode: 3, signal: null, branch: 'feature/x',
      base: before, commitSkipped: null });
    expect(node.handoff.commit).toBe(sh(dir, 'rev-parse', 'HEAD'));
    expect(sh(dir, 'log', '-1', '--format=%(trailers:key=Ocli-Handoff,valueonly)')).toBe(node.runId);
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('work.txt');
  });

  it('exit 0 and not blocked: no handoff field, no commit', async () => {
    const dir = repo();
    const before = sh(dir, 'rev-parse', 'HEAD');
    const [node] = await dispatch(dir, `${work}; exit 0`);
    expect(node.exitCode).toBe(0);
    expect('handoff' in node).toBe(false);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
  });
});
