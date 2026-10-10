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
const CAP = 50; // distinct dropped keys, and collected CLI error texts
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
    const type = cli === 'muse' ? raw.payload_type : cli === 'agy' ? raw.event : raw.type;
    const table = mappings[cli];
    const handler = Object.hasOwn(table, type) ? table[type]
      : cli === 'muse' && typeof type === 'string' && type.startsWith('run.terminal.') ? museTerminal : null;
    const events = handler ? handler(raw, state) : [];
    if (events.length === 0) {
      state.dropped ??= Object.create(null);
      let key = typeof type === 'string' ? type : 'unknown';
      // The keys are CLI-controlled: bound them.
      if (!Object.hasOwn(state.dropped, key) && Object.keys(state.dropped).length >= CAP) key = '__other__';
      Object.defineProperty(state.dropped, key, { value: (Object.hasOwn(state.dropped, key) ? state.dropped[key] : 0) + 1, enumerable: true, configurable: true, writable: true });
    }
    return events.map(event => {
      for (const key of ['detail', 'text', 'line']) if (key in event) event[key] = text(event[key]).slice(0, 500);
      return event;
    });
  } catch { return unparsed(); }
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
