import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { EXAMPLE_PLANS, parsePlans, stopAtPercentFor } from '../dispatcher/plans.mjs';

// The starter is what an install with no dispatcher/policy.json and no provider-plans.json runs on:
// codex + opencode only. The rest of the suite runs on the *.full-roster.json files.
const policy = JSON.parse(readFileSync(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8'));
const full = JSON.parse(readFileSync(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8'));

describe('starter config (policy.example.json + provider-plans.example.json)', () => {
  it('the plans loader defaults to the starter plans file', () => {
    expect(EXAMPLE_PLANS).toBe(fileURLToPath(new URL('../dispatcher/provider-plans.example.json', import.meta.url)));
  });

  it('ships exactly the codex and opencode developer routes, both ok and both rotated', () => {
    const developers = Object.entries(policy.routes).filter(([, r]: [string, any]) => Array.isArray(r.argv));
    expect(developers.map(([role, r]: [string, any]) => [role, r.cli, r.status])).toEqual([
      ['implement', 'opencode', 'ok'], ['reason', 'codex', 'ok'],
    ]);
    expect(policy.developers.rotation.order).toEqual(['implement', 'reason']);
  });

  it('the codex default is GPT-6.1 Sol xhigh, the same route the full roster ships', () => {
    expect([policy.routes.reason.model, policy.routes.reason.effort]).toEqual(['gpt-6.1-sol', 'xhigh']);
    expect(policy.routes.reason).toEqual(full.routes.reason);
    expect(policy.routes.implement).toEqual(full.routes.implement);
  });

  it('the starter plans parse and carry the three core pools the usage gate requires', () => {
    const plans = parsePlans(readFileSync(EXAMPLE_PLANS, 'utf8'));
    expect(Object.keys(plans.providers).sort()).toEqual(['claude', 'codex', 'glm']);
    expect(stopAtPercentFor(plans, 'codex')).toBe(95);
    expect(plans.providers.glm.onUnknown).toBe('until-stop'); // no CodexBar: glm runs until its provider stops it
  });
});
