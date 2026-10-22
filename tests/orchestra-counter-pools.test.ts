import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of the typed src build.
import { parsePlans, stopAtPercentFor } from '../dispatcher/plans.mjs';
// The package's starter example is minimal; the counter pools live in the shipped full-roster plans.
const EXAMPLE_PLANS = fileURLToPath(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url));

// Counter pools (Q17) and their gates. The reader side — limitIds per provider, identity dropped, no
// codexbar spawn — moved to usage-readers-index.test.ts when slice D replaced the codexbar CLI with
// usage-readers/index.mjs; the plans rows and gate rules below are unchanged.

describe('provider-plans.example.json — CodexBar counter pools (Q17)', () => {
  const plans = parsePlans(readFileSync(EXAMPLE_PLANS, 'utf8'));

  it('glm/gemini are counter pools with CodexBar limitIds; muse/cline are counters with no limitIds yet', () => {
    expect(plans.providers.glm).toMatchObject({ meteredBy: 'counter', onUnknown: 'until-stop', limitIds: ['zai-primary'] });
    expect(plans.providers.gemini).toMatchObject({
      meteredBy: 'counter', onUnknown: 'until-stop',
      limitIds: [
        'antigravity-quota-summary-gemini-5h',
        'antigravity-quota-summary-gemini-weekly',
        'antigravity-quota-summary-gemini-argon-wtu-weekly',
      ],
    });
    // Unmeasured: CodexBar has never returned a muse/clinepass reading here, so no id is guessed.
    expect(plans.providers.muse).toMatchObject({ meteredBy: 'counter', onUnknown: 'until-stop', limitIds: null });
    expect(plans.providers.cline).toMatchObject({ meteredBy: 'counter', onUnknown: 'until-stop', limitIds: null });
    expect(plans.providers.muse._note).toMatch(/unmeasured/i);
    expect(plans.providers.muse._note).toMatch(/Keychain/);
    expect(plans.providers.cline._note).toMatch(/unmeasured/i);
    expect(plans.providers.cline._note).toMatch(/cline auth/);
    for (const p of ['glm', 'gemini', 'muse', 'cline'] as const) {
      for (const w of plans.providers[p].windows) {
        expect(w.capacity, `${p} ${w.kind}`).toEqual({ unit: 'percent', value: 100 });
        expect(w.source, `${p} ${w.kind}`).toBe('counter');
      }
    }
  });

  it('keeps the claude limit id as a literal middle dot, never a \\u escape', () => {
    const raw = readFileSync(EXAMPLE_PLANS, 'utf8');
    expect(raw).toContain('"Weekly · all models"');
    expect(raw).not.toContain('\\u00b7');
  });

  it('a provider _note must be a string; any other unknown key still fails', () => {
    const doc = JSON.parse(readFileSync(EXAMPLE_PLANS, 'utf8'));
    doc.providers.muse._note = 7;
    expect(() => parsePlans(JSON.stringify(doc))).toThrow(/providers\.muse\._note/);
    delete doc.providers.muse._note;
    doc.providers.muse.note = 'x';
    expect(() => parsePlans(JSON.stringify(doc))).toThrow(/providers\.muse\.note: unknown key/);
  });

  it('stopAtPercentFor caps the new counter pools at 100 - reserve, claude excluded', () => {
    expect(stopAtPercentFor(plans, 'glm')).toBe(85);
    expect(stopAtPercentFor(plans, 'gemini')).toBe(85);
    expect(stopAtPercentFor(plans, 'muse')).toBe(100);
    expect(stopAtPercentFor(plans, 'cline')).toBe(90);
    expect(stopAtPercentFor(plans, 'codex')).toBe(95);
    expect(stopAtPercentFor(plans, 'claude')).toBeNull();
  });
});

describe('gateFor — a CodexBar counter at its cap stops its route', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function freshUsageWithGlmReserve(reserve: number) {
    const doc = JSON.parse(readFileSync(EXAMPLE_PLANS, 'utf8'));
    doc.providers.glm.reservePercent = reserve;
    doc.providers.gemini.reservePercent = reserve;
    const dir = mkdtempSync(path.join(tmpdir(), 'q17-plans-'));
    dirs.push(dir);
    const file = path.join(dir, 'plans.json');
    writeFileSync(file, JSON.stringify(doc));
    vi.stubEnv('ORCHESTRA_PLANS', file);
    vi.stubEnv('HOME', dir);
    vi.resetModules();
    // @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
    return import('../dispatcher/usage.mjs');
  }

  it('glm at 96% with reserve 5 stops (cap 95), at 94% has room', async () => {
    const u: any = await freshUsageWithGlmReserve(5);
    const reading = (usedPercent: number) => ({ status: 'ok', source: 'reader', updatedAt: '2026-10-17T20:14:00.000Z',
      windows: [{ limitId: 'zai-primary', usedPercent, windowDurationMins: 300, resetsAt: '2026-10-18T01:00:00.000Z' }] });
    expect(u.budget().glm.stopAtPercent).toBe(95);
    expect(u.gateFor('glm', reading(96)).state).toBe('stop');
    expect(u.gateFor('glm', reading(95)).state).toBe('stop');
    const ok = u.gateFor('glm', reading(94));
    expect(ok.state).toBe('ok');
    expect(ok.headroomPercent).toBe(1);
  });

  it('gemini with argon-wtu at 96% (reserve 5) and gemini windows at 1% gates stop (Q17b)', async () => {
    const u: any = await freshUsageWithGlmReserve(5);
    const reading = (argonUsed: number) => ({
      status: 'ok',
      source: 'reader',
      updatedAt: '2026-10-17T21:33:00.000Z',
      windows: [
        { limitId: 'antigravity-quota-summary-gemini-5h', usedPercent: 1, windowDurationMins: 300, resetsAt: '2026-10-18T01:00:00.000Z' },
        { limitId: 'antigravity-quota-summary-gemini-weekly', usedPercent: 1, windowDurationMins: 10080, resetsAt: '2026-10-24T00:00:00.000Z' },
        { limitId: 'antigravity-quota-summary-gemini-argon-wtu-weekly', usedPercent: argonUsed, windowDurationMins: 10080, resetsAt: '2026-10-24T00:00:00.000Z' },
      ],
    });
    expect(u.budget().gemini.stopAtPercent).toBe(95);
    const stopped = u.gateFor('gemini', reading(96));
    expect(stopped.state).toBe('stop');
    expect(stopped.window?.limitId).toBe('antigravity-quota-summary-gemini-argon-wtu-weekly');
    expect(u.gateFor('gemini', reading(95)).state).toBe('stop');
    const ok = u.gateFor('gemini', reading(94));
    expect(ok.state).toBe('ok');
    expect(ok.headroomPercent).toBe(1);
    expect(u.ROUTE_LIMIT_IDS.gemini).toContain('antigravity-quota-summary-gemini-argon-wtu-weekly');
  });

  it('claude still until-stop: a counter reading at 96% does not cap it', async () => {
    const u: any = await freshUsageWithGlmReserve(5);
    const reading = { status: 'ok', windows: [
      { limitId: '5-hour limit', usedPercent: 96, windowDurationMins: 300, resetsAt: null },
      { limitId: 'Weekly · all models', usedPercent: 96, windowDurationMins: 10080, resetsAt: null },
    ] };
    expect(u.budget().claude.stopAtPercent).toBeNull();
    expect(u.gateFor('claude', reading).state).toBe('ok');
    expect(u.gateFor('claude', { status: 'unknown', windows: [] }).state).toBe('ok');
  });

  it('a counter pool with no limitIds (muse, cline) is unknown headroom: never room, never a cap', async () => {
    const u: any = await freshUsageWithGlmReserve(5);
    const full = (prefix: string) => ({ status: 'ok', source: 'reader', updatedAt: '2026-10-17T20:14:00.000Z', windows: [
      { limitId: `${prefix}-primary`, usedPercent: 100, windowDurationMins: 300, resetsAt: '2099-01-01T00:00:00.000Z' },
      { limitId: `${prefix}-secondary`, usedPercent: 100, windowDurationMins: 10080, resetsAt: '2099-01-01T00:00:00.000Z' },
    ] });
    for (const [provider, prefix] of [['muse', 'muse'], ['cline', 'clinepass']] as const) {
      expect(u.budget()[provider].stopAtPercent, provider).not.toBeNull(); // the cap number exists...
      const gate = u.gateFor(provider, full(prefix));
      expect(gate.state, provider).toBe('ok'); // ...but no scoped window binds it: until-stop, never stop
      expect(gate.headroomPercent, provider).toBeUndefined(); // and no room is claimed
      expect(gate.window, provider).toBeUndefined();
    }
    // quota reads the same recorded reading as unknown headroom, never a number.
    // @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
    const q: any = await import('../dispatcher/quota.mjs');
    const plans = parsePlans(readFileSync(EXAMPLE_PLANS, 'utf8'));
    const nowMs = Date.parse('2026-10-17T20:15:00.000Z');
    for (const [provider, cli, model, prefix] of [['muse', 'muse', 'muse-wonder-1.0', 'muse'], ['cline', 'cline', 'cline-pass/mimo-v2.6-pro', 'clinepass']] as const) {
      const nodes = [{ cli, model, usageAfter: full(prefix), recordedAt: '2026-10-17T20:14:00.000Z' }];
      const h = q.headroomFor(plans, nodes, provider, nowMs);
      expect(h.min, provider).toMatchObject({ headroom: null, unknown: true });
      for (const w of h.windows) expect(w, `${provider} ${w.kind}`).toMatchObject({ headroom: null, unknown: true });
    }
  });

  it('an unreadable glm (until-stop) still runs — unknown is until-stop, not a cap', async () => {
    const u: any = await freshUsageWithGlmReserve(5);
    expect(u.gateFor('glm', { status: 'unavailable', reason: 'reader:unavailable' }).state).toBe('ok');
    expect(u.gateFor('gemini', { status: 'unavailable', reason: 'reader:unavailable' }).state).toBe('ok');
  });
});
