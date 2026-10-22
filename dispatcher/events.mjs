import { StringDecoder } from 'node:string_decoder';

// run.end.status is one of completed | failed | blocked | spawn-error | dispatch-error. The last
// means the dispatcher itself threw after the CLI ran (tree write, usage reader, verifier), so the
// node was not recorded and dispatch exits 2; exitCode still carries what the CLI returned.
//
// state.cliErrors collects the UNTRUNCATED text of events the CLI itself emits to report a failure
// (never model-authored text). dispatch.mjs hands it to decideBlocked as the CLI's own words.

const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const message = value => ({ kind: 'message', text: text(value) });
const step = label => ({ kind: 'step', label });
const usage = (input, output, cached, reasoning) => ({
  kind: 'usage', input: number(input), output: number(output), cached: number(cached), reasoning: number(reasoning),
});
const codexUsage = u => usage(u?.input_tokens, u?.output_tokens, u?.cached_input_tokens, u?.reasoning_output_tokens);
const agyUsage = u => usage(u?.input_tokens, u?.output_tokens, u?.cache_read_tokens, u?.thinking_tokens);
// Q20: what each CLI's usage fields contain, so metered = uncached input + output, reasoning added
// only when it sits outside output. Measured: codex (OpenAI usage) input_tokens includes
// cached_input_tokens and output_tokens includes reasoning_output_tokens; agy fixture total_tokens ==
// input + output on every step while thinking_tokens > 0, so thinking is inside output and input
// excludes cache_read (2688 < 36754). claude input excludes cache_read_input_tokens; opencode's total
// == input + output + reasoning + cache.read (all exclusive). cline is provider-dependent and muse
// emits no usage: unknown keeps the pre-Q20 rule (input + output + reasoning).
const TOKEN_SEMANTICS = {
  codex: { inputIncludesCached: true, outputIncludesReasoning: true },
  agy: { inputIncludesCached: false, outputIncludesReasoning: true },
};
/** Metered tokens from raw per-CLI totals {input, output, cached, reasoning}. Shared by dispatch (new
 * nodes) and quota (read time, so old nodes' stored metered is never trusted). null when input or
 * output is; cached/reasoning null count as 0. */
export function meteredTokens(cli, tokens) {
  const { input = null, output = null, cached = null, reasoning = null } = tokens ?? {};
  if (number(input) === null || number(output) === null) return null;
  const s = Object.hasOwn(TOKEN_SEMANTICS, cli) ? TOKEN_SEMANTICS[cli] : {};
  return input - (s.inputIncludesCached ? (cached ?? 0) : 0) + output + (s.outputIncludesReasoning ? 0 : (reasoning ?? 0));
}
/** A tree node's metered tokens at READ time: recomputed from its raw fields + cli when it has
 * them (append-only nodes keep a pre-Q20 metered that over-counts codex); a node with no raw
 * input/output falls back to its stored metered; else null. */
export function nodeMetered(node) {
  const t = node?.tokens;
  const m = meteredTokens(node?.cli, t);
  if (m !== null) return m;
  return number(t?.input) === null && number(t?.output) === null ? number(t?.metered) : null;
}
const CAP = 50; // distinct dropped keys, and collected CLI error texts
const FINAL_TEXT_BYTES = 65536;

/** The node's final report, independent of the pane projection. Incomplete UTF-8 tails are omitted. */
export function limitFinalText(value) {
  const full = text(value);
  const finalTextTruncated = Buffer.byteLength(full, 'utf8') > FINAL_TEXT_BYTES;
  const finalText = finalTextTruncated
    ? new StringDecoder('utf8').write(Buffer.from(full, 'utf8').subarray(0, FINAL_TEXT_BYTES))
    : full;
  return { finalText, finalTextTruncated };
}

const cliError = (state, display, full = display) => {
  state.cliErrors ??= [];
  if (state.cliErrors.length < CAP) state.cliErrors.push(text(full));
  return [{ kind: 'warn', text: text(display) }];
};
const outcome = status => status === 'success' || status === 'completed' ? true : status === 'error' || status === 'failed' ? false : null;

// source: openai/codex codex-rs/exec/src/exec_events.rs, not captured — exit_code wins when
// numeric, otherwise in_progress/completed/failed/declined decide, and unknown stays unknown.
const codexOk = item => {
  if (typeof item?.exit_code === 'number') return item.exit_code === 0;
  if (item?.status === 'completed') return true;
  if (item?.status === 'failed' || item?.status === 'declined') return false;
  return null;
};

// source: exec_events.rs, not captured
const codexToolFields = item => {
  if (item.type === 'mcp_tool_call') return { tool: `${item.server}.${item.tool}`, detail: text(item.arguments) };
  if (item.type === 'web_search') return { tool: 'web_search', detail: text(item.query) };
  return { tool: `collab.${item.tool}`, detail: text(item.receiver_thread_ids) };
};

function codexItem(raw) {
  const item = raw.item;
  if (item?.type === 'error') return [{ kind: 'warn', text: text(item.message) }];
  if (item?.type === 'agent_message' && raw.type === 'item.completed') return [message(item.text)];
  // source: exec_events.rs, not captured — todo_list runs started → item.updated → completed;
  // every other item.updated falls through and stays dropped.
  if (item?.type === 'todo_list') {
    const entries = Array.isArray(item.items) ? item.items : [];
    const open = entries.find(entry => !entry?.completed);
    return [step(`todo ${entries.filter(entry => entry?.completed).length}/${entries.length}: ${open?.text ?? ''}`)];
  }
  // source: exec_events.rs, not captured — file_change is emitted only as item.completed.
  if (item?.type === 'file_change' && raw.type === 'item.completed') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return [{ kind: 'tool.end', tool: 'file_change',
      detail: changes.map(change => `${change?.kind} ${change?.path}`).join(', '), ok: codexOk(item) }];
  }
  // source: exec_events.rs, not captured — started/completed pairs; no item.updated in the lifecycle.
  if (item?.type === 'mcp_tool_call' || item?.type === 'web_search' || item?.type === 'collab_tool_call') {
    const fields = codexToolFields(item);
    if (raw.type === 'item.started') return [{ kind: 'tool.start', ...fields }];
    if (raw.type === 'item.completed') return [{ kind: 'tool.end', ...fields, ok: codexOk(item) }];
    return [];
  }
  if (item?.type !== 'command_execution') return [];
  const fields = { tool: 'command_execution', detail: text(item.command) };
  if (raw.type === 'item.started') return [{ kind: 'tool.start', ...fields }];
  if (raw.type === 'item.completed') return [{ kind: 'tool.end', ...fields, ok: codexOk(item) }];
  return [];
}

function agyStep(raw, state = {}) {
  const s = raw.step_update;
  if (s?.step_type === 'tool') {
    const fields = { tool: s.tool_name ?? s.tool_info?.name ?? 'unknown', detail: text(s.tool_info?.parameters) };
    if (s.state === 'ACTIVE') return [{ kind: 'tool.start', ...fields }];
    // DONE means finished, not successful: the capture supplies no success verdict.
    if (s.state === 'DONE') return [{ kind: 'tool.end', ...fields, ok: null }];
    return [];
  }
  if (s?.step_type === 'agent_response') {
    const events = [];
    if (typeof s.text_delta === 'string') events.push(message(s.text_delta));
    if (s.usage) { state.agyStepUsage = true; events.push(agyUsage(s.usage)); }
    return events;
  }
  return s?.step_type === 'user_input' ? [step('user_input')] : [];
}

// source: cline 3.0.70 `--json`, captured 2026-10-11 (tests/fixtures/cline). Tool names map onto the
// shared vocabulary so the witness sees cline's edits and test runs: run_commands is a shell tool,
// editor an edit tool.
const CLINE_TOOL = { run_commands: 'run_command', editor: 'edit' };
// Object.hasOwn: a CLI-controlled name like `constructor` must not reach the prototype.
const clineTool = name => (Object.hasOwn(CLINE_TOOL, name) ? CLINE_TOOL[name] : text(name)) || 'unknown';
const clineDetail = input => {
  if (Array.isArray(input?.commands)) return input.commands.map(c => typeof c === 'string' ? c : c?.command ?? text(c)).join('\n');
  if (Array.isArray(input?.files)) return input.files.map(f => f?.path ?? text(f)).join(', ');
  return typeof input?.path === 'string' ? input.path : text(input);
};
// content_end carries the output, not the input: the detail is remembered by toolCallId (bounded).
const clineStart = (raw, state) => {
  const e = raw.event;
  if (e.contentType === 'text') return typeof e.text === 'string' ? [message(e.text)] : [];
  // Thinking deltas are the model's scratchpad, not a result: handled, never shown.
  if (e.contentType === 'reasoning') return IGNORED;
  if (e.contentType !== 'tool') return [];
  const fields = { tool: clineTool(e.toolName), detail: clineDetail(e.input) };
  state.clineCalls ??= new Map();
  if (state.clineCalls.size >= CAP) state.clineCalls.delete(state.clineCalls.keys().next().value);
  state.clineCalls.set(e.toolCallId, fields.detail);
  return [{ kind: 'tool.start', ...fields }];
};
const clineEnd = (raw, state) => {
  const e = raw.event;
  // content_end text is the complete assistant text the deltas already streamed.
  if (e.contentType === 'text') return typeof e.text === 'string' ? [message(e.text)] : [];
  if (e.contentType === 'reasoning') return IGNORED;
  if (e.contentType !== 'tool') return [];
  const outputs = [].concat(e.output ?? []);
  const ok = outputs.length === 0 ? null : outputs.every(o => o?.success !== false);
  const detail = state.clineCalls?.get(e.toolCallId) ?? '';
  state.clineCalls?.delete(e.toolCallId);
  return [{ kind: 'tool.end', tool: clineTool(e.toolName), detail, ok }];
};
// Handled on purpose and emitting nothing: this exact array is not counted as dropped.
const IGNORED = Object.freeze([]);
const ignore = () => IGNORED;

// Claude Code `--output-format stream-json --verbose` (claude --help, this Mac, 2026-10-17):
// system/init, assistant content blocks, user tool_result blocks, result. Shapes hand-written
// from the documented format (tests/orchestra-events-claude.test.ts), never captured live.
// tool_use/tool_result pair like cline's content_start/content_end: the start remembers name and
// input by tool_use id (bounded); the end is their verdict, ok = !is_error.
const claudeSystem = raw => raw?.subtype === 'init' ? [step(`init ${text(raw.model)}`)] : [];
const claudeAssistant = (raw, state) => {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const block of content) {
    if (block?.type === 'text') events.push(message(block.text));
    else if (block?.type === 'tool_use') {
      const fields = { tool: text(block.name) || 'unknown', detail: text(block.input) };
      state.claudeCalls ??= new Map();
      if (state.claudeCalls.size >= CAP) state.claudeCalls.delete(state.claudeCalls.keys().next().value);
      state.claudeCalls.set(block.id, fields);
      events.push({ kind: 'tool.start', ...fields });
    }
  }
  return events;
};
const claudeUser = (raw, state) => {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const remembered = state.claudeCalls?.get(block.tool_use_id);
    state.claudeCalls?.delete(block.tool_use_id);
    events.push({ kind: 'tool.end', tool: remembered?.tool ?? 'unknown', detail: remembered?.detail ?? '', ok: block.is_error !== true });
  }
  return events;
};
const claudeResult = (raw, state) => {
  const events = [];
  // An is_error result is the CLI reporting failure: its text is evidence, never the final answer.
  if (raw?.is_error === true) events.push(...cliError(state, `claude result ${text(raw.subtype)}: ${text(raw.result)}`, raw));
  else if (typeof raw?.result === 'string') events.push(message(raw.result));
  if (raw?.usage) events.push(usage(raw.usage.input_tokens, raw.usage.output_tokens, raw.usage.cache_read_input_tokens, null));
  return events;
};

// Captured CLI event names are data; unknown types are counted rather than guessed.
const mappings = {
  codex: {
    'thread.started': () => [step('thread.started')],
    'turn.started': () => [step('turn.started')],
    'item.started': codexItem,
    'item.completed': codexItem,
    // source: exec_events.rs, not captured — reaches the table for todo_list only; codexItem
    // drops every other item type, so non-todo updates stay counted as dropped.
    'item.updated': codexItem,
    'turn.completed': raw => [codexUsage(raw.usage)],
    // source: exec_events.rs, not captured. CLI-emitted failures; item.type "error" is a warning
    // the CLI attaches to a turn (3 on a successful capture) and is NOT collected.
    'turn.failed': (raw, state) => cliError(state, raw.error?.message),
    // unverified: not observed in a capture
    error: (raw, state) => cliError(state, raw.message),
  },
  opencode: {
    step_start: () => [step('step_start')],
    tool_use: raw => [{ kind: 'tool.end', tool: raw.part?.tool ?? 'unknown',
      detail: text(raw.part?.state?.input), ok: outcome(raw.part?.state?.status) }],
    step_finish: raw => {
      const t = raw.part?.tokens;
      return [usage(t?.input, t?.output, t?.cache?.read, t?.reasoning)];
    },
    text: raw => [message(raw.part?.text)],
    // source: opencode 1.18.34 run emitter (installed binary), not captured — session.error and a
    // failed prompt call write {type:"error",timestamp,sessionID,error} to stdout only, then exit 1.
    // It prints error.data.message ?? error.name itself; the whole object is kept as evidence.
    error: (raw, state) => cliError(state, raw.error?.data?.message ?? raw.error?.message ?? raw.error?.name ?? raw.error, raw.error),
  },
  agy: {
    init: () => [step('init')],
    step_update: agyStep,
    result: (raw, state) => {
      const events = [];
      // unverified: only a SUCCESS result was captured. response is model text, so it is excluded.
      if (raw.result?.status !== 'SUCCESS') {
        const { response, usage: _usage, ...rest } = raw.result ?? {};
        events.push(...cliError(state, `agy result ${text(raw.result?.status)}: ${text(rest)}`));
      }
      if (typeof raw.result?.response === 'string') events.push(message(raw.result.response));
      // result.usage is the run TOTAL of the step usages (fixture: 43768 = 38807 + 2688 + 2273);
      // emitting both double-counts every token. Only a run with no step usage reports it.
      if (raw.result?.usage && !state.agyStepUsage) events.push(agyUsage(raw.result.usage));
      return events;
    },
  },
  muse: {
    'run.lifecycle.started': () => [step('run.lifecycle.started')],
    'tool.result': raw => [{ kind: 'tool.end',
      tool: raw.payload?.edit_facts?.tool_name ?? raw.payload?.correlation_facts?.tool_name ?? 'unknown',
      detail: text(raw.payload?.edit_facts?.path ?? raw.payload?.text),
      ok: outcome(raw.payload?.correlation_facts?.outcome) }],
    'run.output.delta': raw => [message(raw.payload?.text)],
    'run.terminal.completed': raw => [message(raw.payload?.text)],
  },
  // Keyed `agent_event.<event.type>` for agent events, the top-level type otherwise.
  cline: {
    'agent_event.iteration_start': raw => [step(`iteration ${text(raw.event?.iteration)}`)],
    'agent_event.content_start': clineStart,
    'agent_event.content_end': clineEnd,
    // Per model call, so the per-call fields sum to the run; done/run_result carry the same totals
    // again and are not counted.
    'agent_event.usage': raw => [usage(raw.event?.inputTokens, raw.event?.outputTokens, raw.event?.cacheReadTokens, null)],
    'agent_event.error': (raw, state) => cliError(state, raw.event?.error?.message ?? raw.event?.error),
    'agent_event.iteration_end': ignore,
    'agent_event.done': ignore,
    hook_event: ignore,
    run_result: ignore,
    // Measured 2026-10-11 (r2-tabularium, exit 1): cline writes fatal errors as
    // top-level {"ts","type":"error","message"} lines, never as agent events — usually to
    // STDERR but occasionally to stdout, so this stays a CLI error event on either stream.
    // The whole object is kept as evidence, like opencode's error, so the reset phrase
    // survives in it.
    error: (raw, state) => cliError(state, raw.message, raw),
  },
  // Claude Code stream-json: top-level type. Unknown types (and non-init system subtypes,
  // assistant/user lines without a content array) fall through and are counted as dropped.
  claude: {
    system: claudeSystem,
    assistant: claudeAssistant,
    user: claudeUser,
    result: claudeResult,
  },
};
// unverified: only run.terminal.completed was captured. payload.text is model text, so only the
// terminal name and reason are taken.
const museTerminal = (raw, state) => cliError(state, `${raw.payload_type}: ${text(raw.payload?.reason)}`);


/** Pure projection. Envelope, sequence and receipt clock belong to the dispatcher. */
export function normalize(cli, rawLine, state = {}) {
  const unparsed = () => [{ kind: 'unparsed', line: String(rawLine).slice(0, 500) }];
  try {
    const raw = JSON.parse(rawLine);
    if (!Object.hasOwn(mappings, cli) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return unparsed();
    const type = cli === 'muse' ? raw.payload_type : cli === 'agy' ? raw.event
      : cli === 'cline' && raw.type === 'agent_event' ? `agent_event.${text(raw.event?.type)}` : raw.type;
    const table = mappings[cli];
    const handler = Object.hasOwn(table, type) ? table[type]
      : cli === 'muse' && typeof type === 'string' && type.startsWith('run.terminal.') ? museTerminal : null;
    const events = handler ? handler(raw, state) : [];
    if (events.length === 0 && events !== IGNORED) {
      state.dropped ??= Object.create(null);
      let key = typeof type === 'string' ? type : 'unknown';
      // The keys are CLI-controlled: bound them.
      if (!Object.hasOwn(state.dropped, key) && Object.keys(state.dropped).length >= CAP) key = '__other__';
      Object.defineProperty(state.dropped, key, { value: (Object.hasOwn(state.dropped, key) ? state.dropped[key] : 0) + 1, enumerable: true, configurable: true, writable: true });
    }
    return events.map(event => {
      if (event.kind === 'message') Object.assign(state, limitFinalText(event.text));
      for (const key of ['detail', 'text', 'line']) if (key in event) event[key] = text(event[key]).slice(0, 500);
      return event;
    });
  } catch { return unparsed(); }
}

/** The CLI's own error events as written to STDERR, for the provider-stop verdict. A stream
 * is transport, not authorship, so this reuses normalize(): only JSON lines an error handler
 * claims are collected. Pretty stderr text is never collected — model transcripts render
 * there too, so it cannot carry a verdict (PS1 P1). */
export function stderrCliErrors(cli, stderr) {
  const state = {};
  for (const line of String(stderr ?? '').split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    normalize(cli, line, state);
  }
  return state.cliErrors ?? [];
}

/** Retains CR and empty lines verbatim; decodes UTF-8 even across byte boundaries. */
export function createLineSplitter() {
  const decoder = new StringDecoder('utf8');
  // Only the new chunk is scanned; the pending partial line is kept as parts, joined once.
  let parts = [];
  const consume = value => {
    const lines = [];
    let start = 0;
    for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', start)) {
      parts.push(value.slice(start, at));
      lines.push(parts.join(''));
      parts = [];
      start = at + 1;
    }
    if (start < value.length) parts.push(value.slice(start));
    return lines;
  };
  return {
    push(chunk) { return consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)); },
    end() {
      const lines = consume(decoder.end());
      const tail = parts.join('');
      if (tail) lines.push(tail);
      parts = [];
      return lines;
    },
  };
}
