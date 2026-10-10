import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM tooling
import { normalize, createLineSplitter } from '../dispatcher/events.mjs';
const BOUND_MS = 150; // measured 2026-10-10: quadratic splitter 345 ms on this test, linear 8 ms
const lines = (cli: string) => readFileSync(new URL(`./fixtures/orchestra-events/${cli}.jsonl`, import.meta.url), 'utf8').trimEnd().split('\n');
const expected: Record<string, string[]> = {
  codex: ['step', 'warn', 'warn', 'step', 'warn', 'message', 'tool.start', 'tool.end', 'message', 'usage'],
  opencode: ['step', 'tool.end', 'usage', 'step', 'message', 'usage'],
  agy: ['step', 'step', 'usage', 'tool.start', 'tool.end', 'usage', 'tool.start', 'tool.end', 'message', 'message', 'usage', 'message'],
  muse: ['step', 'tool.end', 'tool.end', 'message', 'message'],
};
describe('CLI event normalization', () => {
  for (const cli of Object.keys(expected)) it(`${cli} exact fixture sequence`, () => {
    const state = { dropped: {} };
    const events = lines(cli).flatMap(line => normalize(cli, line, state));
    expect(events.map(e => e.kind)).toEqual(expected[cli]);
    for (const event of events) {
      expect(event).not.toHaveProperty('at');
      for (const key of ['text', 'detail', 'line']) if (key in event) expect(event[key].length).toBeLessThanOrEqual(500);
    }
    if (cli === 'codex') expect(events.filter(e => e.kind === 'warn')).toHaveLength(3);
    if (cli === 'opencode') expect(events.some(e => e.kind === 'tool.start')).toBe(false);
    if (cli === 'muse') expect(Object.values(state.dropped).reduce((a: number, b: number) => a + b, 0)).toBe(lines(cli).length - events.length);
  });
  it('splitter preserves partial JSON, utf8 bytes and final unterminated tail', () => {
    const source = lines('codex').join('\n');
    const bytes = Buffer.from(source);
    const splitter = createLineSplitter();
    const at = bytes.indexOf(Buffer.from('’')) + 1;
    const actual = [...splitter.push(bytes.subarray(0, at)), ...splitter.push(bytes.subarray(at)), ...splitter.end()];
    expect(actual).toEqual(lines('codex'));
    expect(actual.flatMap(line => normalize('codex', line, {}))).toEqual(lines('codex').flatMap(line => normalize('codex', line, {})));
    expect(splitter.end()).toEqual([]);
  });
  it('preserves blank lines and CR verbatim in the splitter', () => {
    const splitter = createLineSplitter();
    expect(splitter.push('a\r\n\nb')).toEqual(['a\r', '']);
    expect(splitter.end()).toEqual(['b']);
  });
  it('handles non JSON and unknown CLIs without throwing, truncating fields', () => {
    expect(normalize('codex', 'x'.repeat(900), {})).toEqual([{ kind: 'unparsed', line: 'x'.repeat(500) }]);
    expect(normalize('other', '{"type":"hello"}', {})).toEqual([{ kind: 'unparsed', line: '{"type":"hello"}' }]);
    for (const line of ['null', '[]', '2', '{}', '{"type":"item.completed"}']) expect(() => normalize('codex', line, {})).not.toThrow();
    const events = normalize('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'z'.repeat(900) } }), {});
    expect(events).toEqual([{ kind: 'message', text: 'z'.repeat(500) }]);
  });
  it('maps source-derived codex item types absent from the capture', () => {
    // Hand-written from openai/codex codex-rs/exec/src/exec_events.rs struct shapes
    // (serde tag "type", rename_all snake_case, item fields flattened next to id).
    // These are source-derived, NOT captured output.
    const state: { dropped: Record<string, number> } = { dropped: {} };
    const line = (raw: unknown) => normalize('codex', JSON.stringify(raw), state);
    expect(line({ type: 'item.completed', item: { type: 'file_change', status: 'completed',
      changes: [{ path: 'src/a.ts', kind: 'add' }, { path: 'src/b.ts', kind: 'update' }] } }))
      .toEqual([{ kind: 'tool.end', tool: 'file_change', detail: 'add src/a.ts, update src/b.ts', ok: true }]);
    expect(line({ type: 'item.completed', item: { type: 'file_change', status: 'failed',
      changes: [{ path: 'x', kind: 'delete' }] } }))
      .toEqual([{ kind: 'tool.end', tool: 'file_change', detail: 'delete x', ok: false }]);
    expect(line({ type: 'item.started', item: { type: 'file_change', status: 'in_progress', changes: [] } })).toEqual([]);
    expect(line({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'git', tool: 'list_files', arguments: { path: '.' }, status: 'in_progress' } }))
      .toEqual([{ kind: 'tool.start', tool: 'git.list_files', detail: '{"path":"."}' }]);
    expect(line({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'git', tool: 'list_files', arguments: { path: '.' }, status: 'failed', error: { message: 'boom' } } }))
      .toEqual([{ kind: 'tool.end', tool: 'git.list_files', detail: '{"path":"."}', ok: false }]);
    expect(line({ type: 'item.started', item: { type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: ['t1', 't2'], status: 'in_progress' } }))
      .toEqual([{ kind: 'tool.start', tool: 'collab.spawn_agent', detail: '["t1","t2"]' }]);
    expect(line({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: [], status: 'completed' } }))
      .toEqual([{ kind: 'tool.end', tool: 'collab.wait', detail: '[]', ok: true }]);
    expect(line({ type: 'item.started', item: { type: 'web_search', query: 'vitest timers' } }))
      .toEqual([{ kind: 'tool.start', tool: 'web_search', detail: 'vitest timers' }]);
    expect(line({ type: 'item.completed', item: { type: 'web_search', query: 'vitest timers', status: 'completed' } }))
      .toEqual([{ kind: 'tool.end', tool: 'web_search', detail: 'vitest timers', ok: true }]);
  });
  it('renders todo_list progress and keeps other item.updated events dropped', () => {
    // Source-derived todo_list shapes (exec_events.rs), NOT captured output.
    const state: { dropped: Record<string, number> } = { dropped: {} };
    const line = (raw: unknown) => normalize('codex', JSON.stringify(raw), state);
    expect(line({ type: 'item.started', item: { type: 'todo_list',
      items: [{ text: 'plan', completed: true }, { text: 'write tests', completed: false }] } }))
      .toEqual([{ kind: 'step', label: 'todo 1/2: write tests' }]);
    expect(line({ type: 'item.updated', item: { type: 'todo_list',
      items: [{ text: 'plan', completed: true }, { text: 'write tests', completed: true }, { text: 'commit', completed: false }] } }))
      .toEqual([{ kind: 'step', label: 'todo 2/3: commit' }]);
    expect(line({ type: 'item.completed', item: { type: 'todo_list',
      items: [{ text: 'plan', completed: true }, { text: 'write tests', completed: true }] } }))
      .toEqual([{ kind: 'step', label: 'todo 2/2: ' }]);
    expect(line({ type: 'item.updated', item: { type: 'agent_message', text: 'partial' } })).toEqual([]);
    expect(state.dropped['item.updated']).toBe(1);
    expect(line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } })).toEqual([]);
    expect(state.dropped['item.completed']).toBe(1);
  });
  it('derives codex ok from status and keeps exit-code precedence', () => {
    const line = (item: unknown) => normalize('codex', JSON.stringify({ type: 'item.completed', item }), {})[0];
    expect(line({ type: 'command_execution', command: 'x', status: 'completed' }).ok).toBe(true);
    expect(line({ type: 'command_execution', command: 'x', status: 'declined' }).ok).toBe(false);
    expect(line({ type: 'command_execution', command: 'x' }).ok).toBeNull();
    expect(line({ type: 'mcp_tool_call', server: 's', tool: 't', status: 'declined' }).ok).toBe(false);
    expect(line({ type: 'command_execution', command: 'x', exit_code: 2, status: 'completed' }).ok).toBe(false);
  });
  it('maps codex turn.failed to a warning carrying the error message', () => {
    expect(normalize('codex', '{"type":"turn.failed","error":{"message":"stream disconnected"}}', {}))
      .toEqual([{ kind: 'warn', text: 'stream disconnected' }]);
  });
  it('keeps missing usage and tool outcome unknown, observed zeros and failures explicit', () => {
    expect(normalize('codex', '{"type":"turn.completed","usage":{"output_tokens":0}}', {})).toEqual([{ kind: 'usage', input: null, output: 0, cached: null, reasoning: null }]);
    for (const [exit_code, ok] of [[null, null], [0, true], [2, false]]) {
      expect(normalize('codex', JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code}}), {})[0].ok).toBe(ok);
    }
    expect(normalize('agy', JSON.stringify({event:'step_update',step_update:{step_type:'tool',state:'DONE'}}), {})[0].ok).toBeNull();
  });
  it('maps CLI-emitted error events to warn and collects their full text; codex item errors stay warnings only', () => {
    // Source-derived, NOT captured: opencode 1.18.34 run emitter (installed binary) writes
    // {type:"error",timestamp,sessionID,error} on session.error / prompt failure and exits 1;
    // codex turn.failed/error from exec_events.rs; agy non-SUCCESS result and muse run.terminal.*
    // other than completed are unverified shapes built from the captured success lines.
    const state: { dropped: Record<string, number>; cliErrors?: string[] } = { dropped: {} };
    expect(normalize('codex', '{"type":"item.completed","item":{"type":"error","message":"usage limit notice"}}', state))
      .toEqual([{ kind: 'warn', text: 'usage limit notice' }]);
    expect(state.cliErrors ?? []).toEqual([]);
    const long = 'quota exceeded '.repeat(60);
    expect(normalize('opencode', JSON.stringify({ type: 'error', timestamp: 1, sessionID: 's',
      error: { name: 'APIError', data: { message: long } } }), state))
      .toEqual([{ kind: 'warn', text: long.slice(0, 500) }]);
    expect(normalize('codex', '{"type":"turn.failed","error":{"message":"rate limit"}}', state)).toEqual([{ kind: 'warn', text: 'rate limit' }]);
    expect(normalize('codex', '{"type":"error","message":"stream error"}', state)).toEqual([{ kind: 'warn', text: 'stream error' }]);
    expect(normalize('agy', JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'insufficient quota',
      response: 'model text: usage limit', usage: { input_tokens: 1 } } }), state).map(e => e.kind)).toEqual(['warn', 'message', 'usage']);
    expect(normalize('agy', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'quota exceeded' } }), state))
      .toEqual([{ kind: 'message', text: 'quota exceeded' }]);
    expect(normalize('muse', JSON.stringify({ payload_type: 'run.terminal.failed',
      payload: { terminal: 'failed', text: 'model text', reason: 'rate limit' } }), state))
      .toEqual([{ kind: 'warn', text: 'run.terminal.failed: rate limit' }]);
    expect(state.cliErrors).toHaveLength(5);
    expect(state.cliErrors![0]).toContain(long);
    expect(state.cliErrors!.join('\n')).not.toContain('model text');
    expect(state.cliErrors!.join('\n')).not.toContain('usage limit notice');
    expect(state.dropped).toEqual({});
  });
  it('caps distinct dropped keys at 50 and keeps the overflow key safe', () => {
    const state: { dropped: Record<string, number> } = { dropped: Object.create(null) };
    const types = ['__proto__', 'constructor', ...Array.from({ length: 58 }, (_, i) => `t${i}`)];
    for (const type of types) normalize('codex', JSON.stringify({ type }), state);
    expect(Object.keys(state.dropped)).toHaveLength(51);
    expect(state.dropped.__other__).toBe(10);
    expect(Object.getPrototypeOf(state.dropped)).toBeNull();
    expect(Object.hasOwn(state.dropped, '__proto__')).toBe(true);
  });
  it('splits a 16 MB line in 64 KB chunks in linear time', () => {
    const splitter = createLineSplitter();
    const chunk = Buffer.from('x'.repeat(64 * 1024));
    const started = performance.now();
    const out: string[] = [];
    for (let i = 0; i < 256; i++) out.push(...splitter.push(chunk));
    out.push(...splitter.push(Buffer.from('\n')), ...splitter.end());
    const ms = performance.now() - started;
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(16 * 1024 * 1024);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe('agy run totals', () => {
  // Measured on the agy fixture: result.usage.input_tokens 43768 = 38807 + 2688 + 2273, the sum of
  // its step usages. Emitting both double-counts every token in a consumer that sums usage events.
  it('emits result.usage only when the run reported no step usage', () => {
    const total = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 9, output_tokens: 1 } } });
    const step = JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 9, output_tokens: 1 } } });
    expect(normalize('agy', total, {}).filter(e => e.kind === 'usage')).toHaveLength(1);
    const state = {};
    normalize('agy', step, state);
    expect(normalize('agy', total, state).filter(e => e.kind === 'usage')).toHaveLength(0);
  });
});
