import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { meteredOf, windowUsage, capacityFor, headroomFor, estimateFor, decide } from '../dispatcher/quota.mjs';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { parsePlans, EXAMPLE_PLANS } from '../dispatcher/plans.mjs';

// Q11a: quota.mjs is pure. Every input is handed in (plans, nodes, nowMs); nothing here reads the
// real tree, the real plans file or the clock.
type Json = Record<string, any>;
const exampleText = readFileSync(EXAMPLE_PLANS, 'utf8');
/** The shipped example, edited, then put through the strict parser so a fixture can never drift
 * from the schema the real loader enforces. */
const plansWith = (edit: (doc: Json) => void = () => {}) => {
  const doc = JSON.parse(exampleText);
  edit(doc);
  return parsePlans(JSON.stringify(doc));
};
const PLANS = plansWith();

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MIN = 60_000;
const at = (minsAgo: number) => new Date(NOW - minsAgo * MIN).toISOString();

const glm = (minsAgo: number, metered: number | null, over: Json = {}) => ({
  role: 'implement', cli: 'opencode', model: 'zai-coding-plan/glm-5.3', task: 'fixture', exitCode: 0,
  recordedAt: at(minsAgo), size: 'M', tokens: metered == null ? null : { metered }, ...over,
});
const gemini = (minsAgo: number, metered: number | null, over: Json = {}) =>
  glm(minsAgo, metered, { role: 'breadth', cli: 'agy', model: 'gemini-4-argon-high', ...over });
/** A run the provider stopped: `resetsInMins` after its own recordedAt (≤ 300 ⇒ a 5h window). */
const glmStop = (minsAgo: number, metered: number | null, resetsInMins: number, over: Json = {}) =>
  glm(minsAgo, metered, {
    exitCode: 1,
    providerStop: { provider: 'zai', resetsAt: new Date(NOW - (minsAgo - resetsInMins) * MIN).toISOString(), evidence: 'limit' },
    ...over,
  });

const win = (limitId: string, usedPercent: number | null, windowDurationMins: number, resetsAt: string | null) =>
  ({ limitId, usedPercent, windowDurationMins, resetsAt, model: null });
const FUTURE = new Date(NOW + 120 * MIN).toISOString();
const codex = (minsAgo: number, windows: unknown[], over: Json = {}) => ({
  role: 'reason', cli: 'codex', model: 'gpt-6-astra', task: 'fixture', exitCode: 0,
  recordedAt: at(minsAgo), usageAfter: { status: 'ok', windows }, ...over,
});
const codexFresh = (fiveH: number, weekly: number, minsAgo = 5) => codex(minsAgo, [
  win('codex', fiveH, 300, FUTURE),
  win('codex', weekly, 10080, FUTURE),
  win('base_model_inference', 99, 10080, FUTURE), // another pool: never this route's number
]);

describe('purity', () => {
  it('never loads a plans file itself: it reads only the plans it is handed', async () => {
    // A fresh module graph, so usage.mjs's per-process plans memo is empty; a read of the (broken)
    // ORCHESTRA_PLANS would report on stderr.
    vi.resetModules();
    vi.stubEnv('ORCHESTRA_PLANS', '/nonexistent/q11a-plans.json');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
      const q = await import('../dispatcher/quota.mjs');
      expect(q.headroomFor(PLANS, [codexFresh(40, 70)], 'codex', NOW).min.headroom).toBe(25);
      q.headroomFor(PLANS, [glm(60, 1)], 'glm', NOW);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('meteredOf', () => {
  it('takes the recorded metered tokens when they are a finite number (0 included)', () => {
    expect(meteredOf(glm(1, 123_456), PLANS)).toBe(123_456);
    expect(meteredOf(glm(1, 0), PLANS)).toBe(0);
  });
  it('a node without tokens counts as its size prior, never 0; no size ⇒ the L prior', () => {
    expect(meteredOf(glm(1, null, { size: 'S' }), PLANS)).toBe(300_000);
    expect(meteredOf(glm(1, null, { size: 'M', tokens: { metered: null } }), PLANS)).toBe(1_200_000);
    expect(meteredOf(glm(1, null, { size: null }), PLANS)).toBe(4_000_000);
    expect(meteredOf(glm(1, null, { size: undefined }), PLANS)).toBe(4_000_000);
  });
  it('a provider without priors gives null (unmeasured), not 0', () => {
    const plans = plansWith(d => { d.providers.glm.priorTokens = null; });
    expect(meteredOf(glm(1, null), plans)).toBeNull();
    expect(meteredOf(glm(1, 7), plans)).toBe(7);
  });
});

describe('windowUsage — counter providers', () => {
  it('reads the fresh newest reading per window kind, scoped to the plan limitIds', () => {
    const nodes = [codexFresh(80, 80, 20), codexFresh(40, 70, 5)];
    expect(windowUsage(PLANS, nodes, 'codex', '5h', NOW))
      .toEqual({ usedPercent: 40, source: 'counter', readAt: at(5), fresh: true });
    expect(windowUsage(PLANS, nodes, 'codex', 'weekly', NOW).usedPercent).toBe(70);
  });
  it('uses the limitIds of the plans it is handed, not the process-wide budget', () => {
    const plans = plansWith(d => { d.providers.codex.limitIds = ['base_model_inference']; });
    expect(windowUsage(plans, [codexFresh(40, 70)], 'codex', 'weekly', NOW).usedPercent).toBe(99);
  });
  it('a stale reading (older than readingMaxAgeMins) is unknown, not its old number', () => {
    const u = windowUsage(PLANS, [codexFresh(40, 70, 31)], 'codex', '5h', NOW);
    expect(u).toEqual({ usedPercent: null, source: 'counter', readAt: at(31), fresh: false });
    expect(windowUsage(PLANS, [codexFresh(40, 70, 30)], 'codex', '5h', NOW).fresh).toBe(true);
  });
  it('a window whose reset has passed (or cannot be dated) is unknown', () => {
    const past = codex(5, [win('codex', 40, 300, at(1)), win('codex', 70, 10080, FUTURE)]);
    expect(windowUsage(PLANS, [past], 'codex', '5h', NOW).usedPercent).toBeNull();
    expect(windowUsage(PLANS, [past], 'codex', 'weekly', NOW).usedPercent).toBe(70);
    const atReset = codex(5, [win('codex', 40, 300, new Date(NOW).toISOString())]);
    expect(windowUsage(PLANS, [atReset], 'codex', '5h', NOW).usedPercent).toBeNull();
    const undated = codex(5, [win('codex', 40, 300, null)]);
    expect(windowUsage(PLANS, [undated], 'codex', '5h', NOW).usedPercent).toBeNull();
  });
  it('no reading, or no window of that kind ⇒ unknown', () => {
    expect(windowUsage(PLANS, [], 'codex', '5h', NOW))
      .toEqual({ usedPercent: null, source: 'counter', readAt: null, fresh: false });
    const onlyWeekly = codex(5, [win('codex', 70, 10080, FUTURE)]);
    expect(windowUsage(PLANS, [onlyWeekly], 'codex', '5h', NOW).usedPercent).toBeNull();
  });
});

describe('windowUsage — token providers', () => {
  it('sums the pool over a rolling window when no reset is known', () => {
    const nodes = [glm(60, 100_000), glm(240, 200_000), glm(360, 900_000), gemini(10, 5_000_000), codexFresh(1, 1)];
    expect(windowUsage(PLANS, nodes, 'glm', '5h', NOW))
      .toEqual({ usedTokens: 300_000, unmeasured: 0, source: 'tokens', windowStart: at(300) });
    expect(windowUsage(PLANS, nodes, 'glm', 'weekly', NOW).usedTokens).toBe(1_200_000);
  });
  it('the interval is (windowStart, nowMs]: a node exactly at the start is out, one at now is in', () => {
    const nodes = [glm(300, 1), glm(0, 10), glm(-1, 100)];
    expect(windowUsage(PLANS, nodes, 'glm', '5h', NOW).usedTokens).toBe(10);
  });
  it('a node without tokens counts as its size prior, never 0', () => {
    const nodes = [glm(60, null, { size: 'S' }), glm(30, 1_000)];
    expect(windowUsage(PLANS, nodes, 'glm', '5h', NOW).usedTokens).toBe(301_000);
  });
  it('without priors an untokened node contributes nothing and is counted as unmeasured', () => {
    const plans = plansWith(d => { d.providers.glm.priorTokens = null; });
    const u = windowUsage(plans, [glm(60, null), glm(30, 1_000)], 'glm', '5h', NOW);
    expect(u.usedTokens).toBe(1_000);
    expect(u.unmeasured).toBe(1);
  });
  it('the billing pool, not the provider name, decides which runs count', () => {
    const plans = plansWith(d => { d.providers.gemini.pool = 'zai'; });
    expect(windowUsage(plans, [glm(60, 100), gemini(10, 5_000)], 'glm', '5h', NOW).usedTokens).toBe(5_100);
  });
  it('a stop tagged for another pool is no reset of this one', () => {
    const misTagged = glmStop(180, 500_000, 60, {
      providerStop: { provider: 'cline', resetsAt: at(120), evidence: 'limit' },
    });
    expect(windowUsage(PLANS, [misTagged], 'glm', '5h', NOW).windowStart).toBe(at(300));
    expect(capacityFor(PLANS, [misTagged], 'glm', '5h')).toBeNull();
  });
  it('refuses a missing or non-finite clock on both paths, never a silent default', () => {
    expect(() => windowUsage(PLANS, [], 'codex', '5h', undefined)).toThrow(/nowMs/);
    expect(() => windowUsage(PLANS, [], 'glm', '5h', undefined)).toThrow(/nowMs/);
    expect(() => headroomFor(PLANS, [], 'glm', NaN)).toThrow(/nowMs/);
  });
  it('a known reset of that kind (from a provider stop, ≤ now) moves the window start forward', () => {
    // stop at now-180 with a reset 60 min later (now-120): a 5h stop. Only runs after now-120 count.
    const nodes = [glmStop(180, 500_000, 60), glm(150, 400_000), glm(90, 70_000)];
    const u = windowUsage(PLANS, nodes, 'glm', '5h', NOW);
    expect(u.windowStart).toBe(at(120));
    expect(u.usedTokens).toBe(70_000);
    // the same reset is not a weekly one: the weekly window stays rolling
    expect(windowUsage(PLANS, nodes, 'glm', 'weekly', NOW).usedTokens).toBe(970_000);
  });
  it('a reset still in the future is not a known reset', () => {
    const nodes = [glmStop(30, 500_000, 120), glm(150, 400_000)];
    expect(windowUsage(PLANS, nodes, 'glm', '5h', NOW).windowStart).toBe(at(300));
    expect(windowUsage(PLANS, nodes, 'glm', '5h', NOW).usedTokens).toBe(900_000);
  });
});

describe('capacityFor', () => {
  it('a counter provider is 100 (percent)', () => {
    expect(capacityFor(PLANS, [], 'codex', '5h')).toBe(100);
    expect(capacityFor(PLANS, [], 'codex', 'weekly')).toBe(100);
  });
  it('calibration takes the MIN over the provider stops of that kind', () => {
    // Stop A (day-old): 2.0M burned in the 5h before it. Stop B (recent): 1.5M.
    const nodes = [
      glm(1500, 1_200_000), glmStop(1440, 800_000, 60),
      glm(200, 1_000_000), glmStop(100, 500_000, 60),
    ];
    expect(capacityFor(PLANS, nodes, 'glm', '5h')).toBe(1_500_000);
  });
  it('only stops of the asked kind calibrate it; a weekly stop is not a 5h sample', () => {
    const nodes = [glm(200, 1_000_000), glmStop(100, 500_000, 3 * 1440)];
    expect(capacityFor(PLANS, nodes, 'glm', '5h')).toBeNull();
    // weekly sample: everything in the 7 days before the stop
    expect(capacityFor(PLANS, nodes, 'glm', 'weekly')).toBe(1_500_000);
  });
  it('a reset exactly 300 min after the stop is still a 5h stop', () => {
    expect(capacityFor(PLANS, [glmStop(100, 500_000, 300)], 'glm', '5h')).toBe(500_000);
    expect(capacityFor(PLANS, [glmStop(100, 500_000, 301)], 'glm', '5h')).toBeNull();
  });
  it('a stop window that measured 0 tokens (all unmeasured) is no sample — never a capacity of 0', () => {
    const plans = plansWith(d => {
      d.providers.glm.priorTokens = null;
      d.providers.glm.windows[0].capacity = { unit: 'tokens', value: 9_000_000 };
    });
    expect(capacityFor(plans, [glmStop(100, null, 60)], 'glm', '5h')).toBe(9_000_000);
  });
  it('only the newest decision.costHistory stops are samples', () => {
    const plans = plansWith(d => { d.decision.costHistory = 2; });
    const nodes = [glmStop(3000, 100_000, 60), glmStop(2000, 900_000, 60), glmStop(1000, 700_000, 60)];
    expect(capacityFor(plans, nodes, 'glm', '5h')).toBe(700_000);
    expect(capacityFor(PLANS, nodes, 'glm', '5h')).toBe(100_000);
  });
  it('a stop node without tokens calibrates with its size prior', () => {
    expect(capacityFor(PLANS, [glmStop(100, null, 60, { size: 'S' })], 'glm', '5h')).toBe(300_000);
  });
  it('a stop without a reset time has no kind and is no sample', () => {
    const undated = glm(100, 500_000, { exitCode: 1, providerStop: { provider: 'zai', resetsAt: null, evidence: 'x' } });
    expect(capacityFor(PLANS, [undated], 'glm', '5h')).toBeNull();
  });
  it('no stops ⇒ the declared token capacity; no stops and nothing declared ⇒ unknown (null)', () => {
    const plans = plansWith(d => { d.providers.glm.windows[0].capacity = { unit: 'tokens', value: 9_000_000 }; });
    expect(capacityFor(plans, [], 'glm', '5h')).toBe(9_000_000);
    expect(capacityFor(plans, [], 'glm', 'weekly')).toBeNull();
    expect(capacityFor(PLANS, [glm(10, 1)], 'glm', '5h')).toBeNull();
  });
  it('a calibrated sample beats the declared value', () => {
    const plans = plansWith(d => { d.providers.glm.windows[0].capacity = { unit: 'tokens', value: 9_000_000 }; });
    expect(capacityFor(plans, [glmStop(100, 2_000_000, 60)], 'glm', '5h')).toBe(2_000_000);
  });
});

describe('headroomFor', () => {
  it('counter: (100 − reserve) − used per window; the route headroom is the min across windows', () => {
    const h = headroomFor(PLANS, [codexFresh(40, 70)], 'codex', NOW);
    expect(h.windows).toEqual([
      { kind: '5h', headroom: 55, unit: 'percent', unknown: false },
      { kind: 'weekly', headroom: 25, unit: 'percent', unknown: false },
    ]);
    expect(h.min).toEqual({ kind: 'weekly', headroom: 25, unit: 'percent', unknown: false });
  });
  it('a stale counter reading is unknown — never room', () => {
    const h = headroomFor(PLANS, [codexFresh(40, 70, 31)], 'codex', NOW);
    expect(h.windows.map((w: Json) => [w.headroom, w.unknown])).toEqual([[null, true], [null, true]]);
    expect(h.min).toEqual({ kind: null, headroom: null, unit: 'percent', unknown: true });
  });
  it('tokens: cap·(1 − reserve/100) − used; one unknown window makes the min unknown', () => {
    const plans = plansWith(d => { d.providers.glm.windows[0].capacity = { unit: 'tokens', value: 10_000_000 }; });
    const h = headroomFor(plans, [glm(60, 1_000_000)], 'glm', NOW);
    expect(h.windows[0]).toEqual({ kind: '5h', headroom: 7_500_000, unit: 'tokens', unknown: false });
    expect(h.windows[1]).toEqual({ kind: 'weekly', headroom: null, unit: 'tokens', unknown: true });
    expect(h.min.unknown).toBe(true);
    expect(h.min.headroom).toBeNull();
  });
  it('an unknown window keeps the min unknown even when the known one is already over the reserve', () => {
    const plans = plansWith(d => { d.providers.glm.windows[1].capacity = { unit: 'tokens', value: 1_000_000 }; });
    const h = headroomFor(plans, [glm(2000, 2_000_000)], 'glm', NOW);
    expect(h.windows.map((w: Json) => w.headroom)).toEqual([null, -1_150_000]);
    expect(h.min).toEqual({ kind: null, headroom: null, unit: 'tokens', unknown: true });
  });
  it('tokens: both windows known ⇒ the smaller headroom is the min', () => {
    const plans = plansWith(d => {
      d.providers.glm.windows[0].capacity = { unit: 'tokens', value: 10_000_000 };
      d.providers.glm.windows[1].capacity = { unit: 'tokens', value: 4_000_000 };
    });
    const h = headroomFor(plans, [glm(60, 1_000_000), glm(2000, 2_000_000)], 'glm', NOW);
    expect(h.windows.map((w: Json) => w.headroom)).toEqual([7_500_000, 400_000]);
    expect(h.min).toEqual({ kind: 'weekly', headroom: 400_000, unit: 'tokens', unknown: false });
  });
  it('an unmeasured run in a token window makes that window unknown — never room', () => {
    const plans = plansWith(d => {
      d.providers.glm.priorTokens = null;
      d.providers.glm.windows[0].capacity = { unit: 'tokens', value: 10_000_000 };
      d.providers.glm.windows[1].capacity = { unit: 'tokens', value: 10_000_000 };
    });
    const h = headroomFor(plans, [glm(60, null), glm(30, 1_000)], 'glm', NOW);
    expect(h.windows[0]).toEqual({ kind: '5h', headroom: null, unit: 'tokens', unknown: true });
    expect(h.min.unknown).toBe(true);
    // every run measured ⇒ known again
    expect(headroomFor(plans, [glm(30, 1_000)], 'glm', NOW).min.unknown).toBe(false);
  });
  it('an unknown provider name is refused, never treated as uncapped', () => {
    expect(() => headroomFor(PLANS, [], 'nope', NOW)).toThrow(/providers\.nope/);
  });
});

// ---------------------------------------------------------------------------------------------
// Q11b: estimate + decide. Same purity contract: plans, nodes, routes and nowMs are handed in.
// ---------------------------------------------------------------------------------------------
const iso = (minsAhead: number) => new Date(NOW + minsAhead * MIN).toISOString();
/** A codex run that carries Q6 usageDeltas and metered tokens but no reading of its own. */
const codexRun = (minsAgo: number, metered: number | null, deltas: Array<[number, number, string?]>, over: Json = {}) =>
  codex(minsAgo, [], {
    size: 'L', usageAfter: null, tokens: metered == null ? null : { metered },
    usageDeltas: deltas.map(([mins, percentDelta, limitId = 'codex']) =>
      ({ limitId, windowDurationMins: mins, percentDelta, minutes: 10, percentPerHour: 0 })),
    ...over,
  });
const cline = (minsAgo: number, over: Json = {}) =>
  glm(minsAgo, 1_000, { role: 'overflow', cli: 'cline', model: 'cline-pass', ...over });
const route = (role: string, provider: string, aa: number | null, rotationIndex: number | null, status = 'ok') =>
  ({ role, provider, aa, rotationIndex, status });
/** Both token windows of the named providers declared at `value` tokens. */
const declared = (value: number, ...names: string[]) => plansWith(d => {
  for (const n of names) for (const w of d.providers[n].windows) w.capacity = { unit: 'tokens', value };
});

describe('estimateFor', () => {
  it('switches from the prior to the median at exactly minLearnedSamples (median, not mean)', () => {
    const two = [glm(30, 100_000), glm(20, 100_000)];
    expect(estimateFor(PLANS, two, 'glm', 'M')).toEqual({ tokens: 1_200_000, source: 'prior' });
    expect(estimateFor(PLANS, [...two, glm(10, 1_000_000)], 'glm', 'M'))
      .toEqual({ tokens: 100_000, source: 'learned' });
    // even count: the mean of the two middles
    expect(estimateFor(PLANS, [...two, glm(10, 1_000_000), glm(5, 300_000)], 'glm', 'M').tokens).toBe(200_000);
  });
  it('the worst run seen beats a lower prior while samples are few', () => {
    expect(estimateFor(PLANS, [glm(30, 100_000), glm(20, 2_000_000)], 'glm', 'M'))
      .toEqual({ tokens: 2_000_000, source: 'worst-seen' });
  });
  it('only measured, same-size, same-pool runs that ended ok are history', () => {
    const nodes = [
      glm(30, 100_000), glm(20, 200_000),
      glm(15, 9_000_000, { exitCode: 1 }), glm(14, 9_000_000, { blocked: true }),
      glmStop(13, 9_000_000, 60), glm(12, 9_000_000, { size: 'L' }), gemini(11, 9_000_000),
      glm(10, null),
    ];
    expect(estimateFor(PLANS, nodes, 'glm', 'M')).toEqual({ tokens: 1_200_000, source: 'prior' });
  });
  it('only the newest decision.costHistory runs (by recordedAt, not file order) are history', () => {
    const plans = plansWith(d => { d.decision.costHistory = 3; });
    const nodes = [glm(10, 100_000), glm(500, 5_000_000), glm(20, 100_000), glm(600, 5_000_000), glm(30, 200_000)];
    expect(estimateFor(plans, nodes, 'glm', 'M')).toEqual({ tokens: 100_000, source: 'learned' });
    expect(estimateFor(PLANS, nodes, 'glm', 'M').tokens).toBe(200_000);
  });
  it('no prior and no history ⇒ unknown; no prior with a little history ⇒ the worst seen', () => {
    const plans = plansWith(d => { d.providers.glm.priorTokens = null; });
    expect(estimateFor(plans, [], 'glm', 'M')).toEqual({ tokens: null, source: 'unknown' });
    expect(estimateFor(plans, [glm(10, 70_000)], 'glm', 'M')).toEqual({ tokens: 70_000, source: 'worst-seen' });
  });
  it('a counter window estimate is tokens × the pooled %-per-token ratio of that window kind', () => {
    // unequal tokens: pooled Σ%/Σtokens (6/4M) differs from the mean of per-run ratios (≈1.67e-6)
    const nodes = [
      codexRun(60, 1_000_000, [[300, 2], [10080, 1]]),
      codexRun(50, 3_000_000, [[300, 4], [10080, 0]]),
      codexRun(40, null, [[300, 50]]), // no metered tokens: not in the ratio
      codexRun(30, 1_000_000, [[300, 50, 'base_model_inference']]), // another pool's window
    ];
    const e = estimateFor(PLANS, nodes, 'codex', 'M');
    expect(e.tokens).toBe(1_200_000);
    expect(e.source).toBe('prior');
    expect(e.percent['5h']).toBeCloseTo(1_200_000 * 6 / 4_000_000, 9);
    expect(e.percent.weekly).toBeCloseTo(1_200_000 * 1 / 4_000_000, 9);
    expect(estimateFor(PLANS, [], 'codex', 'M').percent).toEqual({ '5h': null, weekly: null });
  });
});

describe('decide', () => {
  const glmRoute = route('implement', 'glm', 50, 0);
  it('every window needs headroom ≥ headroomFactor × estimate', () => {
    // 6.9M used of 10M·0.85 ⇒ 1.6M left in both windows; an M estimate is the 1.2M prior.
    const plans = declared(10_000_000, 'glm');
    const nodes = [glm(60, 6_900_000, { size: 'L' })];
    expect(decide(plans, nodes, [glmRoute], { size: 'M', nowMs: NOW }))
      .toEqual({ action: 'split', reasons: [{ role: 'implement', why: 'headroom' }] });
    const loose = plansWith(d => {
      d.decision.headroomFactor = 1;
      for (const w of d.providers.glm.windows) w.capacity = { unit: 'tokens', value: 10_000_000 };
    });
    expect(decide(loose, nodes, [glmRoute], { size: 'M', nowMs: NOW }))
      .toEqual({ action: 'run', route: glmRoute, reasons: [] });
  });
  it('unknown windows: until-stop runs up to uncalibratedMaxSize, refuse never does', () => {
    expect(decide(PLANS, [], [glmRoute], { size: 'M', nowMs: NOW }).action).toBe('run');
    expect(decide(PLANS, [], [glmRoute], { size: 'L', nowMs: NOW }))
      .toEqual({ action: 'split', reasons: [{ role: 'implement', why: 'unknown' }] });
    const refuse = plansWith(d => { d.providers.glm.onUnknown = 'refuse'; });
    expect(decide(refuse, [], [glmRoute], { size: 'S', nowMs: NOW }))
      .toEqual({ action: 'wait', until: null, reason: 'unknown', reasons: [{ role: 'implement', why: 'unknown' }] });
    const noCap = plansWith(d => { d.providers.glm.uncalibratedMaxSize = null; });
    expect(decide(noCap, [], [glmRoute], { size: 'L', nowMs: NOW }).action).toBe('run');
  });
  it('a route whose last run ended blocked stays out until a later ok run readmits it', () => {
    const blocked = [glm(60, 1_000, { blocked: true })];
    expect(decide(PLANS, blocked, [glmRoute], { size: 'S', nowMs: NOW }).reasons)
      .toEqual([{ role: 'implement', why: 'blocked' }]);
    expect(decide(PLANS, [...blocked, glm(30, 1_000)], [glmRoute], { size: 'S', nowMs: NOW }).action).toBe('run');
    // any later ok run of the provider readmits it, whatever its role
    expect(decide(PLANS, [...blocked, glm(30, 1_000, { role: 'breadth' })], [glmRoute], { size: 'S', nowMs: NOW }).action)
      .toBe('run');
    // a provider stop that was also blocked is governed by its reset, not by the blocked rule
    expect(decide(PLANS, [glmStop(200, 5_000_000, 60, { blocked: true })], [glmRoute], { size: 'S', nowMs: NOW }).action)
      .toBe('run');
  });
  it('an active provider stop, a size over maxSize and a non-ok status each reject', () => {
    const capped = plansWith(d => { d.providers.glm.maxSize = 'S'; });
    expect(decide(capped, [], [glmRoute], { size: 'M', nowMs: NOW }).reasons).toEqual([{ role: 'implement', why: 'size' }]);
    expect(decide(PLANS, [glmStop(10, 5_000_000, 130)], [glmRoute], { size: 'S', nowMs: NOW }))
      .toEqual({ action: 'wait', until: iso(120), reasons: [{ role: 'implement', why: 'provider-stop' }] });
    expect(decide(PLANS, [], [route('implement', 'glm', 50, 0, 'disabled')], { size: 'S', nowMs: NOW }).reasons)
      .toEqual([{ role: 'implement', why: 'status' }]);
  });
  it('a provider stop with an undatable resetsAt is active (fails closed) and gives no wait time', () => {
    for (const resetsAt of [null, 'not-a-date']) {
      const stop = glmStop(10, 5_000_000, 60, { providerStop: { provider: 'zai', resetsAt, evidence: 'limit' } });
      expect(decide(PLANS, [stop], [glmRoute], { size: 'S', nowMs: NOW })).toEqual({
        action: 'wait', until: null, reason: 'unknown', reasons: [{ role: 'implement', why: 'provider-stop' }],
      });
    }
  });
  it('picks the highest aa; ties by the larger min slack, then the lower rotationIndex', () => {
    const plans = declared(10_000_000, 'glm', 'gemini');
    const g = route('implement', 'glm', 50, 1);
    const b = route('breadth', 'gemini', 50, 0);
    // equal aa: glm has more slack (gemini burned 3M) despite its later rotation slot
    expect(decide(plans, [gemini(60, 3_000_000, { size: 'L' })], [b, g], { size: 'M', nowMs: NOW }))
      .toEqual({ action: 'run', route: g, reasons: [{ role: 'breadth', why: 'outranked' }] });
    // equal aa, equal slack: the lower rotationIndex, whatever the input order
    expect(decide(plans, [], [g, b], { size: 'M', nowMs: NOW }).route).toEqual(b);
    // a higher aa beats more slack; null aa ranks below any number
    expect(decide(plans, [gemini(60, 3_000_000, { size: 'L' })], [{ ...b, aa: 51 }, g], { size: 'M', nowMs: NOW }).route.role)
      .toBe('breadth');
    expect(decide(plans, [], [{ ...b, aa: null }, { ...g, aa: 1 }], { size: 'M', nowMs: NOW }).route.role).toBe('implement');
    // slack is normalised by cap: glm 2M of 10M (0.2) beats gemini 3M of 100M (0.03), though 3M > 2M raw
    const caps = plansWith(d => {
      for (const w of d.providers.glm.windows) w.capacity = { unit: 'tokens', value: 10_000_000 };
      for (const w of d.providers.gemini.windows) w.capacity = { unit: 'tokens', value: 100_000_000 };
    });
    const used = [glm(60, 4_700_000, { size: 'L' }), gemini(60, 80_200_000, { size: 'L' })]; // headroom 3.8M / 4.8M
    expect(decide(caps, used, [b, g], { size: 'M', nowMs: NOW }))
      .toEqual({ action: 'run', route: g, reasons: [{ role: 'breadth', why: 'outranked' }] });
    // slack uses decision.headroomFactor, not a literal 1.5: at factor 3 glm (4M−3.6M)/10M = 0.04 loses to
    // gemini (10M−3.6M)/100M = 0.064; with 1.5 it would be 0.22 vs 0.082
    const f3 = plansWith(d => {
      d.decision.headroomFactor = 3;
      for (const w of d.providers.glm.windows) w.capacity = { unit: 'tokens', value: 10_000_000 };
      for (const w of d.providers.gemini.windows) w.capacity = { unit: 'tokens', value: 100_000_000 };
    });
    const used3 = [glm(60, 4_500_000, { size: 'L' }), gemini(60, 75_000_000, { size: 'L' })];
    expect(decide(f3, used3, [g, b], { size: 'M', nowMs: NOW }))
      .toEqual({ action: 'run', route: b, reasons: [{ role: 'implement', why: 'outranked' }] });
    // known slack beats an until-stop route that is only in on unknown windows
    const half = declared(10_000_000, 'glm');
    expect(decide(half, [], [b, g], { size: 'M', nowMs: NOW }).route).toEqual(g);
  });
  it('overflow is only for size S, and only when nothing in the main rotation can run', () => {
    const plans = plansWith(d => { d.providers.cline.maxSize = null; }); // so the size rule cannot mask it
    const o = route('overflow', 'cline', 99, null);
    const stopped = [glmStop(10, 5_000_000, 130)];
    expect(decide(plans, stopped, [glmRoute, o], { size: 'S', nowMs: NOW }))
      .toEqual({ action: 'run', route: o, reasons: [{ role: 'implement', why: 'provider-stop' }] });
    expect(decide(plans, stopped, [glmRoute, o], { size: 'M', nowMs: NOW })).toEqual({
      action: 'split', reasons: [{ role: 'implement', why: 'provider-stop' }, { role: 'overflow', why: 'overflow' }],
    });
    // a runnable main route wins even against a higher-aa overflow route
    expect(decide(plans, [], [glmRoute, o], { size: 'S', nowMs: NOW }))
      .toEqual({ action: 'run', route: glmRoute, reasons: [{ role: 'overflow', why: 'overflow' }] });
  });
  it('split only when a smaller size would run; otherwise wait for the reset', () => {
    const stopped = [glmStop(10, 5_000_000, 130)];
    expect(decide(PLANS, stopped, [glmRoute], { size: 'M', nowMs: NOW }))
      .toEqual({ action: 'wait', until: iso(120), reasons: [{ role: 'implement', why: 'provider-stop' }] });
  });
  it('wait picks the EARLIEST reset that frees some route — not a reset that frees nothing', () => {
    const plans = plansWith(d => { d.providers.cline.overflow = false; });
    const nodes = [
      glmStop(10, 5_000_000, 130), // glm frees at +120 (the 5M before the stop also calibrates its 5h cap)
      cline(10, { exitCode: 1, providerStop: { provider: 'cline', resetsAt: iso(30), evidence: 'limit' } }), // +30, but M > maxSize S
      codexRun(60, 1_000_000, [[300, 2], [10080, 1]]),
      codex(5, [win('codex', 95, 300, iso(90)), win('codex', 50, 10080, iso(3000))]), // 5h full until +90
    ];
    const routes = [glmRoute, route('overflow', 'cline', 40, 2), route('reason', 'codex', 60, 1)];
    expect(decide(plans, nodes, routes, { size: 'M', nowMs: NOW })).toEqual({
      action: 'wait', until: iso(90), reasons: [
        { role: 'implement', why: 'provider-stop' },
        { role: 'overflow', why: 'provider-stop' },
        { role: 'reason', why: 'headroom' },
      ],
    });
  });
  it('a counter route with no learned %-per-token ratio never runs on refuse ⇒ wait with no time', () => {
    const r = route('reason', 'codex', 60, 0);
    expect(decide(PLANS, [codexFresh(10, 10)], [r], { size: 'S', nowMs: NOW }))
      .toEqual({ action: 'wait', until: null, reason: 'unknown', reasons: [{ role: 'reason', why: 'unknown' }] });
  });
  it('reasons: one per route not chosen, in input order, identical across calls', () => {
    const routes = [
      route('a', 'glm', 10, 0, 'disabled'), route('b', 'gemini', 90, null), glmRoute, route('c', 'gemini', 20, 1),
    ];
    const once = decide(PLANS, [], routes, { size: 'S', nowMs: NOW });
    expect(once).toEqual({
      action: 'run', route: glmRoute, reasons: [
        { role: 'a', why: 'status' }, { role: 'b', why: 'not-in-rotation' }, { role: 'c', why: 'outranked' },
      ],
    });
    expect(decide(PLANS, [], routes, { size: 'S', nowMs: NOW })).toEqual(once);
  });
  it('refuses a missing clock or an unknown size, never a silent default', () => {
    expect(() => decide(PLANS, [], [glmRoute], { size: 'M' })).toThrow(/nowMs/);
    expect(() => decide(PLANS, [], [glmRoute], { size: 'XL', nowMs: NOW })).toThrow(/size/);
  });
});
