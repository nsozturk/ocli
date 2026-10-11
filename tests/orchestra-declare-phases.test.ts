import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
// A fixed temp name, so a test can plant a link where the dispatcher will write.
vi.mock('node:crypto', async original => ({ ...(await original<typeof import('node:crypto')>()), randomUUID: () => 'fixed-uuid' }));
vi.mock('../dispatcher/usage.mjs', () => ({ readCodexUsage: vi.fn(), readGlmUsage: vi.fn(), claudeUsageFromLead: vi.fn(), usageDelta: vi.fn(), gateFor: vi.fn() }));
// @ts-expect-error plain ESM tooling
import { main } from '../dispatcher/dispatch.mjs';

// Real writes, under this agent's own scratch dir (tmp/ is gitignored and outside the vitest glob).
const LIVE = fileURLToPath(new URL('../tmp/agent-declared-phases/live', import.meta.url));
const plan = (task: string) => JSON.parse(readFileSync(`${LIVE}/${task}/plan.json`, 'utf8'));
const before = process.env.ORCHESTRA_LIVE_DIR;
beforeEach(() => {
  vi.resetAllMocks();
  rmSync(LIVE, { recursive: true, force: true });
  process.env.ORCHESTRA_LIVE_DIR = LIVE;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (before === undefined) delete process.env.ORCHESTRA_LIVE_DIR;
  else process.env.ORCHESTRA_LIVE_DIR = before;
});

it('writes plan.json with cleaned, deduped names in declared order, owner-only, and leaves no temp file', async () => {
  const at = Date.now();
  await main(['--declare-phases', 'implement, review,,# merge,implement,re\u001b[31mview,mu\u0007tate', '--task', 't1']);
  const written = plan('t1');
  expect(written).toMatchObject({ v: 1, phases: [{ name: 'implement' }, { name: 'review' }, { name: 'merge' }, { name: 'mutate' }] });
  expect(Object.keys(written).sort()).toEqual(['declaredAt', 'phases', 'v']);
  expect(Date.parse(written.declaredAt)).toBeGreaterThanOrEqual(at - 1000);
  expect(readdirSync(`${LIVE}/t1`)).toEqual(['plan.json']);
  expect(statSync(`${LIVE}/t1/plan.json`).mode & 0o777).toBe(0o600);
  expect(process.stderr.write).toHaveBeenCalledWith('[dispatch] declared 4 phases for t1\n');
});

it('spawns nothing, writes nothing beside the plan, and works without --role or --prompt', async () => {
  await main(['--declare-phases', 'a,b,c', '--task', 't1']);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(readdirSync(LIVE)).toEqual(['t1']);
  expect(plan('t1').phases.map((p: { name: string }) => p.name)).toEqual(['a', 'b', 'c']);
});

it('re-declaring replaces the plan by a rename, never rewriting the file a reader may hold open', async () => {
  await main(['--declare-phases', 'a,b,c', '--task', 't1']);
  const first = statSync(`${LIVE}/t1/plan.json`).ino;
  await main(['--declare-phases', 'x', '--task', 't1']);
  expect(plan('t1').phases).toEqual([{ name: 'x' }]);
  // A new inode: the old file was replaced whole (temp + rename), not truncated and rewritten in place.
  expect(statSync(`${LIVE}/t1/plan.json`).ino).not.toBe(first);
  expect(readdirSync(`${LIVE}/t1`)).toEqual(['plan.json']);
});

it('cuts each name to 40 code points and the plan to 50 phases', async () => {
  const names = Array.from({ length: 60 }, (_, i) => `p${i}-${'x'.repeat(50)}`);
  await main(['--declare-phases', names.join(','), '--task', 't1']);
  const phases = plan('t1').phases.map((p: { name: string }) => p.name);
  expect(phases.length).toBe(50);
  expect(phases[0]).toBe(names[0]!.slice(0, 40));
  expect(phases.every((n: string) => [...n].length === 40)).toBe(true);
});

it('rejects a bad --task, an empty plan and a missing value, writing nothing', async () => {
  for (const task of ['../x', '.hidden', '--share', 'a/b', '']) {
    await expect(main(['--declare-phases', 'a', '--task', task])).rejects.toThrow(/--task must match/);
  }
  await expect(main(['--declare-phases', 'a'])).rejects.toThrow(/--task must match/);
  await expect(main(['--declare-phases', ' , ,\u0007', '--task', 't1'])).rejects.toThrow(/no phase/);
  // parseArgs takes pairs: the flag last with no value is still the declare mode, and names nothing.
  await expect(main(['--task', 't1', '--declare-phases'])).rejects.toThrow(/no phase/);
  expect(existsSync(LIVE) ? readdirSync(LIVE).flatMap(d => readdirSync(`${LIVE}/${d}`)) : []).toEqual([]);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('never writes through a link planted at the temp path: it refuses, and the target is untouched', async () => {
  const victim = `${LIVE}/victim.txt`;
  mkdirSync(`${LIVE}/t1`, { recursive: true });
  writeFileSync(victim, 'precious');
  // Both the old predictable name (<pid>) and the one this run draws.
  for (const name of [`plan.json.${process.pid}.tmp`, 'plan.json.fixed-uuid.tmp']) symlinkSync(victim, `${LIVE}/t1/${name}`);
  await expect(main(['--declare-phases', 'a,b', '--task', 't1'])).rejects.toThrow(/EEXIST/);
  expect(readFileSync(victim, 'utf8')).toBe('precious');
  expect(existsSync(`${LIVE}/t1/plan.json`)).toBe(false);
  expect(lstatSync(`${LIVE}/t1/plan.json.fixed-uuid.tmp`).isSymbolicLink()).toBe(true);
});

it('a link at the old predictable temp name (<pid>) neither stops a declare nor is written through', async () => {
  const victim = `${LIVE}/victim.txt`;
  mkdirSync(`${LIVE}/t1`, { recursive: true });
  writeFileSync(victim, 'precious');
  symlinkSync(victim, `${LIVE}/t1/plan.json.${process.pid}.tmp`);
  await main(['--declare-phases', 'a,b', '--task', 't1']);
  expect(readFileSync(victim, 'utf8')).toBe('precious');
  expect(plan('t1').phases).toEqual([{ name: 'a' }, { name: 'b' }]);
});
