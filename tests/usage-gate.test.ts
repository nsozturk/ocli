import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { bindingWindow, gateFor, budget, headroomOf } from '../dispatcher/usage.mjs';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { EXAMPLE_PLANS } from '../dispatcher/plans.mjs';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { latestReading } from '../dispatcher/tree-read.mjs';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { decideBlocked } from '../dispatcher/dispatch.mjs';

// Ported from the canonical Senatus orchestra tests (Q1, Q3, Q13f, Q4/Q5). The cap is the user's
// plan, read from budget(); tests/setup-plans.ts pins the shipped example for every suite.
const CAP: number = budget().codex.stopAtPercent;

const w = (limitId: string, usedPercent: number, windowDurationMins: number | null, resetsAt: string | null = null) =>
  ({ limitId, usedPercent, windowDurationMins, resetsAt, model: null });

describe('usage.mjs caps come from the plans, not a hardcoded table', () => {
  it('the shipped example stops codex at 95 (100 - reserve 5): the mirror no longer says 45', () => {
    expect(budget().codex).toEqual({ stopAtPercent: 95, limitIds: ['codex'] });
  });
});

describe('usage.mjs gateFor — may this developer still be dispatched to', () => {
  const ok = (limitId: string, usedPercent: number) => ({ status: 'ok', windows: [w(limitId, usedPercent, 10080)] });

  it('allows codex below its cap and reports the headroom', () => {
    const gate = gateFor('codex', ok('codex', 6));
    expect(gate.state).toBe('ok');
    expect(gate.headroomPercent).toBe(CAP - 6);
  });

  it('stops codex at the cap, and at the cap exactly — not one point past it', () => {
    expect(gateFor('codex', ok('codex', CAP)).state).toBe('stop');
    expect(gateFor('codex', ok('codex', CAP - 1)).state).toBe('ok');
  });

  it('dispatches an UNCAPPED developer even when its usage cannot be read at all', () => {
    expect(gateFor('glm', { status: 'unknown', windows: [] }).state).toBe('ok');
    // Lead decision (Q5 merge): claude is a counter pool but until-stop until a lead snapshot reader
    // exists (Q13), so an unreadable claude is not a cap.
    expect(gateFor('claude', { status: 'unknown', windows: [] }).state).toBe('ok');
  });

  it('refuses to treat an unreadable CAPPED developer as having room', () => {
    expect(gateFor('codex', { status: 'unavailable', reason: 'app-server refused', windows: [] }).state).toBe('unknown');
  });
});

describe('usage.mjs Q1 — the gate binds on EVERY scoped window, weekly included', () => {
  const report = (...windows: ReturnType<typeof w>[]) => ({ status: 'ok', windows });

  it('stops codex when the weekly window is at the cap even though the 5-hour window has room', () => {
    const gate = gateFor('codex', report(w('codex', 10, 300), w('codex', 96, 10080)));
    expect(gate.state).toBe('stop');
    expect(gate.window.windowDurationMins).toBe(10080);
    expect(gate.window.usedPercent).toBe(96);
  });

  it('stops codex when the 5-hour window is at the cap and the weekly has room', () => {
    const gate = gateFor('codex', report(w('codex', 10, 10080), w('codex', 96, 300)));
    expect(gate.state).toBe('stop');
    expect(gate.window.windowDurationMins).toBe(300);
  });

  it('stops at the cap exactly on a non-first weekly window', () => {
    expect(gateFor('codex', report(w('codex', 1, 300), w('codex', CAP, 10080))).state).toBe('stop');
    expect(gateFor('codex', report(w('codex', 1, 300), w('codex', CAP - 1, 10080))).state).toBe('ok');
  });

  it('when both are under the cap, reports headroom against the fullest window', () => {
    const gate = gateFor('codex', report(w('codex', 30, 300), w('codex', 70, 10080)));
    expect(gate.state).toBe('ok');
    expect(gate.window.usedPercent).toBe(70);
    expect(gate.headroomPercent).toBe(CAP - 70);
  });

  it('still ignores pools the route does not consume, whichever is fullest', () => {
    const gate = gateFor('codex', report(w('codex', 5, 300), w('base_model_inference', 99, 10080), w('codex', 20, 10080)));
    expect(gate.state).toBe('ok');
    expect(gate.window.limitId).toBe('codex');
    expect(gate.headroomPercent).toBe(CAP - 20);
  });

  it('headroomOf picks the fullest scoped window of any duration and is null when none is scoped', () => {
    const windows = [w('codex', 10, 300), w('other', 99, 300), w('codex', 60, 10080)];
    const h = headroomOf(windows, ['codex'], 95);
    expect(h.window.usedPercent).toBe(60);
    expect(h.headroomPercent).toBe(35);
    expect(headroomOf(windows, ['nothing'], 95)).toEqual({ window: null, headroomPercent: null });
    expect(headroomOf([], ['codex'], 95)).toEqual({ window: null, headroomPercent: null });
    expect(headroomOf(windows, null, 95).window.usedPercent).toBe(99);
  });

  it('Q13f: a scoped window without a readable percentage makes the whole gate unknown, never ok', () => {
    const gate = gateFor('codex', { status: 'ok', windows: [
      { limitId: 'codex', windowDurationMins: 300 },
      { limitId: 'codex', usedPercent: 96, windowDurationMins: 10080 },
    ] });
    expect(gate.state).toBe('unknown');
    expect(gate.headroomPercent).toBeUndefined();
    for (const bad of [null, '96', Number.NaN, Infinity]) {
      expect(headroomOf([w('codex', 10, 300), { ...w('codex', 0, 10080), usedPercent: bad }], ['codex'], 95))
        .toEqual({ window: null, headroomPercent: null });
    }
    // An unreadable window in a pool the route does not consume is not this route's problem.
    expect(headroomOf([w('codex', 10, 300), { limitId: 'other', windowDurationMins: 300 }], ['codex'], 95).window.usedPercent).toBe(10);
  });

  it('Q13f: an ok report with no windows field at all gates unknown', () => {
    expect(gateFor('codex', { status: 'ok' }).state).toBe('unknown');
  });

  it('leaves bindingWindow on the 5-hour preference that usageDelta depends on', () => {
    expect(bindingWindow([w('codex', 96, 10080), w('codex', 10, 300)], ['codex'])?.windowDurationMins).toBe(300);
  });

  it('decideBlocked reads a weekly window at 99% as exhausted while the 5-hour window has room', async () => {
    const quoted = 'Quota/rate limit: use the next eligible ranked model.';
    const weeklyOut = async () => ({ status: 'ok', exhausted: false, windows: [w('codex', 10, 300), w('codex', 99, 10080)] });
    const decision = await decideBlocked({ result: { code: 0, stdout: quoted, stderr: '' }, role: 'reason', readUsage: weeklyOut });
    expect(decision.blocked).toBe(true);
    expect(decision.blockedCheck).toMatch(/confirms exhaustion \(codex at 99%\)/);
  });
});

describe('tree-read.mjs latestReading — Q3/Q13f: a reading from before its window reset is expired', () => {
  const resetsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const later = Date.now() + 30 * 86_400_000;
  const codexNode = (windows: ReturnType<typeof w>[]) =>
    ({ role: 'reason', cli: 'codex', model: 'gpt-6-astra', recordedAt: '2026-10-17T09:00:00Z', usageAfter: { status: 'ok', windows } });

  it('is expired once the reset is at or before now, current one ms before it', () => {
    const nodes = [codexNode([w('codex', CAP, 10080, resetsAt)])];
    const resetMs = Date.parse(resetsAt);
    expect(latestReading(nodes, 'codex', resetMs)).toMatchObject({ expired: true, expiredResetsAt: resetsAt });
    expect(latestReading(nodes, 'codex', resetMs - 1)).toMatchObject({ expired: false, expiredResetsAt: null });
    expect(latestReading(nodes, 'codex', resetMs).window.usedPercent).toBe(CAP); // still returned: it is what was recorded
  });

  it('defaults to the real clock: a past reset is expired, a future one is not', () => {
    expect(latestReading([codexNode([w('codex', CAP, 10080, '2026-01-01T00:00:00Z')])], 'codex').expired).toBe(true);
    expect(latestReading([codexNode([w('codex', CAP, 10080, resetsAt)])], 'codex').expired).toBe(false);
  });

  it('ANY scoped window past its reset expires the reading, not only the 5-hour binding one', () => {
    const fiveHourResets = new Date(Date.now() + 40 * 86_400_000).toISOString(); // after `later`
    const nodes = [codexNode([w('codex', 10, 300, fiveHourResets), w('codex', 96, 10080, resetsAt)])];
    const reading = latestReading(nodes, 'codex', later);
    expect(reading.window.windowDurationMins).toBe(300); // binding window keeps its 5h preference
    expect(reading.expired).toBe(true);
    expect(reading.expiredResetsAt).toBe(resetsAt);
    expect(latestReading(nodes, 'codex', Date.now()).expired).toBe(false);
  });

  it('a reset window in a pool the route does not consume does not expire the reading', () => {
    const nodes = [codexNode([w('codex', 10, 300, new Date(Date.now() + 40 * 86_400_000).toISOString()),
      w('base_model_inference', 50, 10080, resetsAt)])];
    expect(latestReading(nodes, 'codex', later).expired).toBe(false);
  });

  it('a missing or unparseable resetsAt cannot be dated: not expired', () => {
    expect(latestReading([codexNode([w('codex', CAP, 10080, null)])], 'codex', later).expired).toBe(false);
    expect(latestReading([codexNode([w('codex', CAP, 10080, 'soon')])], 'codex', later).expired).toBe(false);
  });
});

describe('usage.mjs Q5 — caps come from the provider plans', () => {
  const example = JSON.parse(readFileSync(EXAMPLE_PLANS, 'utf8'));
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A fresh usage.mjs (its budget() memo is per process) reading `text` as ORCHESTRA_PLANS. */
  async function freshUsage(text: string | null, { home }: { home?: string } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'm1-plans-'));
    dirs.push(dir);
    if (text === null) vi.stubEnv('ORCHESTRA_PLANS', '');
    else {
      writeFileSync(path.join(dir, 'plans.json'), text);
      vi.stubEnv('ORCHESTRA_PLANS', path.join(dir, 'plans.json'));
    }
    vi.stubEnv('HOME', home ?? dir); // never the user's real ~/.config/agent-rules
    vi.resetModules();
    // @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
    return import('../dispatcher/usage.mjs');
  }
  const withReserve = (provider: string, reservePercent: number) => {
    const doc = structuredClone(example);
    doc.providers[provider].reservePercent = reservePercent;
    return JSON.stringify(doc);
  };
  const codexAt = (...used: [number, number][]) => ({
    status: 'ok',
    windows: used.map(([usedPercent, windowDurationMins]) => ({ limitId: 'codex', usedPercent, windowDurationMins, resetsAt: null })),
  });

  it('a plans file with codex reserve 10 stops codex at 90, not 95', async () => {
    const u = await freshUsage(withReserve('codex', 10));
    expect(u.budget().codex).toEqual({ stopAtPercent: 90, limitIds: ['codex'] });
    expect(u.gateFor('codex', codexAt([90, 10080], [10, 300])).state).toBe('stop');
    expect(u.gateFor('codex', codexAt([89, 10080])).reason).toContain('90% cap');
    expect(u.gateFor('codex', codexAt([89, 10080])).headroomPercent).toBe(1);
  });

  it('derives the budgeted rows from the plans: counter pools capped at 100 - reserve, the rest uncapped with a note', async () => {
    const u = await freshUsage(JSON.stringify(example));
    const b = u.budget();
    expect(Object.keys(b).sort()).toEqual(['claude', 'codex', 'glm']);
    expect(b.claude.stopAtPercent).toBeNull(); // until-stop until Q13 (lead decision)
    expect(b.glm.stopAtPercent).toBeNull();
    expect(b.glm.note).toMatch(/glm-coding-lite/);
    expect(u.budget()).toBe(b); // memoized per process
    expect(u.plansError()).toBeNull();
  });

  it.each([
    ['not JSON', '{'],
    ['schemaVersion 2', JSON.stringify({ ...example, schemaVersion: 2 })],
  ])('a plans file that fails to parse (%s) gates every counter provider unknown, never ok', async (_label, text) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const u = await freshUsage(text);
    for (const provider of ['codex', 'claude']) {
      const gate = u.gateFor(provider, codexAt([1, 300]));
      expect(gate.state, provider).toBe('unknown');
      expect(gate.reason).toMatch(/plans/);
    }
    expect(u.plansError()).toMatch(/plans/);
    u.budget();
    u.gateFor('codex', codexAt([1, 300]));
    expect(stderr.mock.calls.filter(([t]) => /plans/.test(String(t)))).toHaveLength(1);
  });

  it('a plans file without a budgeted developer is a plans error, never that developer uncapped', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const doc = structuredClone(example);
    delete doc.providers.claude;
    doc.lead.provider = 'codex';
    const u = await freshUsage(JSON.stringify(doc));
    expect(u.plansError()).toMatch(/providers\.claude/);
    expect(u.gateFor('codex', codexAt([1, 300])).state).toBe('unknown');
    expect(u.gateFor('gemini', codexAt([1, 300])).state).toBe('ok'); // unbudgeted: no cap either way
  });

  it('the shipped example as the source prints exactly ONE stderr warning per process', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const u = await freshUsage(null); // no ORCHESTRA_PLANS, an empty HOME: falls to the example
    u.budget();
    u.gateFor('codex', codexAt([1, 300]));
    u.budget();
    const warnings = stderr.mock.calls.map(([t]) => String(t)).filter(t => /shipped example plans/.test(t));
    expect(warnings).toEqual(['[usage] using the shipped example plans; create ~/.config/agent-rules/provider-plans.json\n']);
    expect(u.budget().codex.stopAtPercent).toBe(95);
  });

  it('a valid global plans file (no ORCHESTRA_PLANS) is read and warns nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const home = mkdtempSync(path.join(tmpdir(), 'm1-home-'));
    dirs.push(home);
    mkdirSync(path.join(home, '.config', 'agent-rules'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'agent-rules', 'provider-plans.json'), withReserve('codex', 10));
    const u = await freshUsage(null, { home });
    expect(u.budget().codex.stopAtPercent).toBe(90);
    u.gateFor('codex', codexAt([1, 300]));
    expect(stderr.mock.calls.filter(([t]) => /shipped example plans/.test(String(t)))).toHaveLength(0);
  });

  it('a plans file named by ORCHESTRA_PLANS warns nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const u = await freshUsage(JSON.stringify(example));
    u.gateFor('codex', codexAt([1, 300]));
    expect(stderr).not.toHaveBeenCalled();
  });
});
