// Q7: a failed run keeps its work. When the developer CLI started and the run ends with a non-zero
// exit, `blocked`, or a provider stop, whatever it left in the workspace becomes a WIP commit on the
// feature branch, and the node records where that work now is, so the next developer starts from it.
//
// Three rules it will not bend:
//   1. Never on the default branch (main, master, the remote HEAD) or a detached HEAD.
//   2. Hooks are never bypassed: a refusing hook is recorded, not retried, and the tree stays dirty.
//   3. A git failure never fails the dispatch: it is recorded in commitSkipped.

import { accessSync, constants } from 'node:fs';
import * as path from 'node:path';

// The dispatcher's own files and node_modules at any depth are never the developer's work (the
// treeState set). The commit takes the same pathspec, so an excluded path the CLI already staged
// stays staged and out of the commit.
const PATHSPEC = ['--', '.', ':(exclude)orchestra/live', ':(exclude)orchestra/tree', ':(exclude).orchestra-last.md',
  ':(exclude)node_modules', ':(exclude,glob)**/node_modules/**'];
// The hooks that can refuse a commit. A failure with none of them executable is git's own.
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
const GIT_TIMEOUT_MS = 10_000;
// A pre-commit hook may run a linter; killing it mid-commit would leave index.lock behind.
const COMMIT_TIMEOUT_MS = 60_000;
const MAX_CHANGED = 200;
const MAX_TAIL = 2000;

/** Why this run hands off, or null when it does not: limit > blocked > exit. A CLI that never
 * started left nothing to keep. */
export function handoffReason({ result, blocked, providerStop }) {
  if (!result || result.spawnError) return null;
  if (providerStop) return 'limit';
  if (blocked) return 'blocked';
  if (typeof result.code === 'number' && result.code !== 0) return 'exit';
  return null;
}

class Skip extends Error {}

/**
 * The hand-off record, after committing if allowed. `git(args, timeoutMs)` runs git in `workspace`
 * and resolves { code, stdout, stderr, timedOut }; it is injected so dispatch routes it through its
 * own `run` (the signal-tracked child). Never throws.
 */
export async function handoff(options) {
  const steps = handoffSteps(options);
  let step = steps.next();
  while (!step.done) {
    let result;
    try { result = await options.git(...step.value); } catch (error) { step = steps.throw(error); continue; }
    step = steps.next(result);
  }
  return step.value;
}

/** Q8: the same hand-off from a signal handler, where nothing may await: `git` returns the result
 * synchronously (spawnSync). Never throws. */
export function handoffSync(options) {
  const steps = handoffSteps(options);
  let step = steps.next();
  while (!step.done) {
    let result;
    try { result = options.git(...step.value); } catch (error) { step = steps.throw(error); continue; }
    step = steps.next(result);
  }
  return step.value;
}

/** The hand-off as a sequence of git calls: yields [args, timeoutMs], receives the result. One body
 * for both drivers, so the async and the signal path cannot drift apart. */
function* handoffSteps({ workspace, task, runId, reason, exitCode, signal = null, resetsAt = null, finalText }) {
  const out = { v: 1, reason, exitCode, signal, resetsAt, branch: null, worktree: null, base: null,
    commit: null, commitSkipped: null, changed: [],
    finalTextTail: finalText == null ? null : String(finalText).slice(-MAX_TAIL), at: null };
  // core.fsmonitor in the repo config is a command git runs; the CLI could have written it.
  const call = function* (args, ms = GIT_TIMEOUT_MS) {
    const result = yield [['-c', 'core.fsmonitor=false', ...args], ms];
    if (result.timedOut) throw new Skip('timeout');
    return result;
  };
  const must = function* (args) {
    const result = yield* call(args);
    if (result.code !== 0) throw new Skip(`git-failed: ${firstLine(result.stderr) || `git ${args[0]} exited ${result.code}`}`);
    return result.stdout.trim();
  };
  try {
    const inside = yield* call(['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Skip('not-git');
    out.worktree = yield* must(['rev-parse', '--show-toplevel']);
    out.base = yield* must(['rev-parse', 'HEAD']);
    // ponytail: porcelain v1 without -z, so a C-quoted path stays quoted; a rename lists "old -> new".
    const status = yield* must(['status', '--porcelain=v1', '--untracked-files=all', ...PATHSPEC]);
    out.changed = status.split('\n').filter(Boolean).slice(0, MAX_CHANGED)
      .map(line => `${line.slice(0, 2).trim()[0]}\t${line.slice(3)}`);
    const head = yield* call(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (head.code !== 0) throw new Skip('detached');
    out.branch = head.stdout.trim();
    // Every remote's HEAD branch, whatever the remote is called. None (no remote, never fetched,
    // or a listing that failed) is not an error: main/master still bind.
    const remotes = yield* call(['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/remotes']);
    const defaults = new Set(['main', 'master']);
    if (remotes.code === 0) {
      for (const line of remotes.stdout.split('\n')) {
        const [ref, target] = line.split('\t');
        if (!target || !ref.endsWith('/HEAD')) continue;
        const prefix = ref.slice(0, -'HEAD'.length);
        if (target.startsWith(prefix)) defaults.add(target.slice(prefix.length));
      }
    }
    if (defaults.has(out.branch)) throw new Skip('default-branch');
    if (out.changed.length === 0) throw new Skip('clean-tree');
    yield* must(['add', '-A', ...PATHSPEC]);
    // ponytail: a pathspec commit is refused mid-merge ("partial commit"); that reads as a failure.
    const commit = yield* call(['commit', '-q', '-m', `wip(${task}): ${reason}`, '-m', `Ocli-Handoff: ${runId}`, ...PATHSPEC], COMMIT_TIMEOUT_MS);
    if (commit.code !== 0) {
      const msg = firstLine(commit.stderr || commit.stdout) || `exit ${commit.code}`;
      throw new Skip(`${(yield* hookCould(call, workspace)) ? 'hook-refused' : 'git-failed'}: ${msg}`);
    }
    out.commit = yield* must(['rev-parse', 'HEAD']);
  } catch (error) {
    out.commitSkipped = error instanceof Skip ? error.message : `git-failed: ${String(error?.message ?? error)}`;
  }
  out.at = new Date().toISOString();
  return out;
}

/** Whether any hook that can refuse a commit is executable here (core.hooksPath honoured). */
function* hookCould(call, workspace) {
  const dir = yield* call(['rev-parse', '--git-path', 'hooks']);
  if (dir.code !== 0) return true; // cannot tell: keep the old label
  return COMMIT_HOOKS.some(name => {
    try { accessSync(path.resolve(workspace, dir.stdout.trim(), name), constants.X_OK); return true; } catch { return false; }
  });
}

const firstLine = text => String(text ?? '').trim().split('\n').find(Boolean)?.slice(0, 300) ?? '';
