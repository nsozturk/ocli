import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Q19 (measured 2026-10-22): the Argon-only weekly bucket sat at 100% while the gemini 5h/weekly
// pools had room, and because it was one of the gemini pool's limitIds it stopped breadth-flash too.
// A plans `limitScopes` entry makes a bucket count only for the routes whose model it names.
// Readers, the CLI spawn and the node append are mocked; tree, live dir, policy and ranking are temp
// files (the orchestra-dispatch-quota pattern), so no real provider, tree or plans file is touched.
const mocks = vi.hoisted(() => ({ counter: vi.fn(), appendFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), spawn: mocks.spawn,
}));
vi.mock('../dispatcher/usage-readers/index.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readProviderUsage: (provider: string) => mocks.counter(provider),
}));
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
import { gateFor, scopedBucketLines } from '../dispatcher/usage.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { providerForNode } from '../dispatcher/tree-read.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { decide, windowUsage, estimateFor } from '../dispatcher/quota.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { parsePlans, modelMatches, scopedLimitIds } from '../dispatcher/plans.mjs';

type Json = Record<string, any>;
// The full-roster plans/policy are the package's twins of senatus's shipped example/policy.
const EXAMPLE_PLANS = fileURLToPath(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url));
const exampleText = readFileSync(EXAMPLE_PLANS, 'utf8');
const SHIPPED = parsePlans(exampleText);
const shipped = JSON.parse(readFileSync(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8'));
// Package-only: the shipped agy routes are "unverified" (unsafe by design); senatus's policy has them ok.
shipped.routes.breadth.status = 'ok';
shipped.routes['breadth-flash'].status = 'ok';
const ARGON = shipped.routes.breadth.model as string;
const FLASH = shipped.routes['breadth-flash'].model as string;
const ID = {
  fiveH: 'antigravity-quota-summary-gemini-5h',
  weekly: 'antigravity-quota-summary-gemini-weekly',
  argon: 'antigravity-quota-summary-gemini-argon-wtu-weekly',
};
const HOUR = 3_600_000;
const win = (limitId: string, usedPercent: number, windowDurationMins: number, resetsAt: string) =>
  ({ limitId, usedPercent, windowDurationMins, resetsAt, model: null });
/** The 2026-10-22 shape: 5h 0%, weekly 31%, Argon WTU weekly 100%. */
const measured = (nowMs: number, over: { fiveH?: number } = {}) => ({ status: 'ok', windows: [
  win(ID.fiveH, over.fiveH ?? 0, 300, new Date(nowMs + HOUR).toISOString()),
  win(ID.weekly, 31, 10080, new Date(nowMs + 48 * HOUR).toISOString()),
  win(ID.argon, 100, 10080, new Date(nowMs + 72 * HOUR).toISOString()),
] });

describe('plans: limitScopes (Q19)', () => {
  const doc = () => JSON.parse(exampleText);
  const parseObj = (o: unknown) => () => parsePlans(JSON.stringify(o));

  it('the shipped example scopes the Argon WTU bucket to the Argon models only', () => {
    expect(SHIPPED.providers.gemini.limitScopes).toEqual({ [ID.argon]: { models: ['gemini-4-argon-high', 'gemini-4-argon-medium'] } });
    expect(SHIPPED.providers.codex).not.toHaveProperty('limitScopes');
  });

  const bad: Array<[RegExp, (o: Json) => void]> = [
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.routes: unknown key/, o => { o.providers.gemini.limitScopes[ID.argon].routes = ['breadth']; }],
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.models: expected a non-empty array/, o => { o.providers.gemini.limitScopes[ID.argon].models = 'gemini-4-argon-high'; }],
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.models: expected a non-empty array/, o => { o.providers.gemini.limitScopes[ID.argon].models = []; }],
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.models\[0\]/, o => { o.providers.gemini.limitScopes[ID.argon].models = ['gemini-*-high']; }],
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.models\[0\]/, o => { o.providers.gemini.limitScopes[ID.argon].models = ['']; }],
    [/limitScopes\.nope: expected one of this provider's limitIds/, o => { o.providers.gemini.limitScopes.nope = { models: ['x'] }; }],
    [/providers\.gemini\.limitScopes: expected an object/, o => { o.providers.gemini.limitScopes = [ID.argon]; }],
    // Q19 review pins: a non-string pattern, and more than one trailing *.
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.models\[0\]/, o => { o.providers.gemini.limitScopes[ID.argon].models = [42]; }],
    [/limitScopes\.antigravity-quota-summary-gemini-argon-wtu-weekly\.models\[0\]/, o => { o.providers.gemini.limitScopes[ID.argon].models = ['gemini-4-argon-**']; }],
  ];
  it.each(bad)('the strict parser refuses %s', (message, edit) => {
    const o = doc();
    edit(o);
    expect(parseObj(o)).toThrow(message);
  });

  it('modelMatches: exact ids, or a trailing-* prefix — never a non-prefix, never a regex', () => {
    expect(modelMatches('gemini-4-argon-high', ['gemini-4-argon-high'])).toBe(true);
    expect(modelMatches('gemini-4-argon-highest', ['gemini-4-argon-high'])).toBe(false);
    expect(modelMatches('gemini-4-argon-high', ['gemini-4-argon-*'])).toBe(true);
    expect(modelMatches('x-gemini-4-argon-high', ['gemini-4-argon-*'])).toBe(false);
    expect(modelMatches('gemini-3.8-flash-high', ['gemini-4-argon-*'])).toBe(false);
    expect(modelMatches('gemini-4-argonX', ['gemini-4-argon.*'])).toBe(false);
    expect(modelMatches(FLASH, ['gemini-4-argon-high', 'gemini-4-argon-medium'])).toBe(false);
    expect(modelMatches(null, ['gemini-4-argon-*'])).toBe(false); // a route with no model is never bound by name
  });

  it('scopedLimitIds: a scoped id stays only for a matching model; no model keeps the pool view', () => {
    const p = SHIPPED.providers.gemini;
    expect(scopedLimitIds(p, ARGON)).toEqual([ID.fiveH, ID.weekly, ID.argon]);
    expect(scopedLimitIds(p, FLASH)).toEqual([ID.fiveH, ID.weekly]);
    expect(scopedLimitIds(p, undefined)).toEqual([ID.fiveH, ID.weekly, ID.argon]);
    expect(scopedLimitIds(SHIPPED.providers.codex, 'gpt-6.1-sol')).toEqual(['codex']);
    expect(scopedLimitIds({ limitIds: null }, FLASH)).toBeNull();
  });
});

describe('gateFor: a scoped bucket gates only its routes (Q19)', () => {
  const NOW = Date.now();
  it('Argon WTU at 100% stops the Argon route, not Flash', () => {
    expect(gateFor('gemini', measured(NOW), ARGON)).toMatchObject({ state: 'stop', window: { limitId: ID.argon } });
    expect(gateFor('gemini', measured(NOW), FLASH)).toMatchObject({ state: 'ok', window: { limitId: ID.weekly, usedPercent: 31 } });
  });
  it('unscoped buckets bind every route exactly as before; no model is the pool-wide view', () => {
    expect(gateFor('gemini', measured(NOW, { fiveH: 90 }), FLASH)).toMatchObject({ state: 'stop', window: { limitId: ID.fiveH } });
    expect(gateFor('gemini', measured(NOW)).state).toBe('stop');
  });
});

describe('node dispatcher/usage.mjs: which routes a scoped bucket binds (Q19)', () => {
  const routes = Object.entries(shipped.routes as Record<string, Json>).filter(([, r]) => r?.argv)
    .map(([role, r]) => ({ role, model: r.model, provider: providerForNode({ cli: r.cli, model: r.model }) }));
  it('names the bound and the free routes, then gates each route on its own buckets', () => {
    const lines = scopedBucketLines('gemini', measured(Date.now()), routes);
    expect(lines[0]).toBe(`  -> scoped ${ID.argon}: binds breadth; not breadth-flash`);
    expect(lines.find((l: string) => l.includes(`breadth (${ARGON})`))).toContain('STOP — CAP REACHED');
    expect(lines.find((l: string) => l.includes(`breadth-flash (${FLASH})`))).toContain('DISPATCH OK');
  });
  it('an unscoped provider prints nothing extra', () => {
    expect(scopedBucketLines('codex', { status: 'ok', windows: [] }, routes)).toEqual([]);
  });
});

describe('quota.decide: a scoped bucket prices only its routes (Q19)', () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z');
  const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
  // A measured gemini run teaches a %/token ratio on the UNSCOPED weekly + 5h ids, and its reading is
  // the fresh 2026-10-22 shape — so every window is priced, nothing falls through as until-stop unknown.
  const calibration = (reading: unknown) => ({
    role: 'breadth', cli: 'agy', model: ARGON, task: 'fixture', exitCode: 0, size: 'M',
    tokens: { metered: 1_200_000 },
    usageDeltas: [{ limitId: ID.weekly, windowDurationMins: 10080, percentDelta: 2 }, { limitId: ID.fiveH, windowDurationMins: 300, percentDelta: 2 }],
    usageAfter: reading, recordedAt: at(5),
  });
  const routes = [
    { role: 'breadth', provider: 'gemini', model: ARGON, aa: 53, rotationIndex: 0, status: 'ok' },
    { role: 'breadth-flash', provider: 'gemini', model: FLASH, aa: 40, rotationIndex: 1, status: 'ok' },
  ];

  it('Argon WTU at 100% ⇒ breadth out on headroom, breadth-flash runs', () => {
    const d = decide(SHIPPED, [calibration(measured(NOW))], routes, { size: 'S', nowMs: NOW });
    expect(d).toEqual({ action: 'run', route: routes[1], reasons: [{ role: 'breadth', why: 'headroom' }] });
    expect(windowUsage(SHIPPED, [calibration(measured(NOW))], 'gemini', 'weekly', NOW, FLASH).usedPercent).toBe(31);
    expect(windowUsage(SHIPPED, [calibration(measured(NOW))], 'gemini', 'weekly', NOW, ARGON).usedPercent).toBe(100);
  });

  it('the %/token ratio learns only from the buckets the route draws on', () => {
    const n = calibration(measured(NOW));
    n.usageDeltas.push({ limitId: ID.argon, windowDurationMins: 10080, percentDelta: 40 });
    expect(estimateFor(SHIPPED, [n], 'gemini', 'S', FLASH).percent.weekly).toBeCloseTo(300_000 * 2 / 1_200_000);
    expect(estimateFor(SHIPPED, [n], 'gemini', 'S', ARGON).percent.weekly).toBeCloseTo(300_000 * 40 / 1_200_000);
  });

  it('check prices Flash with its own %/token ratio, not one learned on the Argon bucket', () => {
    const r = measured(NOW);
    r.windows[1].usedPercent = 80; // weekly headroom 85 - 80 = 5: room for 0.5, not for 10
    const n = calibration(r);
    n.usageDeltas.push({ limitId: ID.argon, windowDurationMins: 10080, percentDelta: 40 });
    expect(decide(SHIPPED, [n], [routes[1]], { size: 'S', nowMs: NOW })).toMatchObject({ action: 'run', route: routes[1] });
  });

  it('an unscoped bucket at the cap still stops both routes (wait for its reset)', () => {
    const d = decide(SHIPPED, [calibration(measured(NOW, { fiveH: 100 }))], routes, { size: 'S', nowMs: NOW });
    expect(d.action).toBe('wait');
    expect(d.reasons).toEqual([{ role: 'breadth', why: 'headroom' }, { role: 'breadth-flash', why: 'headroom' }]);
  });

  it('a wait names the reset of the route\'s own bucket, not the scoped one it does not draw on', () => {
    const r = measured(NOW);
    r.windows[1].usedPercent = 85; // Flash's weekly bucket at the 85% stop; resets in 48h, Argon's in 72h
    const d = decide(SHIPPED, [calibration(r)], [routes[1]], { size: 'S', nowMs: NOW });
    expect(d).toEqual({ action: 'wait', until: r.windows[1].resetsAt, reasons: [{ role: 'breadth-flash', why: 'headroom' }] });
  });

  it('a route without a model keeps today\'s pool-wide view', () => {
    const anon = routes.map(({ model: _m, ...r }) => r);
    expect(decide(SHIPPED, [calibration(measured(NOW))], anon, { size: 'S', nowMs: NOW }).reasons)
      .toEqual([{ role: 'breadth', why: 'headroom' }, { role: 'breadth-flash', why: 'headroom' }]);
  });
});

describe('--role auto: Argon out ⇒ Flash still runs (Q19)', () => {
  let dir: string;
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    process.exitCode = undefined;
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orchestra-q19-')));
    vi.stubEnv('ORCHESTRA_TREE_DIR', path.join(dir, 'tree'));
    vi.stubEnv('ORCHESTRA_LIVE_DIR', path.join(dir, 'live'));
    vi.stubEnv('ORCHESTRA_PLANS', EXAMPLE_PLANS);
    vi.stubEnv('ORCHESTRA_RANKING_FILE', path.join(dir, 'ranking.json'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.counter.mockImplementation(async (provider: string) => provider === 'gemini'
      ? measured(Date.now()) : { status: 'unavailable', reason: 'reader:unavailable' });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    const entry = (role: string, aa: number) => {
      const r = shipped.routes[role];
      return { model: r.model, effort: r.effort ?? r.variant ?? null, aa, access: [{ cli: r.cli, modelArg: r.model, effortArg: r.effort ?? r.variant ?? null }] };
    };
    writeFileSync(path.join(dir, 'ranking.json'), JSON.stringify({ schemaVersion: 1, source: 'test', observedAt: '2026-10-22',
      entries: [entry('breadth', 53), entry('breadth-flash', 45)] }));
    const policy = structuredClone(shipped);
    policy.developers.rotation.order = ['breadth', 'breadth-flash'];
    writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
    vi.stubEnv('ORCHESTRA_POLICY', path.join(dir, 'policy.json'));
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const node = () => JSON.parse(mocks.appendFile.mock.calls.filter(c => String(c[0]).startsWith(path.join(dir, 'tree')))[0][1]);
  const route = (role: string) => node().candidates.routes.find((r: { role: string }) => r.role === role);

  it.each([[[] as string[]], [['--size', 'S']]])('%j: breadth gated stop, breadth-flash eligible and dispatched', async extra => {
    await main(['--role', 'auto', '--task', 'q19', '--prompt', 'stable', ...extra]);
    expect(mocks.counter).toHaveBeenCalledWith('gemini');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][0]).toBe('agy');
    expect(mocks.spawn.mock.calls[0][1]).toContain(FLASH);
    expect(route('breadth')).toMatchObject({ gate: 'stop', excludedBy: 'budget-stop', eligible: false });
    expect(route('breadth-flash')).toMatchObject({ gate: 'ok', eligible: true });
    expect(node().candidates.chosen).toBe('breadth-flash');
  });

  it('a scoped bucket\'s past reset expires only its routes\' tree reading', async () => {
    const tree = path.join(dir, 'tree');
    const { mkdirSync: mk } = await vi.importActual<typeof import('node:fs')>('node:fs');
    mk(tree, { recursive: true });
    const now = Date.now();
    const reading = measured(now);
    reading.windows[2].resetsAt = new Date(now - 60_000).toISOString(); // the Argon bucket has since reset
    writeFileSync(path.join(tree, 'hist.jsonl'), `${JSON.stringify({ schemaVersion: 1, role: 'breadth', cli: 'agy', model: ARGON,
      exitCode: 0, usageAfter: reading, recordedAt: new Date(now - 120_000).toISOString() })}\n`);
    const routes = await main(['--list-routes', '--json']);
    const of = (role: string) => routes.find((r: { role: string }) => r.role === role);
    expect(of('breadth')).toMatchObject({ gate: 'ok', gateSource: 'until-stop' });
    expect(of('breadth-flash')).toMatchObject({ gate: 'ok', gateSource: 'tree' });
    expect(mocks.counter).not.toHaveBeenCalled();
  });

  it('--size S with a calibrated tree: decide prices Flash on its own buckets and runs it', async () => {
    // A tree run teaches the %/token ratio and carries the fresh reading, so decide prices every
    // window: on the pool-wide view Flash would wait on the Argon bucket's headroom.
    const tree = path.join(dir, 'tree');
    const { mkdirSync: mk } = await vi.importActual<typeof import('node:fs')>('node:fs');
    mk(tree, { recursive: true });
    writeFileSync(path.join(tree, 'hist.jsonl'), `${JSON.stringify({ schemaVersion: 1, role: 'breadth', cli: 'agy', model: ARGON,
      exitCode: 0, size: 'M', tokens: { metered: 1_200_000 },
      usageDeltas: [{ limitId: ID.weekly, windowDurationMins: 10080, percentDelta: 2 }, { limitId: ID.fiveH, windowDurationMins: 300, percentDelta: 2 }],
      usageAfter: measured(Date.now()), recordedAt: new Date(Date.now() - 60_000).toISOString() })}\n`);
    await main(['--role', 'auto', '--task', 'q19', '--prompt', 'stable', '--size', 'S']);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][1]).toContain(FLASH);
    expect(node().candidates.quota).toMatchObject({ action: 'run', role: 'breadth-flash' });
    expect(route('breadth')).toMatchObject({ gate: 'stop', gateSource: 'tree' });
  });
});
