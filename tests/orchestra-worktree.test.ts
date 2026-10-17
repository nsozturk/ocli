import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Q10: --worktree auto. Real git against TEMP repos only (created and removed here); the CLI spawn,
// provider readers and the node append are mocked. spawnSync stays real: worktree.mjs runs git with it.
const mocks = vi.hoisted(() => ({ codex: vi.fn(), glm: vi.fn(), appendFile: vi.fn(), spawn: vi.fn() }));
vi.mock('../dispatcher/usage.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readCodexUsage: mocks.codex, readGlmUsage: mocks.glm,
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), spawn: mocks.spawn,
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  appendFileSync: vi.fn(), mkdirSync: vi.fn(),
}));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  mkdir: vi.fn(), appendFile: mocks.appendFile,
}));
// @ts-expect-error - dispatcher tooling is plain ESM.
import { main } from '../dispatcher/dispatch.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { resolveWorktree } from '../dispatcher/worktree.mjs';

const ID = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branchSha = (repo: string, b: string) => {
  try { return git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`); } catch { return null; }
};
const worktreeCount = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;

describe('--worktree auto (Q10)', () => {
  let base: string;
  let repo: string;
  let treeDir: string;
  let liveDir: string;
  let exitCode: typeof process.exitCode;
  const wtOf = (task: string) => path.join(base, 'repo.worktrees', task);

  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    // The user's global hooks and config never run against the temp repos.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'orchestra-worktree-')));
    git(base, 'init', '-q', '-b', 'main', 'repo');
    repo = path.join(base, 'repo');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    treeDir = mkdtempSync(path.join(tmpdir(), 'orchestra-worktree-tree-'));
    liveDir = mkdtempSync(path.join(tmpdir(), 'orchestra-worktree-live-'));
    vi.stubEnv('ORCHESTRA_TREE_DIR', treeDir);
    vi.stubEnv('ORCHESTRA_LIVE_DIR', liveDir);
    // Package-only: the shipped policy and ranking, never a user's gitignored dispatcher/policy.json.
    vi.stubEnv('ORCHESTRA_POLICY', fileURLToPath(new URL('../dispatcher/policy.example.json', import.meta.url)));
    vi.stubEnv('ORCHESTRA_RANKING_FILE', fileURLToPath(new URL('../dispatcher/model-ranking.example.json', import.meta.url)));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.codex.mockResolvedValue({ status: 'unknown', reason: 'mocked', windows: [] });
    mocks.glm.mockResolvedValue({ status: 'unknown', reason: 'mocked', windows: [] });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of [base, treeDir, liveDir]) rmSync(dir, { recursive: true, force: true });
  });

  describe('resolveWorktree', () => {
    it('first run creates the path and the branch from HEAD', () => {
      const head = git(repo, 'rev-parse', 'HEAD');
      const r = resolveWorktree({ root: repo, task: 'fix-a' });
      expect(r).toMatchObject({ path: wtOf('fix-a'), branch: 'ocli/fix-a', action: 'create' });
      expect(existsSync(path.join(wtOf('fix-a'), 'a.txt'))).toBe(true);
      expect(git(wtOf('fix-a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ocli/fix-a');
      expect(branchSha(repo, 'ocli/fix-a')).toBe(head);
    });

    it('resolves the git top from a subdirectory of --root', () => {
      execFileSync('mkdir', ['-p', path.join(repo, 'src', 'deep')]);
      const r = resolveWorktree({ root: path.join(repo, 'src', 'deep'), task: 'fix-a' });
      expect(r).toMatchObject({ path: wtOf('fix-a'), action: 'create' });
      expect(resolveWorktree({ root: repo, task: 'fix-a' }).action).toBe('reuse');
    });

    it('a second run reuses the worktree and creates nothing', () => {
      resolveWorktree({ root: repo, task: 'fix-a' });
      writeFileSync(path.join(wtOf('fix-a'), 'wip.txt'), 'in progress\n');
      const count = worktreeCount(repo);
      const r = resolveWorktree({ root: repo, task: 'fix-a' });
      expect(r).toMatchObject({ path: wtOf('fix-a'), action: 'reuse' });
      expect(worktreeCount(repo)).toBe(count);
      expect(readFileSync(path.join(wtOf('fix-a'), 'wip.txt'), 'utf8')).toBe('in progress\n');
    });

    it('refuses a foreign directory at the path and leaves it alone', () => {
      execFileSync('mkdir', ['-p', wtOf('fix-b')]);
      writeFileSync(path.join(wtOf('fix-b'), 'theirs.txt'), 'not ours\n');
      expect(() => resolveWorktree({ root: repo, task: 'fix-b' })).toThrow(/exists and is not the worktree of ocli\/fix-b/);
      expect(readFileSync(path.join(wtOf('fix-b'), 'theirs.txt'), 'utf8')).toBe('not ours\n');
      expect(branchSha(repo, 'ocli/fix-b')).toBeNull();
      expect(worktreeCount(repo)).toBe(1);
    });

    it('refuses a registered worktree at the path on another branch', () => {
      git(repo, 'worktree', 'add', '-q', '-b', 'other', wtOf('fix-c'));
      expect(() => resolveWorktree({ root: repo, task: 'fix-c' })).toThrow(/is not the worktree of ocli\/fix-c/);
      expect(branchSha(repo, 'ocli/fix-c')).toBeNull();
    });

    it('an existing branch keeps its tip (no -B)', () => {
      const tip = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'branch', 'ocli/fix-d');
      writeFileSync(path.join(repo, 'a.txt'), 'two\n');
      git(repo, 'commit', '-q', '-am', 'advance main');
      expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(tip);
      const r = resolveWorktree({ root: repo, task: 'fix-d' });
      expect(r.action).toBe('add');
      expect(branchSha(repo, 'ocli/fix-d')).toBe(tip);
      expect(git(wtOf('fix-d'), 'rev-parse', 'HEAD')).toBe(tip);
      expect(readFileSync(path.join(wtOf('fix-d'), 'a.txt'), 'utf8')).toBe('one\n');
    });

    it('a dry run returns the path and creates nothing', () => {
      const r = resolveWorktree({ root: repo, task: 'fix-e', dryRun: true });
      expect(r).toMatchObject({ path: wtOf('fix-e'), action: 'create', dryRun: true });
      expect(existsSync(wtOf('fix-e'))).toBe(false);
      expect(existsSync(path.join(base, 'repo.worktrees'))).toBe(false);
      expect(branchSha(repo, 'ocli/fix-e')).toBeNull();
      expect(worktreeCount(repo)).toBe(1);
    });

    it.each([['a/b'], ['../x'], ['a..b'], ['..'], ['.hidden'], [''], [undefined]])('refuses the task %j and creates nothing', task => {
      expect(() => resolveWorktree({ root: repo, task })).toThrow(/safe path segment/);
      expect(existsSync(path.join(base, 'repo.worktrees'))).toBe(false);
      expect(worktreeCount(repo)).toBe(1);
    });

    it('every git call it makes carries -c core.fsmonitor=false', () => {
      const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const log = path.join(base, 'git-argv.log');
      const shim = path.join(base, 'shim');
      execFileSync('mkdir', ['-p', shim]);
      writeFileSync(path.join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${shim}:${process.env.PATH}`);
      resolveWorktree({ root: repo, task: 'fix-g' });
      resolveWorktree({ root: repo, task: 'fix-g' });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      expect(calls.length).toBeGreaterThanOrEqual(5);
      for (const call of calls) expect(call.startsWith('-c core.fsmonitor=false ')).toBe(true);
    });

    it('refuses a registered worktree whose directory is gone, and prunes nothing', () => {
      resolveWorktree({ root: repo, task: 'fix-h' });
      const tip = branchSha(repo, 'ocli/fix-h');
      rmSync(wtOf('fix-h'), { recursive: true, force: true });
      expect(() => resolveWorktree({ root: repo, task: 'fix-h' })).toThrow(/registered as a worktree but its directory is missing/);
      expect(existsSync(wtOf('fix-h'))).toBe(false);
      expect(worktreeCount(repo)).toBe(2);
      expect(branchSha(repo, 'ocli/fix-h')).toBe(tip);
    });

    it('refuses a --root outside any git repository', () => {
      expect(() => resolveWorktree({ root: treeDir, task: 'fix-f' })).toThrow(/not inside a git repository/);
    });
  });

  describe('dispatch', () => {
    const dispatch = (...extra: string[]) =>
      main(['--role', 'reason', '--task', 'wt-task', '--prompt', 'spec', ...extra]);
    // A missing --root falls back to process.cwd(): point it at the temp base (not a repo), so a
    // fallback can never reach the real checkout the suite runs from.
    beforeEach(() => { vi.spyOn(process, 'cwd').mockReturnValue(base); });
    const rootOf = (call = 0) => {
      const argv = mocks.spawn.mock.calls[call][1] as string[];
      return argv[argv.indexOf('-C') + 1];
    };

    it('runs the CLI in the task worktree; the tree node stays in the tree dir; nothing is removed', async () => {
      await dispatch('--worktree', 'auto', '--root', repo);
      expect(mocks.spawn).toHaveBeenCalled();
      expect(rootOf()).toBe(wtOf('wt-task'));
      expect(mocks.spawn.mock.calls[0][2]?.cwd).toBe(wtOf('wt-task'));
      expect(git(wtOf('wt-task'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ocli/wt-task');
      const nodeAppend = mocks.appendFile.mock.calls.find(call => String(call[0]).endsWith('wt-task.jsonl'));
      expect(path.dirname(String(nodeAppend?.[0]))).toBe(path.resolve(treeDir));
      expect(existsSync(wtOf('wt-task'))).toBe(true);
      expect(worktreeCount(repo)).toBe(2);
      // A second dispatch reuses it.
      await dispatch('--worktree', 'auto', '--root', repo);
      expect(worktreeCount(repo)).toBe(2);
    });

    it('--dry-run prints the path, spawns nothing and creates nothing', async () => {
      const out = vi.mocked(process.stdout.write);
      await dispatch('--worktree', 'auto', '--root', repo, '--dry-run');
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.codex).not.toHaveBeenCalled();
      expect(out.mock.calls.map(c => String(c[0])).join('')).toContain(wtOf('wt-task'));
      expect(existsSync(wtOf('wt-task'))).toBe(false);
      expect(branchSha(repo, 'ocli/wt-task')).toBeNull();
    });

    it('an unknown --role refuses before any worktree or branch is created', async () => {
      await expect(main(['--role', 'no-such-role', '--task', 'wt-task', '--prompt', 'spec', '--worktree', 'auto', '--root', repo]))
        .rejects.toThrow(/no route named no-such-role/);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(existsSync(path.join(base, 'repo.worktrees'))).toBe(false);
      expect(branchSha(repo, 'ocli/wt-task')).toBeNull();
    });

    // 'REPO' becomes the temp repo at run time: the table is built before beforeEach assigns `repo`.
    it.each([
      ['a value other than auto', ['--worktree', 'yes', '--root', 'REPO'], /--worktree takes only "auto"/],
      ['a missing value', ['--root', 'REPO', '--worktree'], /--worktree takes only "auto"/],
      ['--dry-run without --worktree', ['--root', 'REPO', '--dry-run'], /--dry-run applies only to --worktree auto/],
      ['--continue with --worktree', ['--worktree', 'auto', '--root', 'REPO', '--continue', 'x'], /--worktree and --continue/],
    ])('refuses %s and spawns nothing', async (_label, extra, message) => {
      const argv = (extra as string[]).map(a => (a === 'REPO' ? repo : a));
      expect(argv).toContain(repo);
      await expect(dispatch(...argv)).rejects.toThrow(message);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(existsSync(path.join(base, 'repo.worktrees'))).toBe(false);
      expect(branchSha(repo, 'ocli/wt-task')).toBeNull();
    });
  });
});
