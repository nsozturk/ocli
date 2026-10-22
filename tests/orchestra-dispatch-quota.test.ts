import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Q12: --role auto --size S|M|L routes through quota.decide. main() runs in-process with the provider
// readers, the CLI spawn and the node append mocked (the orchestra-dispatch-candidates pattern); tree,
// live dir, policy, plans and ranking are TEMP files, so no real provider, tree or plans file is touched.
const mocks = vi.hoisted(() => ({ codex: vi.fn(), glm: vi.fn(), claude: vi.fn(), counter: vi.fn(), appendFile: vi.fn(), spawn: vi.fn() }));
vi.mock('../dispatcher/usage.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), spawn: mocks.spawn,
}));
// Slice D: dispatch reads every counter through usage-readers/index.mjs; the stub routes by provider.
vi.mock('../dispatcher/usage-readers/index.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readProviderUsage: (provider: string) => {
    const reader = ({ codex: mocks.codex, glm: mocks.glm, claude: mocks.claude } as Record<string, (() => unknown) | undefined>)[provider];
    return reader ? reader() : mocks.counter(provider);
  },
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
import { main, decideProviderStop } from '../dispatcher/dispatch.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { providerForNode, stopProviderForNode, providerStopActive } from '../dispatcher/tree-read.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { windowUsage } from '../dispatcher/quota.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { parsePlans } from '../dispatcher/plans.mjs';
// The full-roster plans the suites run on (the shipped starter is provider-plans.example.json).
const EXAMPLE_PLANS: string = fileURLToPath(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url));

const NOTICE = '--role auto without --size: AA only, no quota decision';
const shipped = JSON.parse(readFileSync(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8'));
// Package-only: the example ships agy (breadth) "unverified" (unsafe by design); senatus's policy has it ok.
shipped.routes.breadth.status = 'ok';
const plans = parsePlans(readFileSync(EXAMPLE_PLANS, 'utf8'));
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;
const entry = (role: string, aa: number) => {
  const r = shipped.routes[role];
  return { model: r.model, effort: r.effort ?? r.variant ?? null, aa, access: [{ cli: r.cli, modelArg: r.model, effortArg: r.effort ?? r.variant ?? null }] };
};
const roomReading = () => ({ status: 'ok', windows: [
  { limitId: 'codex', usedPercent: 10, windowDurationMins: 300, resetsAt: isoIn(HOUR) },
  { limitId: 'codex', usedPercent: 10, windowDurationMins: 10080, resetsAt: isoIn(48 * HOUR) },
] });

// Q15 (user rule 2026-10-17): Astra tokens run out fast, so gpt-6-astra runs at effort max and ONLY
// for very easy (S) tasks. The shipped data files encode that rule; this pins them so a roster edit
// that silently re-admits codex to the main rotation (or lifts the S cap) fails here, not in spending.
describe('shipped roster (user 2026-10-17)', () => {
  it('codex default is GPT-6.1 Sol xhigh in the rotation; Astra is its own route, never rotated; codex is uncapped by size', () => {
    expect([shipped.routes.reason.model, shipped.routes.reason.effort]).toEqual(['gpt-6.1-sol', 'xhigh']);
    expect(shipped.developers.rotation.order).toContain('reason');
    expect([shipped.routes.astra.model, shipped.routes.astra.effort]).toEqual(['gpt-6-astra', 'max']);
    expect(shipped.routes.astra._notes.join(' ')).toContain('never in the rotation');
    expect(shipped.developers.rotation.order).not.toContain('astra');
    expect(plans.providers.codex.maxSize).toBeNull();
    expect(plans.providers.codex.plan).toBe('chatgpt-plus');
  });
  it('Opus 5.5 medium is the rotated developer; Opus 5.5 high is the explicit seat for decision-focused work', () => {
    expect([shipped.routes.opus.effort, shipped.developers.rotation.order.includes('opus')]).toEqual(['medium', true]);
    expect(shipped.routes['opus-high'].effort).toBe('high');
    expect(shipped.developers.rotation.order).not.toContain('opus-high');
  });
  it('Gemini 3.8 Flash is the explicit fallback seat when Argon is out of quota — never rotated', () => {
    expect([shipped.routes['breadth-flash'].cli, shipped.routes['breadth-flash'].model]).toEqual(['agy', 'gemini-3.8-flash-high']);
    expect(shipped.routes['breadth-flash']._notes.join(' ')).toContain('ONLY simple');
    expect(shipped.developers.rotation.order).not.toContain('breadth-flash');
  });
});

describe('--role auto --size: quota decision (Q12)', () => {
  let dir: string;
  let treeDir: string;
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    process.exitCode = undefined;
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orchestra-quota-dispatch-')));
    treeDir = path.join(dir, 'tree');
    vi.stubEnv('ORCHESTRA_TREE_DIR', treeDir);
    vi.stubEnv('ORCHESTRA_LIVE_DIR', path.join(dir, 'live'));
    vi.stubEnv('ORCHESTRA_PLANS', EXAMPLE_PLANS);
    vi.stubEnv('ORCHESTRA_RANKING_FILE', path.join(dir, 'ranking.json'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.codex.mockResolvedValue(roomReading());
    mocks.glm.mockResolvedValue({ status: 'unknown', reason: 'mocked', windows: [] });
    mocks.counter.mockResolvedValue({ status: 'unavailable', reason: 'reader:unavailable' });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    ranking([entry('reason', 51), entry('muse', 48), entry('breadth', 53), entry('cline-mimo', 46)]);
    rotation(['reason', 'muse']);
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const ranking = (entries: unknown[]) =>
    writeFileSync(path.join(dir, 'ranking.json'), JSON.stringify({ schemaVersion: 1, source: 'test', observedAt: '2026-10-17', entries }));
  const rotation = (order: string[]) => {
    const policy = structuredClone(shipped);
    policy.developers.rotation.order = order;
    const file = path.join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify(policy));
    vi.stubEnv('ORCHESTRA_POLICY', file);
  };
  // Q15: the shipped example caps codex at maxSize S (Astra is for very easy tasks only). A test that
  // prices an M/L codex run says so on its own plans fixture instead of the shipped file.
  const plansWithCodexUncapped = () => {
    const doc = JSON.parse(readFileSync(EXAMPLE_PLANS, 'utf8'));
    doc.providers.codex.maxSize = null;
    const file = path.join(dir, 'plans.json');
    writeFileSync(file, JSON.stringify(doc));
    vi.stubEnv('ORCHESTRA_PLANS', file);
  };
  const seed = (...nodes: Record<string, unknown>[]) => {
    execFileSync('mkdir', ['-p', treeDir]);
    writeFileSync(path.join(treeDir, 'hist.jsonl'), `${nodes.map(n => JSON.stringify(n)).join('\n')}\n`);
  };
  const dispatch = (...extra: string[]) => main(['--role', 'auto', '--task', 'mock-quota', '--prompt', 'stable', ...extra]);
  const nodeCalls = () => mocks.appendFile.mock.calls.filter(c => String(c[0]).startsWith(treeDir));
  const node = () => JSON.parse(nodeCalls()[0][1]);
  const stdout = () => vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]));
  const stderr = () => vi.mocked(process.stderr.write).mock.calls.map(c => String(c[0])).join('');
  /** The single stdout line a decision without a run prints, parsed. */
  const decisionLine = () => {
    expect(stdout()).toHaveLength(1);
    expect(stdout()[0].endsWith('\n')).toBe(true);
    expect(stdout()[0].slice(0, -1)).not.toContain('\n');
    return JSON.parse(stdout()[0]);
  };
  /** codex: a fresh reading in the tree (no live refresh needed) and a learned %/token ratio, so the
   * weekly window decides — 94 % used, 95 % stop, an S run costs 2.5 % (so no split) ⇒ out until the weekly reset. */
  const codexNearWeeklyCap = (weeklyResetsAt: string) => ({
    schemaVersion: 1, role: 'reason', cli: 'codex', model: 'gpt-6-astra', exitCode: 0,
    tokens: { metered: 1_200_000 },
    usageDeltas: [{ limitId: 'codex', windowDurationMins: 10080, percentDelta: 10 }, { limitId: 'codex', windowDurationMins: 300, percentDelta: 10 }],
    usageAfter: { status: 'ok', windows: [
      { limitId: 'codex', usedPercent: 10, windowDurationMins: 300, resetsAt: isoIn(HOUR) },
      { limitId: 'codex', usedPercent: 94, windowDurationMins: 10080, resetsAt: weeklyResetsAt },
    ] },
    recordedAt: isoIn(-60_000),
  });

  it('run: dispatches the role decide picked, not the AA top, with rule quota and candidates.quota', async () => {
    // reason (AA 51) is gate-eligible on the live refresh, but codex has no learned %/token ratio, so
    // decide cannot price an M run there (unknown, refuse); muse (48) is in on until-stop.
    plansWithCodexUncapped();
    await dispatch('--size', 'M');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][0]).toBe('muse');
    const c = node().candidates;
    expect(c.rule).toBe('quota');
    expect(c.chosen).toBe('muse');
    expect(c.quota).toEqual({ action: 'run', role: 'muse', size: 'M', reasons: [{ role: 'reason', why: 'unknown' }] });
    expect(node().size).toBe('M');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr()).not.toContain(NOTICE);
  });

  it('split: exit 3, one JSON line, no spawn, no node', async () => {
    rotation(['cline-mimo']); // overflow, maxSize S: an M task only fits once cut
    const out = await dispatch('--size', 'M');
    expect(process.exitCode).toBe(3);
    expect(decisionLine()).toEqual({ action: 'split', reasons: [{ role: 'cline-mimo', why: 'overflow' }] });
    expect(out).toMatchObject({ action: 'split' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(nodeCalls()).toHaveLength(0);
  });

  it('wait: exit 3, one JSON line naming the reset, no spawn, no node', async () => {
    rotation(['reason']);
    plansWithCodexUncapped();
    const weekly = isoIn(3 * HOUR);
    seed(codexNearWeeklyCap(weekly));
    await dispatch('--size', 'M');
    expect(process.exitCode).toBe(3);
    expect(decisionLine()).toEqual({ action: 'wait', until: new Date(weekly).toISOString(), reasons: [{ role: 'reason', why: 'headroom' }] });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.codex).not.toHaveBeenCalled(); // a current tree reading: no refresh
    expect(nodeCalls()).toHaveLength(0);
  });

  it('--dry-run decides from the tree only: no live codex read, no spawn, no node; exit 0 on run', async () => {
    // No codex reading anywhere: without a live read reason gates unknown, so muse is decided.
    await dispatch('--size', 'M', '--dry-run');
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.counter).not.toHaveBeenCalled(); // Q17: a dry run spawns no counter reader either
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(nodeCalls()).toHaveLength(0);
    expect(process.exitCode ?? 0).toBe(0);
    expect(decisionLine()).toEqual({ action: 'run', role: 'muse', reasons: [{ role: 'reason', why: 'budget-unknown' }] });
  });

  it('--dry-run exits 3 on wait, still without any read or spawn', async () => {
    rotation(['reason']);
    seed(codexNearWeeklyCap(isoIn(3 * HOUR)));
    await dispatch('--size', 'M', '--dry-run');
    expect(process.exitCode).toBe(3);
    expect(decisionLine().action).toBe('wait');
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.counter).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('--dry-run with --worktree auto adds the worktree path and creates nothing', async () => {
    const repo = path.join(dir, 'repo');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main', 'repo');
    git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    await dispatch('--size', 'M', '--worktree', 'auto', '--root', repo, '--dry-run');
    const wt = path.join(dir, 'repo.worktrees', 'mock-quota');
    expect(decisionLine()).toEqual({ action: 'run', role: 'muse', reasons: [{ role: 'reason', why: 'budget-unknown' }], worktree: wt });
    expect(existsSync(wt)).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it('--dry-run --role auto without --size is refused', async () => {
    await expect(dispatch('--dry-run')).rejects.toThrow(/--dry-run applies only to --worktree auto/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('without --size: today\'s AA pick, one stderr notice, no quota record', async () => {
    await dispatch();
    expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
    expect(node().candidates.rule).toBe('aa-rank');
    expect(node().candidates.chosen).toBe('reason');
    expect(node().candidates).not.toHaveProperty('quota');
    expect(stderr().split(NOTICE)).toHaveLength(2); // exactly once
  });

  it('a live refresh feeds the decision: a fresh reading plus a learned ratio lets codex run', async () => {
    // The tree has the ratio but no readable reading; the refresh's reading is what decide sees.
    const history = codexNearWeeklyCap(isoIn(3 * HOUR));
    seed({ ...history, usageAfter: { status: 'unavailable', reason: 'x' } });
    plansWithCodexUncapped();
    await dispatch('--size', 'M');
    expect(mocks.codex).toHaveBeenCalled();
    expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
    expect(node().candidates.quota).toMatchObject({ action: 'run', role: 'reason' });
  });

  it('a gemini stop excludes breadth until its reset', async () => {
    rotation(['breadth', 'muse']);
    const stop = (resetsAt: string) => ({ schemaVersion: 1, role: 'breadth', cli: 'agy', model: shipped.routes.breadth.model,
      exitCode: 1, providerStop: { provider: 'google', resetsAt, evidence: 'quota exceeded' }, recordedAt: isoIn(-60_000) });
    seed(stop(isoIn(HOUR)));
    await dispatch('--size', 'M');
    expect(mocks.spawn.mock.calls[0][0]).toBe('muse');
    expect(node().candidates.quota.reasons).toContainEqual({ role: 'breadth', why: 'budget-stop' });

    vi.clearAllMocks();
    seed(stop(isoIn(-1000)));
    await dispatch('--size', 'M');
    expect(mocks.spawn.mock.calls[0][0]).toBe('agy');
  });

  // Q12f 1: quota.mjs calls a reading older than decision.readingMaxAgeMins stale even when its
  // resets are ahead; the sized path must refresh on exactly that, the unsized one keeps its trigger.
  const codex31MinOld = () => ({ ...codexNearWeeklyCap(isoIn(3 * HOUR)), recordedAt: isoIn(-31 * 60_000) });

  it('Q12f: sized path refreshes a 31-min-old reading with future resets — one live read, and it decides', async () => {
    rotation(['reason', 'muse']);
    plansWithCodexUncapped();
    seed(codex31MinOld());
    await dispatch('--size', 'M');
    // Reads before the CLI spawns: the refresh only (its reading is reused as usageBefore); the one
    // after is the run's usageAfter.
    const spawnedAt = mocks.spawn.mock.invocationCallOrder[0];
    expect(mocks.codex.mock.invocationCallOrder.filter(order => order < spawnedAt)).toHaveLength(1);
    expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
    expect(node().candidates.quota).toMatchObject({ action: 'run', role: 'reason' });
  });

  it('Q12f: sized path refreshes a recent reading whose 5h window already reset — one live read, and it decides', async () => {
    // 5 min old (age rule passes) but expired: decide would score the reset 5h window unknown.
    const history = codexNearWeeklyCap(isoIn(3 * HOUR));
    const [fiveHour, weekly] = history.usageAfter.windows;
    rotation(['reason', 'muse']);
    plansWithCodexUncapped();
    seed({ ...history, recordedAt: isoIn(-5 * 60_000),
      usageAfter: { status: 'ok', windows: [{ ...fiveHour, resetsAt: isoIn(-60_000) }, weekly] } });
    await dispatch('--size', 'M');
    const spawnedAt = mocks.spawn.mock.invocationCallOrder[0];
    expect(mocks.codex.mock.invocationCallOrder.filter(order => order < spawnedAt)).toHaveLength(1);
    expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
    expect(node().candidates.quota).toMatchObject({ action: 'run', role: 'reason' });
  });

  it('Q12f: unsized path keeps today\'s trigger — the same reading is current, no live read', async () => {
    ranking([entry('reason', 51), entry('muse', 55)]); // muse is the AA pick: no codex usageBefore read
    rotation(['reason', 'muse']);
    seed(codex31MinOld());
    await dispatch();
    expect(mocks.spawn.mock.calls[0][0]).toBe('muse');
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(node().candidates.routes.find((r: { role: string }) => r.role === 'reason').gateSource).toBe('tree');
  });

  it('Q12f: a gate-eligible route whose provider the plans omit is skipped as no-plan, not a throw', async () => {
    const d = JSON.parse(readFileSync(EXAMPLE_PLANS, 'utf8'));
    delete d.providers.muse;
    d.providers.codex.maxSize = null; // this test prices an M codex run: its own fixture, not the shipped cap
    const file = path.join(dir, 'plans.json');
    writeFileSync(file, JSON.stringify(d));
    vi.stubEnv('ORCHESTRA_PLANS', file);
    rotation(['muse', 'reason']);
    const weekly = isoIn(3 * HOUR);
    seed(codexNearWeeklyCap(weekly));
    await dispatch('--size', 'M', '--dry-run');
    expect(decisionLine()).toEqual({ action: 'wait', until: new Date(weekly).toISOString(),
      reasons: [{ role: 'muse', why: 'no-plan' }, { role: 'reason', why: 'headroom' }] });
  });

  it('Q12f: the tree candidate gate scopes expiry to the budget limitIds — another pool\'s past reset is not ours', async () => {
    const reading = { status: 'ok', windows: [
      { limitId: 'codex', usedPercent: 10, windowDurationMins: 300, resetsAt: isoIn(HOUR) },
      { limitId: 'codex', usedPercent: 10, windowDurationMins: 10080, resetsAt: isoIn(48 * HOUR) },
      { limitId: 'base_model_inference', usedPercent: 5, windowDurationMins: 300, resetsAt: isoIn(-HOUR) },
    ] };
    seed({ schemaVersion: 1, role: 'reason', cli: 'codex', model: 'gpt-6-astra', exitCode: 0, usageAfter: reading, recordedAt: isoIn(-60_000) });
    const routes = await main(['--list-routes', '--json']);
    expect(routes.find((r: { role: string }) => r.role === 'reason')).toMatchObject({ gate: 'ok', gateSource: 'tree', eligible: true });
    expect(mocks.codex).not.toHaveBeenCalled();
  });
});

describe('provider mapping (Q12)', () => {
  const now = Date.now();
  const muse = { role: 'muse', cli: 'muse', model: 'muse-wonder-1.0', exitCode: 0, tokens: { metered: 4321 }, recordedAt: new Date(now - 60_000).toISOString() };

  it('a muse node is the muse provider and counts in the meta pool', () => {
    expect(providerForNode(muse)).toBe('muse');
    // Q17: muse is a CodexBar counter pool now, counted by its counter reading, not summed tokens.
    // Its windows are unmeasured (limitIds null), so even a reading carrying windows counts as
    // unknown use — never a percentage bound on a guessed id.
    const counted = { ...muse, usageAfter: { status: 'ok', source: 'reader', windows: [
      { limitId: 'muse-primary', usedPercent: 25, windowDurationMins: 300, resetsAt: new Date(now + 3_600_000).toISOString() },
      { limitId: 'muse-secondary', usedPercent: 40, windowDurationMins: 10080, resetsAt: new Date(now + 86_400_000).toISOString() },
    ] } };
    expect(windowUsage(plans, [counted], 'muse', '5h', now)).toMatchObject({ usedPercent: null, source: 'counter', fresh: false });
    expect(windowUsage(plans, [counted], 'muse', 'weekly', now)).toMatchObject({ usedPercent: null, source: 'counter', fresh: false });
  });

  it('gemini and muse stops reach their pools; codex and claude stay unmapped', () => {
    expect(stopProviderForNode({ cli: 'agy', model: 'gemini-4-argon-high' })).toBe('google');
    expect(stopProviderForNode({ cli: 'muse', model: 'muse-wonder-1.0' })).toBe('meta');
    expect(stopProviderForNode({ cli: 'codex', model: 'gpt-6-astra' })).toBeNull();
    expect(stopProviderForNode({ cli: 'claude', model: 'claude-opus-5-5' })).toBeNull();
    const result = { code: 1 };
    expect(decideProviderStop({ result, cliErrorText: 'quota exceeded', cli: 'agy', model: 'gemini-4-argon-high', runEndMs: now })?.provider).toBe('google');
    expect(decideProviderStop({ result, cliErrorText: 'usage limit reached', cli: 'muse', model: 'muse-wonder-1.0', runEndMs: now })?.provider).toBe('meta');
  });

  it('providerStopActive: dated stops end at their reset; undatable ones bind', () => {
    expect(providerStopActive(null, now)).toBe(false);
    expect(providerStopActive({ resetsAt: new Date(now + 1).toISOString() }, now)).toBe(true);
    expect(providerStopActive({ resetsAt: new Date(now).toISOString() }, now)).toBe(false);
    expect(providerStopActive({ resetsAt: null }, now)).toBe(true);
    expect(providerStopActive({ resetsAt: 'garbage' }, now)).toBe(true);
  });
});
