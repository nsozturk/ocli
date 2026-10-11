import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { normalize } from '../dispatcher/events.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { SHELL_TOOLS, EDIT_TOOLS, witness } from '../dispatcher/witness.mjs';

// Real `cline --json` captures (cline 3.0.70, Cline Pass, 2026-10-11), paths sanitised.
const lines = (name: string) => readFileSync(new URL(`./fixtures/cline/${name}.jsonl`, import.meta.url), 'utf8').trimEnd().split('\n');
const run = (name: string) => {
  const state: any = {};
  const events = lines(name).flatMap(line => normalize('cline', line, state));
  return { state, events };
};

describe('cline --json normaliser', () => {
  it('turns a real successful run into steps, paired tool calls, usage and the final text', () => {
    const { state, events } = run('run-ok');
    expect(events.filter((e: any) => e.kind === 'step').map((e: any) => e.label))
      .toEqual(['iteration 1', 'iteration 2', 'iteration 3', 'iteration 4']);
    const tools = events.filter((e: any) => e.kind === 'tool.start' || e.kind === 'tool.end')
      .map((e: any) => [e.kind, e.tool, e.detail, e.ok]);
    expect(tools).toEqual([
      ['tool.start', 'read_files', '/work/wt/note.txt', undefined],
      ['tool.end', 'read_files', '/work/wt/note.txt', true],
      ['tool.start', 'edit', '/work/wt/done.txt', undefined],
      ['tool.end', 'edit', '/work/wt/done.txt', true],
      ['tool.start', 'read_files', '/work/wt/done.txt', undefined],
      ['tool.end', 'read_files', '/work/wt/done.txt', true],
    ]);
    // Per-call usage sums to the run total (25045 / 213 / 18048); done and run_result are not counted twice.
    const usage = events.filter((e: any) => e.kind === 'usage');
    expect(usage).toHaveLength(4);
    const sum = (k: string) => usage.reduce((s: number, e: any) => s + (e[k] ?? 0), 0);
    expect([sum('input'), sum('output'), sum('cached')]).toEqual([25045, 213, 18048]);
    // The last message is content_end's complete text, which dispatch.mjs keeps as the final text.
    const messages = events.filter((e: any) => e.kind === 'message');
    expect(messages.at(-1).text.startsWith('DONE')).toBe(true);
    expect(messages.at(-1).text).toContain('Created `/work/wt/done.txt`');
    // hook_event, iteration_end, done and run_result are handled on purpose, never counted as dropped.
    expect(Object.keys(state.dropped ?? {})).toEqual([]);
    expect(state.cliErrors ?? []).toEqual([]);
  });

  it('reports a provider error as a warn and as the CLI’s own words for decideBlocked', () => {
    const { state, events } = run('run-error');
    const warns = events.filter((e: any) => e.kind === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain("failed to invoke model 'stealth/pixel-canary'");
    expect(state.cliErrors).toHaveLength(1);
    expect(state.cliErrors[0]).toContain('status 404');
    expect(events.some((e: any) => e.kind === 'message')).toBe(false);
  });

  it('maps cline tool names onto the shared vocabulary so the witness sees edits and test runs', () => {
    const state: any = {};
    const ev = (event: object) => JSON.stringify({ ts: 't', type: 'agent_event', event });
    const out = [
      ev({ type: 'content_start', contentType: 'tool', toolName: 'run_commands', toolCallId: 'c1', input: { commands: ['npm install', 'npx vitest run tests/x.test.ts'] } }),
      ev({ type: 'content_end', contentType: 'tool', toolName: 'run_commands', toolCallId: 'c1', output: [{ success: true }, { success: false }] }),
    ].flatMap(line => normalize('cline', line, state));
    const end = out.find((e: any) => e.kind === 'tool.end');
    expect(end).toEqual({ kind: 'tool.end', tool: 'run_command', detail: 'npm install\nnpx vitest run tests/x.test.ts', ok: false });
    expect(SHELL_TOOLS.has('run_command')).toBe(true);
    expect(EDIT_TOOLS.has('edit')).toBe(true);
    // The witness now finds the test run in cline's trace.
    const found = witness([{ ...end, kind: 'tool.end' }], 'All tests pass.', {});
    expect(found.findings.map((f: any) => f.code)).not.toContain('claimedTestsButNone');
  });

  it('never resolves a CLI-controlled tool name through the prototype, and bounds remembered calls', () => {
    const state: any = {};
    const ev = (event: object) => JSON.stringify({ type: 'agent_event', event });
    const [start] = normalize('cline', ev({ type: 'content_start', contentType: 'tool', toolName: 'constructor', toolCallId: 'x', input: {} }), state);
    expect(start.tool).toBe('constructor');
    for (let i = 0; i < 200; i++) normalize('cline', ev({ type: 'content_start', contentType: 'tool', toolName: 'read_files', toolCallId: `id${i}`, input: { files: [] } }), state);
    expect(state.clineCalls.size).toBeLessThanOrEqual(50);
  });

  it('counts an unknown agent event as dropped under its own name, and survives junk lines', () => {
    const state: any = {};
    expect(normalize('cline', JSON.stringify({ type: 'agent_event', event: { type: 'brand_new' } }), state)).toEqual([]);
    expect(state.dropped['agent_event.brand_new']).toBe(1);
    for (const line of ['null', '[]', '2', '{}', '{"type":"agent_event"}', '{"type":"agent_event","event":null}']) {
      expect(() => normalize('cline', line, {})).not.toThrow();
    }
  });
});

describe('cline routes in the example policy', () => {
  it('cline routes resolve every placeholder; a route without an effort never passes --thinking', () => {
    const policy = JSON.parse(readFileSync(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8'));
    const cline = Object.entries(policy.routes).filter(([, r]: any) => r.cli === 'cline');
    expect(cline.map(([role]) => role)).toEqual(['cline-mimo', 'cline-qwen']);
    const filled = new Set(['model', 'effort', 'variant', 'task', 'root', 'prompt']);
    for (const [, r] of cline as any[]) {
      expect(r.argv.slice(0, 2)).toEqual(['-P', 'cline-pass']);
      expect(r.argv[r.argv.indexOf('-c') + 1]).toBe('{root}');
      expect(r.argv.includes('--thinking')).toBe(r.effort !== undefined);
      for (const item of r.argv) for (const [, name] of item.matchAll(/\{([^{}]+)\}/g)) expect(filled.has(name)).toBe(true);
    }
  });
});

describe('cline reasoning content', () => {
  it('reasoning deltas and their end are handled and never counted as dropped; an unknown content type is', () => {
    const state: any = {};
    const ev = (event: object) => JSON.stringify({ type: 'agent_event', event });
    expect(normalize('cline', ev({ type: 'content_start', contentType: 'reasoning', reasoning: 'Verify', redacted: false }), state)).toEqual([]);
    expect(normalize('cline', ev({ type: 'content_end', contentType: 'reasoning', reasoning: 'Verify quickly.' }), state)).toEqual([]);
    expect(state.dropped?.['agent_event.content_start']).toBeUndefined();
    expect(state.dropped?.['agent_event.content_end']).toBeUndefined();
    normalize('cline', ev({ type: 'content_start', contentType: 'image' }), state);
    expect(state.dropped['agent_event.content_start']).toBe(1);
  });
});
