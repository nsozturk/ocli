import { describe, expect, it } from 'vitest';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of the typed src build.
import { meteredTokens, nodeMetered } from '../dispatcher/events.mjs';

// Q20: metered = uncached input + output, reasoning added only when the CLI keeps it outside output.
describe('meteredTokens', () => {
  it('codex: input includes cached, output includes reasoning ⇒ 1000 − 600 + 300 = 700', () => {
    expect(meteredTokens('codex', { input: 1000, output: 300, cached: 600, reasoning: 200 })).toBe(700);
  });
  it('claude: input already excludes cache reads, no reasoning field ⇒ input + output', () => {
    expect(meteredTokens('claude', { input: 1000, output: 300, cached: 600, reasoning: null })).toBe(1300);
  });
  it('opencode: four exclusive buckets (fixture total = input + output + reasoning + cache.read) ⇒ + reasoning', () => {
    expect(meteredTokens('opencode', { input: 59632, output: 21, cached: 128, reasoning: 41 })).toBe(59694);
  });
  it('agy: output includes thinking (fixture total_tokens = input + output) ⇒ never added twice', () => {
    expect(meteredTokens('agy', { input: 38807, output: 496, cached: 0, reasoning: 399 })).toBe(39303);
  });
  it('unknown semantics keep the pre-Q20 rule: input + output + reasoning', () => {
    expect(meteredTokens('cline', { input: 6203, output: 47, cached: 5888, reasoning: null })).toBe(6250);
    expect(meteredTokens('nope', { input: 10, output: 5, cached: 3, reasoning: 2 })).toBe(17);
  });
  it('input or output null ⇒ null; cached / reasoning null count as 0', () => {
    expect(meteredTokens('codex', { input: null, output: 5, cached: 1, reasoning: 1 })).toBeNull();
    expect(meteredTokens('codex', { input: 5, output: null, cached: 1, reasoning: 1 })).toBeNull();
    expect(meteredTokens('codex', { input: 13, output: 6, cached: null, reasoning: null })).toBe(19);
    expect(meteredTokens('codex', null)).toBeNull();
  });
});

// Q20 review pin (mutant M10): a node carrying any raw field is recomputed; its stored metered is
// only the fallback when it has neither input nor output.
describe('nodeMetered', () => {
  it('raw input present but output missing ⇒ null, never the stored metered', () => {
    expect(nodeMetered({ cli: 'codex', tokens: { input: 1000, output: null, metered: 1500 } })).toBeNull();
  });
});
