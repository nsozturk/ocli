import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - dispatcher tooling is plain ESM
import { writeUsageSnapshot, snapshotFile, policyRoutes } from '../dispatcher/usage-snapshot.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM
import { gateFor } from '../dispatcher/usage.mjs';

// u5 review: gate.window must equal what gateFor itself binds, for the provider (no model) and for every scoped
// route (its model) — checked against gateFor directly, not against a hand-written expectation.
const policy = JSON.parse(readFileSync(fileURLToPath(new URL('../dispatcher/policy.full-roster.json', import.meta.url)), 'utf8'));
const FUTURE = '2099-01-01T00:00:00.000Z';
const win = (limitId: string, usedPercent: number | null, windowDurationMins: number) => ({ limitId, usedPercent, windowDurationMins, resetsAt: FUTURE });
const ok = (...windows: unknown[]) => ({ status: 'ok', source: 'native:test', windows });
const G = 'antigravity-quota-summary-gemini';
const READINGS: Record<string, unknown>[] = [
  { gemini: ok(win(`${G}-5h`, 10, 300), win(`${G}-weekly`, 39, 10080), win(`${G}-argon-wtu-weekly`, 100, 10080)) },
  { gemini: ok(win(`${G}-5h`, 80, 300), win(`${G}-weekly`, 20, 10080), win(`${G}-argon-wtu-weekly`, 5, 10080)) },
  { gemini: ok(win(`${G}-weekly`, null, 10080), win(`${G}-argon-wtu-weekly`, 90, 10080)) },
  { codex: ok(win('codex', 20, 300), win('codex', 30, 10080), win('codex-spark', 95, 300), win('codex-other', 60, 300)) },
  { codex: ok(win('codex', 99, 300), win('codex', 30, 10080)), glm: ok(win('zai-5h', 70, 300)) },
];

describe('snapshot gate.window = gateFor(...).window', () => {
  let live: string;
  let tree: string;
  beforeEach(() => {
    live = mkdtempSync(path.join(tmpdir(), 'ocli-u5-live-'));
    tree = mkdtempSync(path.join(tmpdir(), 'ocli-u5-tree-'));
    vi.stubEnv('ORCHESTRA_LIVE_DIR', live);
    vi.stubEnv('ORCHESTRA_TREE_DIR', tree);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(live, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });
  const pick = (w: Record<string, unknown> | undefined) => (w ? { limitId: w.limitId, windowDurationMins: w.windowDurationMins, usedPercent: w.usedPercent, resetsAt: w.resetsAt } : null);

  it.each(READINGS.map((r, i) => [i, r] as const))('reading %i: provider and every route', async (_i, readings) => {
    const res = await writeUsageSnapshot({ dir: live, treeDir: tree, readings, routes: policyRoutes(policy), now: Date.parse('2026-10-23T10:00:00Z') });
    expect(res.ok).toBe(true);
    const doc = JSON.parse(readFileSync(snapshotFile(live), 'utf8'));
    for (const [provider, reading] of Object.entries(readings)) {
      const entry = doc.providers[provider];
      const g = gateFor(provider, reading);
      expect(entry.gate.state, provider).toBe(g.state);
      expect(entry.gate.window, provider).toEqual(pick(g.window));
      for (const route of entry.routes ?? []) {
        const rg = gateFor(provider, reading, route.model);
        expect(route.gate.state, route.model).toBe(rg.state);
        expect(route.gate.window, route.model).toEqual(pick(rg.window));
      }
    }
    expect(doc.providers.gemini?.routes?.length ?? 1).toBeGreaterThan(0);
  });
  it('gate.window is rebuilt: a field a reader put on the bound window is never copied', async () => {
    const bound = { ...win('codex', 30, 10080), account: 'someone@example.com', token: 'sk-live-0123456789abcdef' };
    await writeUsageSnapshot({ dir: live, treeDir: tree, readings: { codex: ok(win('codex', 20, 300), bound) }, routes: [], now: Date.parse('2026-10-23T10:00:00Z') });
    const body = readFileSync(snapshotFile(live), 'utf8');
    expect(JSON.parse(body).providers.codex.gate.window).toEqual({ limitId: 'codex', windowDurationMins: 10080, usedPercent: 30, resetsAt: FUTURE });
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('sk-live');
  });
});
