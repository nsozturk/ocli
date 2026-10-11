import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM tooling
import { digest, renderMarkdown, main } from '../dispatcher/digest.mjs';
// @ts-expect-error plain ESM tooling
import { readRegular } from '../dispatcher/digest.mjs';

const NOW = new Date('2026-10-11T06:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
let n = 0;
const node = (fields: Record<string, unknown> = {}) => ({
  runId: `r${++n}`, task: 't1', role: 'implement', phase: 'implement', cli: 'codex', exitCode: 0, blocked: false,
  score: null, ms: 60_000, recordedAt: at(1), witness: { v: 1, claims: [], findings: [] }, ...fields,
});
const end = (runId: string, fields: Record<string, unknown> = {}) => ({
  v: 1, runId, seq: 9, at: at(1), task: 't1', role: 'implement', cli: 'codex', kind: 'run.end',
  exitCode: 0, signal: null, ms: 60_000, status: 'completed', nodeId: 'x', score: null, dropped: {}, ...fields,
});
const phaseOf = (report: any, task: string, phase: string) =>
  report.tasks.find((t: any) => t.task === task).phases.find((p: any) => p.name === phase);

it('unscored runs are never counted as fails; score 0 is a fail and score 1 a pass', () => {
  const report = digest({ nodes: [node({ score: 1 }), node({ score: 0 }), node({ score: null }), node({ score: undefined })], now: NOW });
  const p = phaseOf(report, 't1', 'implement');
  expect(p.scored).toEqual({ pass: 1, fail: 1 });
  expect(p.unscored).toBe(2);
  expect(report.totals.scored).toEqual({ pass: 1, fail: 1 });
  expect(report.totals.unscored).toBe(2);
});

it('a declared phase with no run counts in total and not in done; an undeclared run phase is listed after', () => {
  const report = digest({
    nodes: [node({ phase: 'implement' }), node({ phase: 'hotfix' })],
    plans: [{ task: 't1', phases: [{ name: 'implement' }, { name: 'review' }], declaredAt: at(2) }],
    now: NOW,
  });
  const task = report.tasks[0];
  expect(task.declared).toEqual(['implement', 'review']);
  expect(task.phases.map((p: any) => [p.name, p.declared, p.runs])).toEqual([['implement', true, 1], ['review', true, 0], ['hotfix', false, 1]]);
  expect([task.done, task.total]).toEqual([2, 3]);
});

it('a node without a phase falls back to its role, and lead-corrections are skipped and counted', () => {
  const old = node({ role: 'reason' });
  delete (old as any).phase;
  const report = digest({ nodes: [old, node({ role: 'lead-correction', phase: undefined })], now: NOW });
  expect(report.tasks[0].phases.map((p: any) => p.name)).toEqual(['reason']);
  expect(report.totals.leadCorrections).toBe(1);
  expect(report.totals.runs).toBe(1);
});

it('since: recordedAt >= since is kept, older is dropped, undated is excluded and counted; default is 12 h', () => {
  const undated = node();
  delete (undated as any).recordedAt;
  const nodes = [node({ recordedAt: at(11.9) }), node({ recordedAt: at(12.1) }), node({ recordedAt: at(3) }), undated, node({ recordedAt: 'nope' })];
  const byDefault = digest({ nodes, now: NOW });
  expect(byDefault.since).toBe(at(12));
  expect(byDefault.totals.runs).toBe(2);
  expect(byDefault.totals.undated).toBe(2);
  const narrow = digest({ nodes, since: at(3), now: NOW });
  expect(narrow.totals.runs).toBe(1); // exactly at since is kept
  expect(digest({ nodes, since: at(2.9), now: NOW }).totals.runs).toBe(0);
});

it('status comes from the matched run.end, else from the node; ends without a node are counted runs', () => {
  const a = node({ exitCode: 0 });
  const b = node({ exitCode: 3 });
  const c = node({ exitCode: 1, blocked: true, blockedCheck: 'usage confirms exhaustion (codex_5h at 100%)' });
  const d = node({ exitCode: 0 });
  const report = digest({
    nodes: [a, b, c, d],
    ends: [end(d.runId, { status: 'spawn-error' }), end('orphan', { status: 'dispatch-error', nodeId: null }), end('killed', { status: 'failed', at: at(13) })],
    now: NOW,
  });
  expect(phaseOf(report, 't1', 'implement').byStatus).toEqual({ completed: 1, failed: 1, blocked: 1, 'spawn-error': 1, 'dispatch-error': 1 });
  expect(report.totals.endsWithoutNode).toBe(1);
});

it('witness codes are summed per phase; blockedCheck is cleaned and cut to 160 for the decision list', () => {
  const report = digest({
    nodes: [
      node({ witness: { v: 1, claims: [], findings: [{ code: 'doneNoChange', text: 'x' }, { code: 'staleGreen', text: 'y' }] } }),
      node({ witness: { v: 1, claims: [], findings: [{ code: 'doneNoChange', text: 'z' }] } }),
      node({ witness: { v: 1, error: 'boom' } }),
      node({ exitCode: 1, blocked: true, blockedCheck: `\u001b[31m${'w'.repeat(300)}` }),
    ],
    now: NOW,
  });
  expect(phaseOf(report, 't1', 'implement').witness).toEqual({ doneNoChange: 2, staleGreen: 1 });
  const blocked = report.decisions.find((d: any) => d.status === 'blocked');
  expect(blocked.blockedCheck).toBe('w'.repeat(160));
  // Unscored with witness findings: both such runs need a decision; a clean unscored run does not.
  expect(report.decisions.filter((d: any) => d.status === 'completed').length).toBe(2);
});

it('markdown prints "pass a/b scored · c unscored" and never a percentage over the runs', () => {
  const report = digest({
    nodes: [node({ score: 1 }), node({ score: 1 }), node({ score: 1 }), node({ score: 0 }), node({ score: 0 }),
      node({ score: null }), node({ score: null }), node({ score: null }), node({ score: null }),
      node({ exitCode: 1, blocked: true, blockedCheck: 'usage confirms exhaustion (codex_5h at 100%)' })],
    plans: [{ task: 't1', phases: [{ name: 'implement' }, { name: 'review' }], declaredAt: at(1) }],
    now: NOW,
  });
  const md = renderMarkdown(report);
  expect(md.startsWith(`# ocli digest since ${at(12)}\n`)).toBe(true);
  expect(md).toContain('## t1 · 1/2 phases');
  const implement = md.split('\n').find((line: string) => line.startsWith('- implement'))!;
  expect(implement).toContain('pass 3/5 scored · 5 unscored');
  expect(implement).not.toMatch(/%/);
  expect(md.split('\n').find((line: string) => line.startsWith('- review'))).toMatch(/no run/);
  // Only the blocked run's own evidence may carry a percent sign.
  const before = md.split('## Needs a decision')[0];
  expect(before).not.toMatch(/%/);
  expect(md).toMatch(/## Needs a decision\n[\s\S]*blocked[\s\S]*codex\\_5h at 100%/);
});

it('tokens nobody reported stay unknown, never 0', () => {
  const a = node();
  const report = digest({ nodes: [a, node()], ends: [{ ...end(a.runId), kind: 'usage', input: 7, output: null }], now: NOW });
  expect(phaseOf(report, 't1', 'implement').tokens).toEqual({ input: 7, output: null });
  const bare = digest({ nodes: [node()], now: NOW });
  expect(bare.totals.tokens).toEqual({ input: null, output: null });
  expect(renderMarkdown(bare)).toContain('tokens unreported');
});

it('markdown escapes link and html syntax in a phase name', () => {
  const md = renderMarkdown(digest({ nodes: [node({ phase: '[x](https://evil.example) <b>' })], now: NOW }));
  expect(md).not.toContain('[x](');
  expect(md).toContain('\\[x\\]');
  expect(md).not.toContain('<b>');
});

// main() against a temp orchestra dir: tree/ and live/ under this agent's own scratch dir.
const ROOT = fileURLToPath(new URL('../tmp/agent-night-digest/orchestra', import.meta.url));
let out = '';
beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/tree`, { recursive: true });
  mkdirSync(`${ROOT}/live/t1`, { recursive: true });
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

it('main reads the tree, the run.end and usage lines (never .raw), and the plans; --json prints the shape', async () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const a = node({ recordedAt: recent, task: 't1', score: 1 });
  writeFileSync(`${ROOT}/tree/t1.jsonl`, `${JSON.stringify(a)}\nnot json\n`);
  writeFileSync(`${ROOT}/live/t1/${a.runId}.jsonl`, [
    JSON.stringify({ ...end(a.runId), kind: 'usage', input: 100, output: 20 }),
    JSON.stringify({ ...end(a.runId), kind: 'usage', input: 5, output: null }),
    JSON.stringify(end(a.runId, { at: recent, status: 'blocked' })),
    '{"torn',
  ].join('\n'));
  writeFileSync(`${ROOT}/live/t1/${a.runId}.raw.jsonl`, `${JSON.stringify(end(a.runId, { status: 'failed' }))}\n`);
  writeFileSync(`${ROOT}/live/t1/plan.json`, JSON.stringify({ v: 1, phases: [{ name: 'implement' }, { name: 'review' }], declaredAt: recent }));
  const listing = () => JSON.stringify(readdirSync(ROOT, { recursive: true }).sort());
  const filesBefore = listing();

  await main(['--root', ROOT, '--json', 'any']);
  const report = JSON.parse(out);
  expect(Object.keys(report)).toEqual(expect.arrayContaining(['since', 'tasks', 'totals']));
  const p = report.tasks[0].phases[0];
  expect(p).toMatchObject({ name: 'implement', declared: true, runs: 1, scored: { pass: 1, fail: 0 }, unscored: 0, ms: 60_000, witness: {} });
  expect(p.byStatus).toEqual({ completed: 0, failed: 0, blocked: 1, 'spawn-error': 0, 'dispatch-error': 0 });
  expect(p.tokens).toEqual({ input: 105, output: 20 });
  expect([report.tasks[0].done, report.tasks[0].total]).toEqual([1, 2]);
  expect(report.totals.unreadable).toEqual({ treeLines: 1, liveLines: 1, plans: 0, treeFiles: 0, liveFiles: 0 });

  out = '';
  await main(['--root', ROOT, '--since', new Date(Date.now() - 600_000).toISOString()]);
  expect(out).toMatch(/^# ocli digest since /);
  expect(out).not.toContain('## t1'); // recorded an hour ago, before --since
  expect(listing()).toBe(filesBefore); // read-only
});

it('main: a missing live dir is not fatal, a stale live file is skipped by mtime, a bad --since is refused', async () => {
  rmSync(`${ROOT}/live`, { recursive: true, force: true });
  await main(['--root', ROOT]);
  expect(out).toMatch(/^# ocli digest since /);
  expect(out).toContain('no live dir');

  mkdirSync(`${ROOT}/live/t1`, { recursive: true });
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const a = node({ recordedAt: recent });
  writeFileSync(`${ROOT}/tree/t1.jsonl`, `${JSON.stringify(a)}\n`);
  writeFileSync(`${ROOT}/live/t1/old.jsonl`, `${JSON.stringify(end(a.runId, { status: 'blocked' }))}\n`);
  const old = new Date(Date.now() - 48 * 3_600_000);
  utimesSync(`${ROOT}/live/t1/old.jsonl`, old, old);
  out = '';
  await main(['--root', ROOT, '--json', '1']);
  expect(JSON.parse(out).tasks[0].phases[0].byStatus.completed).toBe(1);

  await expect(main(['--root', ROOT, '--since', 'yesterday'])).rejects.toThrow(/--since/);
  await expect(main(['--root', ROOT, '--bogus', 'x'])).rejects.toThrow(/--bogus/);
});

// Review round (night-digest): each test below failed before its fix.

it('a run.end with no node is filed under its run.start phase, not its role', () => {
  const report = digest({
    ends: [
      { kind: 'run.start', runId: 'k', task: 't1', role: 'implement', phase: 'review', at: at(1) },
      end('k', { status: 'failed', nodeId: null }),
      end('k2', { status: 'dispatch-error', nodeId: null }), // no run.start either: the role stands in
    ],
    plans: [{ task: 't1', phases: [{ name: 'build' }, { name: 'review' }], declaredAt: at(2) }],
    now: NOW,
  });
  const task = report.tasks[0];
  expect(task.phases.map((p: any) => [p.name, p.declared, p.runs])).toEqual([['build', true, 0], ['review', true, 1], ['implement', false, 1]]);
  expect([task.done, task.total]).toEqual([2, 3]);
});

it('a declared phase that ran only before the window counts as done and says so, not "declared, no run"', () => {
  const report = digest({
    nodes: [node({ phase: 'build', score: 1, recordedAt: at(13) }), node({ phase: 'review', score: 1, recordedAt: at(1) })],
    plans: [{ task: 't1', phases: [{ name: 'build' }, { name: 'review' }], declaredAt: at(14) }],
    now: NOW,
  });
  const build = phaseOf(report, 't1', 'build');
  expect([build.runs, build.earlier]).toEqual([0, 1]);
  expect(build.scored).toEqual({ pass: 0, fail: 0 }); // the window's counts stay the window's
  expect([report.tasks[0].done, report.tasks[0].total]).toEqual([2, 2]);
  const md = renderMarkdown(report);
  expect(md).toContain('## t1 · 2/2 phases');
  const line = md.split('\n').find((l: string) => l.startsWith('- build'))!;
  expect(line).not.toMatch(/declared, no run/);
  expect(line).toContain('1 earlier run');
  // A task with nothing in the window still stays out, earlier runs or not.
  expect(digest({ nodes: [node({ recordedAt: at(13) })], now: NOW }).tasks).toEqual([]);
});

it('summed run time is labelled a sum; a task line carries its wall span, unknown when a run has no ms', () => {
  const report = digest({ nodes: [node({ ms: 3_600_000, recordedAt: at(1) }), node({ ms: 3_600_000, recordedAt: at(1) })], now: NOW });
  expect(report.tasks[0].wallMs).toBe(3_600_000);
  const md = renderMarkdown(report);
  expect(md).toContain('run time 2h00m summed');
  expect(md).toContain('## t1 · 1/1 phases · wall 1h00m');
  expect(digest({ nodes: [node({ ms: 1000 }), node({ ms: null })], now: NOW }).tasks[0].wallMs).toBe(null);
});

it('witness codes that name Object.prototype members are counted like any other', () => {
  const report = digest({
    nodes: [node({ witness: { findings: [{ code: 'constructor' }, { code: '__proto__' }, { code: 'toString' }, { code: 'toString' }] } })],
    now: NOW,
  });
  for (const counts of [phaseOf(report, 't1', 'implement').witness, report.totals.witness]) {
    expect(Object.entries(counts)).toEqual([['constructor', 1], ['__proto__', 1], ['toString', 2]]);
  }
  expect(JSON.parse(JSON.stringify(report.totals)).witness).toEqual(JSON.parse('{"constructor":1,"__proto__":1,"toString":2}'));
  expect(renderMarkdown(report)).toContain('witness constructor×1, \\_\\_proto\\_\\_×1, toString×2');
});

it('markdown escapes autolinks, entities, emphasis and strikethrough in untrusted text', () => {
  const md = renderMarkdown(digest({
    nodes: [node({ phase: 'a&#8238;b _x_ ~~y~~', exitCode: 1, blocked: true,
      blockedCheck: 'see https://evil.example/login or www.evil.example or me@evil.example' })],
    now: NOW,
  }));
  expect(md).toContain('a\\&#8238;b \\_x\\_ \\~\\~y\\~\\~');
  expect(md).toContain('https\\://evil.example/login');
  expect(md).toContain('www\\.evil.example');
  expect(md).toContain('me\\@evil.example');
  expect(md).not.toMatch(/(^|[^\\])(https?:\/\/|www\.|&#|@evil)/m);
});

it('main: an unreadable live or tree file is counted and skipped, not fatal', async () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const a = node({ recordedAt: recent });
  writeFileSync(`${ROOT}/tree/t1.jsonl`, `${JSON.stringify(a)}\n`);
  writeFileSync(`${ROOT}/tree/t2.jsonl`, `${JSON.stringify(node({ task: 't2', recordedAt: recent }))}\n`);
  writeFileSync(`${ROOT}/live/t1/a.jsonl`, `${JSON.stringify(end(a.runId, { at: recent, status: 'blocked' }))}\n`);
  writeFileSync(`${ROOT}/live/t1/b.jsonl`, '{}\n');
  chmodSync(`${ROOT}/tree/t2.jsonl`, 0);
  chmodSync(`${ROOT}/live/t1/b.jsonl`, 0);
  try {
    await main(['--root', ROOT, '--json', '1']);
  } finally {
    chmodSync(`${ROOT}/tree/t2.jsonl`, 0o600);
    chmodSync(`${ROOT}/live/t1/b.jsonl`, 0o600);
  }
  const report = JSON.parse(out);
  expect(report.tasks.map((t: any) => t.task)).toEqual(['t1']);
  expect(report.tasks[0].phases[0].byStatus.blocked).toBe(1);
  expect(report.totals.unreadable).toMatchObject({ treeFiles: 1, liveFiles: 1 });
  out = '';
  chmodSync(`${ROOT}/live/t1/b.jsonl`, 0);
  try { await main(['--root', ROOT]); } finally { chmodSync(`${ROOT}/live/t1/b.jsonl`, 0o600); }
  expect(out).toContain('1 unreadable live files');
});

it('main: a symlinked tree or live file is never followed', async () => {
  const outside = `${ROOT}/outside`;
  mkdirSync(outside, { recursive: true });
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const secret = node({ task: 'OUTSIDE-SECRET', recordedAt: recent });
  writeFileSync(`${outside}/s.jsonl`, `${JSON.stringify(secret)}\n`);
  writeFileSync(`${outside}/e.jsonl`, `${JSON.stringify(end('x', { task: 'OUTSIDE-END', at: recent }))}\n`);
  symlinkSync(`${outside}/s.jsonl`, `${ROOT}/tree/link.jsonl`);
  symlinkSync(`${outside}/e.jsonl`, `${ROOT}/live/t1/link.jsonl`);
  await main(['--root', ROOT, '--json', '1']);
  expect(out).not.toContain('OUTSIDE');
  expect(JSON.parse(out).totals.unreadable).toMatchObject({ treeFiles: 0, liveFiles: 0 }); // skipped at the listing
  // And a link swapped in after the listing is refused at the open.
  await expect(readRegular(`${ROOT}/tree/link.jsonl`)).rejects.toThrow();
  expect(await readRegular(`${outside}/s.jsonl`)).toContain('OUTSIDE-SECRET');
});

it('main: a killed run (run.start and run.end, no tree node) is filed under its --phase', async () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(`${ROOT}/live/t1/k.jsonl`, [
    JSON.stringify({ v: 1, runId: 'k', seq: 0, at: recent, task: 't1', role: 'implement', cli: 'codex', kind: 'run.start', phase: 'review' }),
    JSON.stringify(end('k', { at: recent, status: 'failed', nodeId: null, exitCode: null, ms: null })),
  ].join('\n'));
  writeFileSync(`${ROOT}/live/t1/plan.json`, JSON.stringify({ v: 1, phases: [{ name: 'build' }, { name: 'review' }], declaredAt: recent }));
  await main(['--root', ROOT, '--json', '1']);
  const task = JSON.parse(out).tasks[0];
  expect(task.phases.map((p: any) => [p.name, p.runs])).toEqual([['build', 0], ['review', 1]]);
});
