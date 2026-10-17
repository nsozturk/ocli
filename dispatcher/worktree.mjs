// Q10: --worktree auto. One worktree per task, beside the repo: <dirname(top)>/<basename(top)>.worktrees/<task>
// on branch ocli/<task>. Created or reused, never merged, never removed, never forced: a branch that
// already exists keeps its tip (no -B), and a path that is anything but this task's worktree is refused.

import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const GIT_TIMEOUT_MS = 30_000;

// fsmonitor off on every call: a daemon started by git in a temp or sibling tree outlives the run.
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS });
  return { code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') || String(r.error ?? '') };
}

const real = p => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/** `--task` is a path segment and half a branch name: a leading alphanumeric, no '/', no '..'. */
export function checkWorktreeTask(task) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task ?? '') || task.includes('..')) {
    throw new Error(`--worktree auto: --task must be a safe path segment [A-Za-z0-9][A-Za-z0-9._-]* without '..' (got ${JSON.stringify(task ?? null)})`);
  }
}

/** → { path, branch, action: 'reuse' | 'add' | 'create', dryRun }. A dry run reads git and creates nothing. */
export function resolveWorktree({ root, task, dryRun = false }) {
  checkWorktreeTask(task);
  const top = git(path.resolve(root), ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error(`--worktree auto: ${root} is not inside a git repository: ${top.stderr.trim()}`);
  const topDir = top.stdout.trim();
  const wtPath = path.join(path.dirname(topDir), `${path.basename(topDir)}.worktrees`, task);
  const branch = `ocli/${task}`;

  const list = git(topDir, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) throw new Error(`--worktree auto: git worktree list failed: ${list.stderr.trim()}`);
  const entry = list.stdout.split('\n\n').map(block => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch (.+)$/m)?.[1],
  })).find(e => e.path && real(e.path) === real(wtPath));

  let action;
  if (entry && entry.branch === `refs/heads/${branch}` && existsSync(wtPath)) action = 'reuse';
  else if (entry && !existsSync(wtPath)) {
    // Prunable: registered, directory gone. Pruning is the user's call, never the dispatcher's.
    throw new Error(`--worktree auto: ${wtPath} is registered as a worktree but its directory is missing; run git worktree prune (or repair) yourself`);
  } else if (entry || existsSync(wtPath)) {
    throw new Error(`--worktree auto: ${wtPath} exists and is not the worktree of ${branch}; refusing to touch it`);
  } else {
    action = git(topDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0 ? 'add' : 'create';
  }
  if (action !== 'reuse' && !dryRun) {
    const add = action === 'add'
      ? git(topDir, ['worktree', 'add', wtPath, branch])
      : git(topDir, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    if (add.code !== 0) throw new Error(`--worktree auto: git worktree add failed: ${add.stderr.trim()}`);
  }
  return { path: wtPath, branch, action, dryRun };
}
