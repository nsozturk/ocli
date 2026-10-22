import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { parsePlans, loadPlans, stopAtPercentFor } from '../dispatcher/plans.mjs';

const EXAMPLE = fileURLToPath(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url));
let exampleText = '';
const fresh = () => JSON.parse(exampleText);
const parseObj = (o: unknown) => () => parsePlans(JSON.stringify(o));

beforeAll(async () => { exampleText = await readFile(EXAMPLE, 'utf8'); });

describe('parsePlans', () => {
  it('parses the shipped example', () => {
    const plans = parsePlans(exampleText);
    expect(Object.keys(plans.providers).sort()).toEqual(['claude', 'cline', 'codex', 'gemini', 'glm', 'muse']);
    expect(plans.providers.codex.limitIds).toEqual(['codex']);
    expect(plans.providers.claude.limitIds).toEqual(['5-hour limit', 'Weekly · all models']);
    expect(plans.providers.gemini.limitIds).toEqual([
      'antigravity-quota-summary-gemini-5h',
      'antigravity-quota-summary-gemini-weekly',
      'antigravity-quota-summary-gemini-argon-wtu-weekly',
    ]);
    expect(plans.providers.cline).toMatchObject({ overflow: true, maxSize: 'S', reservePercent: 10 });
    expect(plans.providers.glm.priorTokens).toEqual({ S: 300000, M: 1200000, L: 4000000 });
    expect(plans.decision).toEqual({ headroomFactor: 1.5, minLearnedSamples: 3, costHistory: 10, readingMaxAgeMins: 30 });
    expect(plans.lead.throttle).toEqual({ leanBelowPercent: 25, closeBelowPercent: 10 });
    const until = { onUnknown: 'until-stop' };
    expect(plans.providers).toMatchObject({
      codex: { meteredBy: 'counter', reservePercent: 5, onUnknown: 'refuse' },
      claude: { meteredBy: 'counter', reservePercent: 20, onUnknown: 'until-stop' }, // lead decision: uncapped until Q13
      glm: { meteredBy: 'counter', reservePercent: 15, uncalibratedMaxSize: 'M', ...until },
      gemini: { meteredBy: 'counter', reservePercent: 15, uncalibratedMaxSize: 'M', ...until },
      muse: { meteredBy: 'counter', reservePercent: 0, uncalibratedMaxSize: 'M', ...until },
      cline: { meteredBy: 'counter', ...until },
    });
  });

  it('refuses an unknown key, naming its path', () => {
    const o = fresh(); o.providers.glm.windows[0].extra = 1;
    expect(parseObj(o)).toThrow(/providers\.glm\.windows\[0\]\.extra/);
    const top = fresh(); top.surprise = true;
    expect(parseObj(top)).toThrow(/surprise/);
  });

  it('refuses a bad enum, naming its path', () => {
    const o = fresh(); o.providers.glm.meteredBy = 'bytes';
    expect(parseObj(o)).toThrow(/providers\.glm\.meteredBy/);
    const w = fresh(); w.providers.codex.windows[1].kind = 'daily';
    expect(parseObj(w)).toThrow(/providers\.codex\.windows\[1\]\.kind/);
  });

  // One bad value per schema clause; each must be refused with its own path in the message.
  const bad: Array<[string, (o: any) => void]> = [
    ['providers.codex.onUnknown', o => { o.providers.codex.onUnknown = 'refsue'; }],
    ['providers.glm.windows[0].capacity.unit', o => { o.providers.glm.windows[0].capacity.unit = 'bytes'; }],
    ['providers.glm.windows[0].source', o => { o.providers.glm.windows[0].source = 'guess'; }],
    ['providers.codex.limitIds', o => { o.providers.codex.limitIds = 'codex'; }],
    ['providers.glm.uncalibratedMaxSize', o => { o.providers.glm.uncalibratedMaxSize = 'XL'; }],
    ['providers.cline.maxSize', o => { o.providers.cline.maxSize = 'XL'; }],
    ['providers.cline.overflow', o => { o.providers.cline.overflow = 'yes'; }],
    ['providers.glm.priorTokens', o => { o.providers.glm.priorTokens = { S: 1, M: 2 }; }],
    ['lead.throttle.leanBelowPercent', o => { o.lead.throttle.leanBelowPercent = 101; }],
  ];
  it.each(bad)('refuses a bad %s, naming its path', (p, set) => {
    const o = fresh(); set(o);
    expect(parseObj(o)).toThrow(new RegExp(p.replace(/[.[\]]/g, '\\$&')));
  });

  it('refuses unit unknown with a value, and a known unit without one', () => {
    const o = fresh(); o.providers.glm.windows[0].capacity = { unit: 'unknown', value: 5 };
    expect(parseObj(o)).toThrow(/providers\.glm\.windows\[0\]\.capacity\.value/);
    const p = fresh(); p.providers.codex.windows[0].capacity.value = null;
    expect(parseObj(p)).toThrow(/providers\.codex\.windows\[0\]\.capacity\.value/);
  });

  it('refuses a missing reserve (never defaulted)', () => {
    const o = fresh(); delete o.providers.codex.reservePercent;
    expect(parseObj(o)).toThrow(/providers\.codex\.reservePercent/);
    const hi = fresh(); hi.providers.codex.reservePercent = 51;
    expect(parseObj(hi)).toThrow(/providers\.codex\.reservePercent/);
    const lo = fresh(); lo.providers.codex.reservePercent = -1;
    expect(parseObj(lo)).toThrow(/providers\.codex\.reservePercent/);
  });

  it('refuses schemaVersion 2', () => {
    const o = fresh(); o.schemaVersion = 2;
    expect(parseObj(o)).toThrow(/schemaVersion/);
  });

  it('refuses a lead provider that is not a provider', () => {
    const o = fresh(); o.lead.provider = 'nope';
    expect(parseObj(o)).toThrow(/lead\.provider/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parsePlans('{')).toThrow(/plans/);
  });
});

describe('loadPlans', () => {
  const homes: string[] = [];
  const tmpHome = async () => { const home = await mkdtemp(path.join(tmpdir(), 'plans-home-')); homes.push(home); return home; };
  afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
  const writeGlobal = async (home: string, text: string) => {
    const dir = path.join(home, '.config', 'agent-rules');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'provider-plans.json');
    await writeFile(file, text);
    return file;
  };
  const withReserve = (r: number) => { const o = fresh(); o.providers.codex.reservePercent = r; return JSON.stringify(o); };

  it('resolves ORCHESTRA_PLANS before the global file', async () => {
    const home = await tmpHome();
    await writeGlobal(home, withReserve(7));
    const envFile = path.join(home, 'env-plans.json');
    await writeFile(envFile, withReserve(9));
    const got = loadPlans({ env: { ORCHESTRA_PLANS: envFile }, home });
    expect(got.source).toBe('env');
    expect(got.plans.providers.codex.reservePercent).toBe(9);
  });

  it('uses the global file when no env, then the example when neither exists', async () => {
    const home = await tmpHome();
    expect(loadPlans({ env: {}, home })).toMatchObject({ source: 'example' });
    await writeGlobal(home, withReserve(7));
    const got = loadPlans({ env: {}, home });
    expect(got.source).toBe('global');
    expect(got.plans.providers.codex.reservePercent).toBe(7);
  });

  it('a broken global file throws instead of falling to the example', async () => {
    const home = await tmpHome();
    await writeGlobal(home, '{ not json');
    expect(() => loadPlans({ env: {}, home })).toThrow(/provider-plans\.json/);
    await writeGlobal(home, withReserve(80));
    expect(() => loadPlans({ env: {}, home })).toThrow(/reservePercent/);
  });

  it('a missing ORCHESTRA_PLANS file is an error, not a fall-through', async () => {
    const home = await tmpHome();
    expect(() => loadPlans({ env: { ORCHESTRA_PLANS: path.join(home, 'absent.json') }, home })).toThrow(/absent\.json/);
  });

  it('refuses a symlinked plans file (env and global) even when the target is valid', async () => {
    const home = await tmpHome();
    const link = path.join(home, 'link.json');
    await symlink(EXAMPLE, link);
    expect(() => loadPlans({ env: { ORCHESTRA_PLANS: link }, home })).toThrow(/link\.json/);
    const dir = path.join(home, '.config', 'agent-rules');
    await mkdir(dir, { recursive: true });
    await symlink(EXAMPLE, path.join(dir, 'provider-plans.json'));
    expect(() => loadPlans({ env: {}, home })).toThrow(/provider-plans\.json/);
  });
});

describe('stopAtPercentFor', () => {
  it('is 100 - reserve for counter providers with a reader; claude excluded until Q13 (Q17)', () => {
    const plans = parsePlans(exampleText);
    expect(stopAtPercentFor(plans, 'codex')).toBe(95);
    expect(stopAtPercentFor(plans, 'claude')).toBeNull(); // counter-metered but until-stop: uncapped until Q13
    // A counter pool that refuses when unread is capped at 100 - reserve; claude marked refuse caps too.
    const refusing = parsePlans(exampleText); refusing.providers.claude.onUnknown = 'refuse';
    expect(stopAtPercentFor(refusing, 'claude')).toBe(80);
    // Q17: CodexBar counter pools cap at 100 - reserve even though onUnknown stays until-stop;
    // the until-stop half (no reading => run) lives in gateFor/quota, not in this number.
    expect(stopAtPercentFor(plans, 'glm')).toBe(85);
    expect(stopAtPercentFor(plans, 'gemini')).toBe(85);
    expect(stopAtPercentFor(plans, 'muse')).toBe(100);
    expect(stopAtPercentFor(plans, 'cline')).toBe(90);
  });

  it('throws on an unknown provider rather than reading it as uncapped', () => {
    expect(() => stopAtPercentFor(parsePlans(exampleText), 'codx')).toThrow(/codx/);
  });
});
