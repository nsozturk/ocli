import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { aaFor, parseRanking, routeEffort } from '../dispatcher/ranking.mjs';

const real = readFileSync(new URL('../dispatcher/model-ranking.example.json', import.meta.url), 'utf8');

describe('model ranking (AA Intelligence Index)', () => {
  it('the real file parses, carries its source and date, and holds one entry per (model, effort)', () => {
    const r = parseRanking(real);
    expect(r.source).toBe('Artificial Analysis Intelligence Index');
    expect(r.observedAt).toBe('2026-10-11');
    const keys = r.entries.map((e: any) => `${e.model}@${e.effort}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Spot values the user pasted from AA.
    const aa = (model: string, effort: string | null) => r.entries.find((e: any) => e.model === model && e.effort === effort)?.aa;
    expect(aa('claude-opus-5.5', 'max')).toBe(58);
    expect(aa('gpt-6-astra', 'high')).toBe(51);
    expect(aa('muse-spark-1.3', 'max')).toBe(48);
    expect(aa('mimo-v2.6-pro', null)).toBe(46);
    expect(aa('deepseek-v4.1-flash', 'max')).toBe(39);
  });

  it('matches exactly (cli, model, effort): another effort, CLI or model is unranked, never a neighbour', () => {
    const r = parseRanking(real);
    expect(aaFor(r, { cli: 'codex', model: 'gpt-6-astra', effort: 'high' })).toBe(51);
    expect(aaFor(r, { cli: 'codex', model: 'gpt-6-astra', effort: 'ultra' })).toBeNull();
    expect(aaFor(r, { cli: 'opencode', model: 'zai-coding-plan/glm-5.3', variant: 'max' })).toBe(45);
    expect(aaFor(r, { cli: 'opencode', model: 'zai-coding-plan/glm-5.3', variant: 'high' })).toBeNull();
    expect(aaFor(r, { cli: 'agy', model: 'gemini-3.8-flash-high' })).toBe(41);
    expect(aaFor(r, { cli: 'cline', model: 'cline-pass/mimo-v2.6-pro' })).toBe(46);
    expect(aaFor(r, { cli: 'cline', model: 'cline-pass/mimo-v2.6-pro', effort: 'high' })).toBeNull();
    expect(aaFor(null, { cli: 'codex', model: 'gpt-6-astra', effort: 'high' })).toBeNull();
    expect(routeEffort({ variant: 'max' })).toBe('max');
    expect(routeEffort({})).toBeNull();
  });

  it('refuses an unrecognised shape by name', () => {
    expect(() => parseRanking('{"schemaVersion":2,"entries":[]}')).toThrow(/schemaVersion 1/);
    expect(() => parseRanking(JSON.stringify({ schemaVersion: 1, entries: [{ model: 'm', effort: 'x', aa: '45', access: [] }] }))).toThrow(/entry 0/);
    expect(() => parseRanking(JSON.stringify({ schemaVersion: 1, entries: [{ model: 'm', effort: null, aa: 4, access: [{ cli: 'c' }] }] }))).toThrow(/entry 0/);
  });
});
