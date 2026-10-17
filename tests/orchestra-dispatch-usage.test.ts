import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Q6 on the node: --size and one usage delta per window kind. main() runs with the provider
// readers, spawn and the node append mocked; the tree is a temp dir, never the real orchestra/tree/.
const mocks = vi.hoisted(() => ({
  codex: vi.fn(), glm: vi.fn(), claude: vi.fn(), appendFile: vi.fn(), spawn: vi.fn(),
}));
vi.mock('../dispatcher/usage.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readCodexUsage: mocks.codex, readGlmUsage: mocks.glm, claudeUsageFromLead: mocks.claude,
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
// @ts-expect-error - dispatcher tooling is plain ESM
import { main } from '../dispatcher/dispatch.mjs';

const window = (limitId: string, usedPercent: number, windowDurationMins = 10080) =>
  ({ limitId, usedPercent, windowDurationMins, resetsAt: '2026-09-26T00:00:00Z' });
const ok = (...windows: { limitId: string; usedPercent: number; windowDurationMins: number; resetsAt: string }[]) => ({ status: 'ok', windows });
const sample = (percent: number) => ok(window('codex', percent));

describe('dispatch usage recording — Q6 size and per-window deltas on the node', () => {
  let now: number;
  let exitCode: typeof process.exitCode;
  let treeDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    treeDir = mkdtempSync(path.join(tmpdir(), 'ocli-usage-tree-'));
    vi.stubEnv('ORCHESTRA_TREE_DIR', treeDir);
    // The shipped routes, whatever a local dispatcher/policy.json says.
    vi.stubEnv('ORCHESTRA_POLICY', fileURLToPath(new URL('../dispatcher/policy.example.json', import.meta.url)));
    vi.stubEnv('ORCHESTRA_RANKING_FILE', path.join(treeDir, 'no-ranking.json'));
    now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let reads = 0;
    mocks.codex.mockImplementation(async () => { now += 10_000; return sample(++reads === 1 ? 4 : 7); });
    mocks.glm.mockResolvedValue({ status: 'unknown', reason: 'no verified source', windows: [] });
    let delivered = false;
    mocks.spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        now += command === '/bin/sh' ? 600_000 : 120_000;
        if (command === 'git') child.stdout.emit('data', delivered ? '? delivered.ts\n' : '');
        else { delivered ||= command !== '/bin/sh'; child.stdout.emit('data', 'work delivered'); }
        child.emit('close', 0, null);
      });
      return child;
    });
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(treeDir, { recursive: true, force: true });
  });
  const dispatch = (role = 'reason') => main(['--role', role, '--task', 'mock-usage', '--prompt', 'stable', '--verify', 'true']);
  const recorded = () => JSON.parse(mocks.appendFile.mock.calls[0][1]);

  // R0 #4: the stderr label names the basis; only counter-exhausted may say CONFIRMED.
  const failWith = (stderr: string, code: number) => mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => { now += 120_000; child.stderr.emit('data', stderr); child.emit('close', code, null); });
    return child;
  });
  const stderrText = () => vi.mocked(process.stderr.write).mock.calls.map(call => String(call[0])).join('');
  it('labels a counter-confirmed exhaustion CONFIRMED and records counter-exhausted on the node', async () => {
    mocks.codex.mockResolvedValue(sample(100));
    failWith('usage limit reached', 1);
    await main(['--role', 'reason', '--task', 'mock-usage', '--prompt', 'stable']);
    expect(recorded()).toHaveProperty('blockedBasis', 'counter-exhausted');
    expect(stderrText()).toContain('[dispatch] codex usage limit CONFIRMED against its counter: usage confirms exhaustion');
  });
  it('labels a failed run against a counter with room a transient refusal, never CONFIRMED', async () => {
    failWith('quota exceeded', 9);
    await main(['--role', 'reason', '--task', 'mock-usage', '--prompt', 'stable']);
    expect(recorded()).toHaveProperty('blockedBasis', 'counter-transient-refusal');
    expect(stderrText()).toContain('[dispatch] codex refused (transient; counter shows room): run failed with exit 9');
    expect(stderrText()).not.toMatch(/(?<!UN)CONFIRMED/);
  });
  it('records --size S|M|L on the node, null when omitted', async () => {
    for (const size of ['S', 'M', 'L']) {
      mocks.appendFile.mockClear();
      await main(['--role', 'reason', '--task', 'mock-usage', '--prompt', 'stable', '--size', size]);
      expect(recorded()).toHaveProperty('size', size);
    }
    mocks.appendFile.mockClear();
    await dispatch();
    expect(recorded()).toHaveProperty('size', null);
  });
  it('refuses any other --size before anything is spawned or read', async () => {
    for (const bad of [['--size', 'X'], ['--size', 'm'], ['--size', ''], ['--size']]) {
      await expect(main(['--role', 'reason', '--task', 'mock-usage', '--prompt', 'stable', ...bad])).rejects.toThrow(/--size/);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.appendFile).not.toHaveBeenCalled();
  });
  it('records the 5h and weekly deltas separately; the reset 5h window gives none, usageDelta unchanged', async () => {
    const H5 = (resetsAt: string, usedPercent: number) => ({ limitId: 'codex', usedPercent, windowDurationMins: 300, resetsAt });
    const readings = [
      ok(H5('2026-09-25T15:00:00Z', 90), window('codex', 40)),
      ok(H5('2026-09-25T20:00:00Z', 2), window('codex', 43)),
    ];
    mocks.codex.mockImplementation(async () => { now += 10_000; return readings.shift(); });
    await dispatch();
    expect(recorded().usageDeltas).toEqual([
      { limitId: 'codex', windowDurationMins: 10080, percentDelta: 3, minutes: 2, percentPerHour: 90 },
    ]);
    // The singular field still binds on the 5h window, which reset: no delta, as before Q6.
    expect(recorded().usageDelta).toBeNull();
  });
  it('a reset 5h window that climbs above its old value still gives no 5h delta', async () => {
    const H5 = (resetsAt: string, usedPercent: number) => ({ limitId: 'codex', usedPercent, windowDurationMins: 300, resetsAt });
    const readings = [
      ok(H5('2026-09-25T15:00:00Z', 2), window('codex', 40)),
      ok(H5('2026-09-25T20:00:00Z', 7), window('codex', 43)),
    ];
    mocks.codex.mockImplementation(async () => { now += 10_000; return readings.shift(); });
    await dispatch();
    expect(recorded().usageDeltas).toEqual([
      { limitId: 'codex', windowDurationMins: 10080, percentDelta: 3, minutes: 2, percentPerHour: 90 },
    ]);
  });
  it('records both window kinds when neither reset, each with its own delta', async () => {
    const H5 = (usedPercent: number) => ({ limitId: 'codex', usedPercent, windowDurationMins: 300, resetsAt: '2026-09-25T15:00:00Z' });
    const readings = [ok(H5(10), window('codex', 40)), ok(H5(16), window('codex', 41))];
    mocks.codex.mockImplementation(async () => { now += 10_000; return readings.shift(); });
    await dispatch();
    expect(recorded().usageDeltas).toEqual([
      { limitId: 'codex', windowDurationMins: 300, percentDelta: 6, minutes: 2, percentPerHour: 180 },
      { limitId: 'codex', windowDurationMins: 10080, percentDelta: 1, minutes: 2, percentPerHour: 30 },
    ]);
  });
});
