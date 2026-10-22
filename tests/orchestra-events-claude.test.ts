import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - dispatcher tooling is plain ESM.
import { normalize } from '../dispatcher/events.mjs';

// Claude Code `--output-format stream-json --verbose` fixture, HAND-WRITTEN from the documented
// shapes (claude --help on this Mac, 2026-10-17) — never captured from a live CLI run.
const lines = readFileSync(new URL('./fixtures/orchestra-events/claude.jsonl', import.meta.url), 'utf8').trimEnd().split('\n');
const run = () => {
  const state: any = {};
  const events = lines.flatMap(line => normalize('claude', line, state));
  return { state, events };
};

describe('claude stream-json normaliser', () => {
  it('turns the fixture into steps, messages, paired tool calls, usage; the final message is the result text', () => {
    const { state, events } = run();
    expect(events.map((e: any) => e.kind)).toEqual([
      'step', 'message', 'tool.start', 'tool.end', 'message', 'tool.start', 'message', 'tool.end', 'message', 'usage',
    ]);
    // system/init becomes a step carrying the model.
    expect(events[0]).toEqual({ kind: 'step', label: 'init claude-opus-5-5' });
    // tool_use / tool_result pair into the shared tool event shape (tool, detail from the input, ok).
    expect(events.filter((e: any) => e.kind === 'tool.start' || e.kind === 'tool.end')
      .map((e: any) => [e.kind, e.tool, e.detail, e.ok])).toEqual([
        ['tool.start', 'Read', '{"file_path":"/work/wt/AGENTS.md"}', undefined],
        ['tool.end', 'Read', '{"file_path":"/work/wt/AGENTS.md"}', true],
        ['tool.start', 'Bash', '{"command":"npx vitest run tests/x.test.ts"}', undefined],
        ['tool.end', 'Bash', '{"command":"npx vitest run tests/x.test.ts"}', false],
      ]);
    // result.usage -> one usage event (input, output, cache_read as cached, no reasoning field).
    expect(events.at(-1)).toEqual({ kind: 'usage', input: 120, output: 34, cached: 456, reasoning: null });
    // The result text is the FINAL message, so dispatch.mjs keeps it as the run's finalText.
    const messages = events.filter((e: any) => e.kind === 'message');
    expect(messages.at(-1).text).toBe('Slice delivered; 12 tests green.');
    expect(messages.at(-2).text).toBe('then I will report.'); // an assistant block, not the final answer
    expect(Object.keys(state.dropped ?? {})).toEqual([]);
    expect(state.cliErrors ?? []).toEqual([]);
  });

  it('an is_error result is a CLI error, never the final message; its usage still counts', () => {
    const state: any = {};
    const line = (raw: unknown) => normalize('claude', JSON.stringify(raw), state);
    expect(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Halfway.' }] } }))
      .toEqual([{ kind: 'message', text: 'Halfway.' }]);
    expect(line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Exceeded max turns',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } }).map((e: any) => e.kind))
      .toEqual(['warn', 'usage']);
    expect(state.cliErrors).toHaveLength(1);
    expect(state.cliErrors[0]).toContain('Exceeded max turns');
    // The error text never became a message, so it can never be finalText.
    expect(state.cliErrors[0]).not.toContain('Halfway');
  });

  it('counts unknown types as dropped under their own name, and survives junk lines', () => {
    const state: any = {};
    expect(normalize('claude', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } }), state)).toEqual([]);
    expect(state.dropped['stream_event']).toBe(1);
    for (const line of ['null', '[]', '2', '{}', '{"type":"assistant"}', '{"type":"user"}', '{"type":"system","subtype":"compact"}']) {
      expect(() => normalize('claude', line, {})).not.toThrow();
    }
    // A non-init system subtype and an assistant line with no content array are dropped, not guessed.
    const s: any = {};
    normalize('claude', '{"type":"system","subtype":"compact"}', s);
    normalize('claude', '{"type":"assistant","message":{"content":"plain"}}', s);
    expect(s.dropped['system']).toBe(1);
    expect(s.dropped['assistant']).toBe(1);
  });

  it('bounds the remembered tool calls and answers an orphan tool_result with tool unknown', () => {
    const state: any = {};
    const use = (id: string) => normalize('claude', JSON.stringify({ type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/x/${id}` } }] } }), state);
    for (let i = 0; i < 200; i++) use(`toolu_${i}`);
    expect(state.claudeCalls.size).toBeLessThanOrEqual(50);
    const orphan = normalize('claude', JSON.stringify({ type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'never_seen', is_error: false }] } }), state);
    expect(orphan).toEqual([{ kind: 'tool.end', tool: 'unknown', detail: '', ok: true }]);
  });
});

describe('opus route in the shipped example policy', () => {
  const policy = JSON.parse(readFileSync(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8'));

  it('claude developer route: stream-json argv, acceptEdits, NO bypass flag, prompt right after -p', () => {
    const route = policy.routes.opus;
    expect([route.cli, route.model, route.effort, route.status]).toEqual(['claude', 'claude-opus-5-5', 'medium', 'ok']);
    expect(route.argv).toContain('-p');
    expect(route.argv.slice(route.argv.indexOf('--output-format'), route.argv.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'stream-json']);
    expect(route.argv).toContain('--verbose'); // stream-json requires it
    expect(route.argv[route.argv.indexOf('--add-dir') + 1]).toBe('{root}');
    // Live smoke 2026-10-17: --add-dir and --allowedTools are variadic and swallowed a trailing prompt
    // ('Input must be provided … when using --print'), so the prompt sits right after -p.
    expect(route.argv.slice(0, 2)).toEqual(['-p', '{prompt}']);
    expect(route.argv.filter((item: string) => item === '{prompt}')).toHaveLength(1);
    // No bypass: the guardrails are the point, and a mutation adding a bypass flag must fail here.
    expect(route.argv).not.toContain('--dangerously-skip-permissions');
    expect(route.argv).not.toContain('bypassPermissions');
    expect(route.argv[route.argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const filled = new Set(['model', 'effort', 'variant', 'task', 'root', 'prompt']);
    for (const item of route.argv) for (const [, name] of item.matchAll(/\{([^{}]+)\}/g)) expect(filled.has(name)).toBe(true);
  });

  it('--allowedTools is ONE string listing exactly the slice toolset and its Bash prefixes', () => {
    const allowed: string = policy.routes.opus.argv[policy.routes.opus.argv.indexOf('--allowedTools') + 1];
    expect(typeof allowed).toBe('string');
    expect(allowed.split(',').sort()).toEqual([
      // Package: generic verification prefixes (canonical carries its own repo's env-hygiene prefix).
      'Bash(cp:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)',
      'Bash(ls:*)', 'Bash(mkdir -p:*)', 'Bash(npm test:*)', 'Bash(npx tsc --noEmit:*)', 'Bash(npx vitest run:*)',
      'Edit', 'Glob', 'Grep', 'Read', 'Write',
    ]);
  });
});
