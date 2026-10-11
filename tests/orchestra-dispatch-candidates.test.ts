import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// RS1: every dispatch node records the candidate set. These tests go through main() with the
// provider readers, spawn and the node append mocked (the pattern of orchestra-dispatch-usage);
// the tree, however, is REAL — ORCHESTRA_TREE_DIR points at a temp dir, so readNodes is exercised
// for true and the real orchestra/tree/ is never read or written.
const mocks = vi.hoisted(() => ({
  codex: vi.fn(), glm: vi.fn(), claude: vi.fn(), gate: vi.fn(), appendFile: vi.fn(), spawn: vi.fn(),
}));
vi.mock('../dispatcher/usage.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readCodexUsage: mocks.codex, readGlmUsage: mocks.glm, claudeUsageFromLead: mocks.claude,
  gateFor: mocks.gate, // delegates to the real one by default; one test makes it throw
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
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { main } from '../dispatcher/dispatch.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { BUDGET } from '../dispatcher/usage.mjs';
// The real gateFor, NOT the mock this file installs (importing it from the mocked module would
// make the default delegation recurse into itself).
const realGateFor = (await vi.importActual<Record<string, unknown>>('../dispatcher/usage.mjs')).gateFor as (...a: unknown[]) => { state: string };

// The cap is policy the user changes (35% -> 45% once already); read it, do not pin it.
const CAP: number = BUDGET.codex.stopAtPercent;
const windowAt = (usedPercent: number) =>
  ({ limitId: 'codex', usedPercent, windowDurationMins: 10080, resetsAt: '2026-10-18T00:00:00Z' });
const okReading = (usedPercent: number) => ({ status: 'ok', windows: [windowAt(usedPercent)] });

/** A recorded codex node as latestReading reads it: usageAfter wins, recordedAt becomes gateReadAt. */
const codexHistory = (usedPercent: number, recordedAt: string) => ({
  schemaVersion: 1, role: 'reason', cli: 'codex', model: 'gpt-6-astra',
  usageAfter: okReading(usedPercent), recordedAt,
});

describe('dispatch records the candidate set (RS1)', () => {
  let treeDir: string;
  let currentPolicy: any;
  let exitCode: typeof process.exitCode;
  beforeEach(async () => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    fs.mkdirSync(path.resolve('tmp'), { recursive: true });
    treeDir = mkdtempSync(path.resolve('tmp', 'rs1-tree-'));
    vi.stubEnv('ORCHESTRA_TREE_DIR', treeDir);
    const fsp = await import('node:fs/promises');
    currentPolicy = JSON.parse(fs.readFileSync(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8'));
    currentPolicy.developers = { rotation: { order: ['implement', 'reason', 'muse'] } };
    // Policy reads get the test policy; every other read (the ranking file) is real.
    const realRead = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'readFile').mockImplementation((async (file: any, ...rest: any[]) =>
      /policy(\.example)?\.json$/.test(String(file)) ? JSON.stringify(currentPolicy) : realRead(file, ...rest)) as any);
    // No ranking unless a test provides one.
    vi.stubEnv('ORCHESTRA_RANKING_FILE', path.join(treeDir, 'no-ranking.json'));
    mocks.gate.mockImplementation((...a: unknown[]) => realGateFor(...a));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.codex.mockResolvedValue(okReading(Math.max(0, CAP - 10)));
    mocks.glm.mockResolvedValue({ status: 'unknown', reason: 'no verified source', windows: [] });
    mocks.spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        if (command === 'codex') child.stdout.emit('data', 'work delivered');
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

  const dispatch = (role = 'reason', ...extra: string[]) =>
    main(['--role', role, '--task', 'mock-candidates', '--prompt', 'stable', ...extra]);
  const node = () => JSON.parse(mocks.appendFile.mock.calls[0][1]);
  const candidates = () => node().candidates;
  const routeOf = (role: string) => candidates().routes.find((r: { role: string }) => r.role === role);
  const seedTree = (...nodes: Record<string, unknown>[]) =>
    writeFileSync(path.join(treeDir, 'hist.jsonl'), `${nodes.map(n => JSON.stringify(n)).join('\n')}\n`);

  it('lists every dispatchable route in policy key order; architect is not a candidate', async () => {
    await dispatch();
    expect(candidates().v).toBe(1);
    expect(candidates().rule).toBe('lead-explicit-role');
    expect(candidates().chosen).toBe('reason');
    expect(candidates().routes.map((r: { role: string }) => r.role))
      .toEqual(['breadth', 'implement', 'reason', 'easy', 'muse', 'cline-mimo', 'cline-qwen']);
    // One line of valid JSON: the append is a single record, newline-terminated.
    expect(mocks.appendFile.mock.calls[0][0]).toBe(path.join(treeDir, 'mock-candidates.jsonl'));
    expect(mocks.appendFile.mock.calls[0][1].slice(0, -1)).not.toContain('\n');
  });

  it('mirrors developers.rotation.order in rotation and inRotation', async () => {
    await dispatch();
    expect(candidates().rotation).toEqual(['implement', 'reason', 'muse']);
    const flags = Object.fromEntries(candidates().routes.map((r: { role: string; inRotation: boolean }) => [r.role, r.inRotation]));
    expect(flags).toEqual({ breadth: false, implement: true, reason: true, easy: false, muse: true, 'cline-mimo': false, 'cline-qwen': false });
  });

  it('takes the chosen route gate from its own usageBefore reading, with no extra provider call', async () => {
    // The tree says codex is at the cap; the chosen route must still report the LIVE 10%-below-cap
    // reading dispatch itself took, and the reader must be called exactly as often as before RS1.
    seedTree(codexHistory(CAP, '2026-10-11T08:00:00.000Z'));
    await dispatch('reason');
    expect(routeOf('reason')).toMatchObject({ gate: 'ok', gateSource: 'live', eligible: true, excludedBy: null });
    expect(routeOf('reason')).not.toHaveProperty('gateReadAt');
    expect(mocks.codex).toHaveBeenCalledTimes(2); // usageBefore + usageAfter, nothing more
    expect(mocks.glm).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1); // the CLI only: no app-server probe for candidates
  });

  it('asserts GLM reader call count for chosen implement with no extra provider calls (RS1-m1)', async () => {
    await dispatch('implement');
    expect(mocks.glm).toHaveBeenCalledTimes(2);
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it('classifies uncapped and budget-less providers without any reading', async () => {
    await dispatch('reason');
    expect(routeOf('implement')).toMatchObject({ gate: 'ok', gateSource: 'uncapped', eligible: true }); // glm: uncapped
    expect(routeOf('breadth')).toMatchObject({ gate: 'ok', gateSource: 'no-budget', eligible: false, excludedBy: 'status' }); // gemini: no BUDGET row
    expect(routeOf('muse')).toMatchObject({ gate: 'ok', gateSource: 'no-budget', eligible: true }); // no provider at all
  });

  it('records uncapped, never live, for a chosen uncapped route with status: ok usageBefore (RS1-M2)', async () => {
    mocks.glm.mockResolvedValue({ status: 'ok', windows: [] });
    await dispatch('implement');
    expect(routeOf('implement')).toMatchObject({ gate: 'ok', gateSource: 'uncapped' });
    expect(routeOf('implement')).not.toHaveProperty('gateReadAt');
  });

  it('takes a capped non-chosen route gate from the NEWEST tree node and reports budget-stop', async () => {
    seedTree(codexHistory(Math.max(0, CAP - 30), '2026-10-11T08:00:00.000Z'),
      codexHistory(CAP, '2026-10-11T09:00:00.000Z'));
    await dispatch('implement'); // reason is now the non-chosen capped route
    expect(routeOf('reason')).toMatchObject({
      gate: 'stop', gateSource: 'tree', gateReadAt: '2026-10-11T09:00:00.000Z',
      eligible: false, excludedBy: 'budget-stop',
    });
  });

  it('takes the newest recordedAt across multiple tree files regardless of filename order (RS1-B1)', async () => {
    writeFileSync(path.join(treeDir, 'a-new.jsonl'), `${JSON.stringify(codexHistory(CAP, '2026-10-11T09:00:00.000Z'))}\n`);
    writeFileSync(path.join(treeDir, 'z-old.jsonl'), `${JSON.stringify(codexHistory(Math.max(0, CAP - 30), '2026-10-11T08:00:00.000Z'))}\n`);
    await dispatch('implement');
    expect(routeOf('reason')).toMatchObject({
      gate: 'stop',
      gateSource: 'tree',
      gateReadAt: '2026-10-11T09:00:00.000Z',
      excludedBy: 'budget-stop',
    });
  });

  it('tolerates a null JSON line in the tree without dropping candidates into {v, error} (RS1-B1)', async () => {
    writeFileSync(path.join(treeDir, 'hist.jsonl'), `null\n${JSON.stringify(codexHistory(CAP, '2026-10-11T09:00:00.000Z'))}\n`);
    await dispatch('implement');
    expect(candidates().v).toBe(1);
    expect(candidates()).not.toHaveProperty('error');
    expect(routeOf('reason')).toMatchObject({
      gate: 'stop',
      gateSource: 'tree',
      gateReadAt: '2026-10-11T09:00:00.000Z',
      excludedBy: 'budget-stop',
    });
  });

  it('reports a capped route with no reading anywhere as unknown, never eligible', async () => {
    await dispatch('implement'); // empty tree: nothing recorded for codex
    expect(routeOf('reason')).toMatchObject({
      gate: 'unknown', gateSource: 'none', eligible: false, excludedBy: 'budget-unknown',
    });
    expect(routeOf('reason')).not.toHaveProperty('gateReadAt');
  });

  it('reports the status filter before the budget filters when both would exclude', async () => {
    seedTree(codexHistory(CAP, '2026-10-11T09:00:00.000Z'));
    await dispatch('implement');
    // easy: status unverified AND gate stop — status is the FIRST failing filter.
    expect(routeOf('easy')).toMatchObject({ status: 'unverified', gate: 'stop', excludedBy: 'status', eligible: false });
  });

  it('falls a chosen capped route with an unusable usageBefore back to the tree reading', async () => {
    mocks.codex.mockResolvedValue({ status: 'unknown', reason: 'app-server silent', windows: [] });
    seedTree(codexHistory(CAP, '2026-10-11T09:00:00.000Z'));
    await dispatch('reason');
    expect(routeOf('reason')).toMatchObject({
      gate: 'stop', gateSource: 'tree', gateReadAt: '2026-10-11T09:00:00.000Z',
      eligible: false, excludedBy: 'budget-stop',
    });
  });

  it('still dispatches an ineligible chosen route: recording never refuses', async () => {
    mocks.codex.mockResolvedValue({ status: 'unknown', reason: 'app-server silent', windows: [] });
    seedTree(codexHistory(CAP, '2026-10-11T09:00:00.000Z'));
    await dispatch('reason');
    expect(candidates().chosen).toBe('reason');
    expect(routeOf('reason').eligible).toBe(false); // the lead dispatched codex over the cap
    expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
    expect(node()).toMatchObject({ role: 'reason', exitCode: 0 });
    expect(process.exitCode).toBe(exitCode);
  });

  it('cleans and caps --pick-reason like a pane label; absent or empty is null', async () => {
    await dispatch();
    expect(candidates().reason).toBeNull();
    mocks.appendFile.mockClear();
    // \t is a C0 control: paneLabel deletes it; only whitespace that survives is collapsed.
    await dispatch('reason', '--pick-reason', '  GLM\u001b[2J  is   uncapped\tnow  ');
    expect(candidates().reason).toBe('GLM is uncappednow');
    mocks.appendFile.mockClear();
    await dispatch('reason', '--pick-reason', 'x'.repeat(250));
    expect([...candidates().reason]).toHaveLength(200);
    mocks.appendFile.mockClear();
    await dispatch('reason', '--pick-reason', '🙂'.repeat(300));
    expect([...candidates().reason]).toHaveLength(200);
    expect(candidates().reason).toBe('🙂'.repeat(200));
    mocks.appendFile.mockClear();
    await dispatch('reason', '--pick-reason', ' \u001b[2J ');
    expect(candidates().reason).toBeNull();
  });

  it('records {v, error} when the computation throws, and the dispatch proceeds unchanged', async () => {
    mocks.gate.mockImplementation(() => { throw new Error('gate exploded'); });
    await dispatch('reason');
    expect(candidates()).toEqual({ v: 1, error: 'gate exploded' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1); // the CLI still ran
    expect(node()).toMatchObject({ role: 'reason', exitCode: 0, stdoutTail: 'work delivered' });
    expect(process.exitCode).toBe(exitCode);
  });

  it('uses the rotation the example policy ships', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    currentPolicy = JSON.parse(fs.readFileSync(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8'));
    await dispatch();
    expect(candidates().rotation).toEqual(['implement', 'reason', 'muse', 'cline-mimo', 'cline-qwen']);
  });

  it('prefers later equal timestamps, ignores missing timestamps and malformed/non-object lines', async () => {
    const at = '2026-10-11T09:00:00.000Z';
    seedTree(codexHistory(0, at), codexHistory(CAP, at), { ...codexHistory(0, at), recordedAt: undefined });
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    fs.appendFileSync(path.join(treeDir, 'hist.jsonl'), 'bad json\nnull\n42\n"text"\n');
    await dispatch('implement');
    expect(routeOf('reason')).toMatchObject({ gate: 'stop', gateReadAt: at });
  });

  it('rejects linked and non-regular files without following their content', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { readRegular, readNodes } = await import('../dispatcher/tree-read.mjs');
    const target = path.join(treeDir, 'target.txt');
    fs.writeFileSync(target, JSON.stringify(codexHistory(CAP, '2026-10-11T09:00:00.000Z')));
    const link = path.join(treeDir, 'link.jsonl');
    fs.symlinkSync(target, link);
    await expect(readRegular(link)).rejects.toThrow();
    await expect(readRegular(treeDir)).rejects.toThrow();
    expect((await readNodes(treeDir)).nodes).toEqual([]);
    await dispatch('implement');
    expect(routeOf('reason')).toMatchObject({ gate: 'unknown', gateSource: 'none' });
  });

  it('never admits a prototype-polluting route key as a candidate', async () => {
    const fs = await import('node:fs/promises');
    const real = await fs.readFile(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8');
    // Injected via JSON text so __proto__ lands as an OWN data property (a JS object literal or
    // JSON.stringify would set a prototype instead, which is not the hostile shape). The separator
    // is matched loosely: policy.json pretty-prints with a space after the colon.
    const fake = JSON.stringify({ cli: 'codex', model: 'x', argv: ['a'], status: 'ok' });
    const injected = String(real).replace(/"routes":\s*\{/, `"routes":{"__proto__":${fake},"constructor":${fake},"prototype":${fake},`);
    expect(injected).not.toStrictEqual(String(real)); // the injection must actually land
    vi.spyOn(fs, 'readFile').mockResolvedValue(injected);
    await dispatch();
    expect(candidates().routes.map((r: { role: string }) => r.role))
      .toEqual(['breadth', 'implement', 'reason', 'easy', 'muse', 'cline-mimo', 'cline-qwen']);
  });
  // --- model ranking (AA Intelligence Index) ---------------------------------------------------
  const rankingWith = (entries: unknown[]) => {
    const file = path.join(treeDir, 'ranking.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, source: 'test', observedAt: '2026-10-11', entries }));
    vi.stubEnv('ORCHESTRA_RANKING_FILE', file);
  };
  const entry = (cli: string, modelArg: string, effortArg: string | null, aa: number) =>
    ({ model: modelArg, effort: effortArg, aa, access: [{ cli, modelArg, effortArg }] });
  const policyWith = async (edit: (p: any) => void) => { edit(currentPolicy); };

  it('records the AA score of exactly the route (cli, model, effort); a different effort is unranked', async () => {
    rankingWith([entry('agy', 'gemini-3.8-flash-high', null, 41), entry('opencode', 'zai-coding-plan/glm-5.3', 'max', 45),
      entry('codex', 'gpt-6-astra', 'high', 51), entry('cline', 'cline-pass/qwen3.8-max', 'high', 45)]);
    await dispatch();
    expect(routeOf('breadth').aa).toBe(41);
    expect(routeOf('reason').aa).toBe(51);
    expect(routeOf('implement').aa).toBe(45);
    // cline-qwen sets no effort; the only entry is for `high`: unranked, never 45.
    expect(routeOf('cline-qwen').aa).toBeNull();
    expect(candidates().rule).toBe('lead-explicit-role');
  });

  it('a missing or unreadable ranking file records aa null everywhere and never costs the dispatch', async () => {
    vi.stubEnv('ORCHESTRA_RANKING_FILE', path.join(treeDir, 'absent.json'));
    await dispatch();
    expect(candidates().error).toBeUndefined();
    expect(candidates().routes.every((r: { aa: unknown }) => r.aa === null)).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('--role auto picks the highest-AA eligible route in the rotation and records rule aa-rank', async () => {
    rankingWith([entry('opencode', 'zai-coding-plan/glm-5.3', 'max', 40), entry('codex', 'gpt-6-astra', 'high', 46),
      entry('muse', 'muse-spark-1.3-contributor', 'max', 44), entry('agy', 'gemini-3.8-flash-high', null, 99),
      entry('cline', 'cline-pass/qwen3.8-max', null, 98)]);
    // auto calls no provider: a capped route is eligible only on a recorded reading under its cap.
    seedTree(codexHistory(Math.max(0, CAP - 10), '2026-10-11T09:00:00.000Z'));
    await dispatch('auto');
    // breadth (99) and cline-qwen (98, eligible) are not in the rotation: never auto-picked.
    expect(candidates().chosen).toBe('reason');
    expect(candidates().rule).toBe('aa-rank');
    expect(candidates().reason).toBe('aa-rank: reason aa=46 over muse aa=44');
    expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
  });

  it('--role auto breaks an AA tie by rotation order and never picks an unranked route', async () => {
    rankingWith([entry('codex', 'gpt-6-astra', 'high', 44), entry('muse', 'muse-spark-1.3-contributor', 'max', 44)]);
    seedTree(codexHistory(Math.max(0, CAP - 10), '2026-10-11T09:00:00.000Z'));
    await policyWith(p => { p.developers.rotation.order = ['muse', 'implement', 'reason']; });
    await dispatch('auto');
    expect(candidates().chosen).toBe('muse'); // implement is unranked; muse precedes reason in the rotation
  });

  it('--role auto with --min-aa above every eligible ranked route refuses and spawns nothing', async () => {
    rankingWith([entry('codex', 'gpt-6-astra', 'high', 46), entry('muse', 'muse-spark-1.3-contributor', 'max', 44)]);
    await expect(dispatch('auto', '--min-aa', '50')).rejects.toThrow(/no eligible ranked route in the rotation at aa >= 50/);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.appendFile).not.toHaveBeenCalled();
  });

  it('--role auto treats a capped route with no reading as ineligible (no blind spend, no provider call)', async () => {
    rankingWith([entry('codex', 'gpt-6-astra', 'high', 90), entry('muse', 'muse-spark-1.3-contributor', 'max', 44)]);
    await dispatch('auto');
    expect(candidates().chosen).toBe('muse');
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it('--role auto never picks an ineligible route however high its AA', async () => {
    rankingWith([entry('codex', 'gpt-6-astra', 'high', 90), entry('muse', 'muse-spark-1.3-contributor', 'max', 44)]);
    seedTree(codexHistory(CAP, '2026-10-11T09:00:00.000Z')); // codex at its cap in the tree -> budget-stop
    await dispatch('auto');
    expect(candidates().chosen).toBe('muse');
  });
});
