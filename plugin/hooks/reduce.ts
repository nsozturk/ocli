// Pure: live-file text -> events -> runs. No `$`. Every string from a live file is untrusted CLI
// output, so it is cleaned here, at ingest: nothing downstream (pane, toast, notify, status) can
// carry a terminal escape.
import type { Checkpoint, OcliRun, OcliStatus } from '../types'

export type { Checkpoint } from '../types'

/** One contract line, known fields only, strings cleaned. */
export type OcliEvent = {
  runId: string
  seq: number
  at: number | null
  task: string
  role: string
  cli: string
  kind: string
  model?: string
  title?: string
  root?: string
  phase?: string
  prefixSha?: string
  label?: string
  tool?: string
  detail?: string
  ok?: boolean | null
  text?: string
  input?: number | null
  output?: number | null
  cached?: number | null
  status?: OcliStatus
  exitCode?: number | null
  ms?: number | null
  score?: number | null
  dropped?: number
  /** run.end's witness finding codes (`witness.findings`), cleaned; absent when it carried none. */
  witness?: string[]
}

const STALE_MS = 10 * 60_000
const PREFIX_SHA = /^[0-9a-f]{12}$/
const STATUSES: readonly OcliStatus[] = ['running', 'completed', 'failed', 'blocked', 'spawn-error', 'dispatch-error']

// ESC/CSI sequences (7- and 8-bit), OSC strings, then two-byte ESC sequences; then any C0/C1/DEL left.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|[\u001b\u009d]\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|\u001b[ -~]?/g
// C0/C1, the bidi controls (U+061C, U+200E/F, U+202A-202E, U+2066-2069), which can visually reorder a
// line, and the invisible U+200B/U+2060. ZWNJ/ZWJ (U+200C/D) stay: scripts and emoji join with them,
// and they reorder nothing.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069]/g

/** Strips escapes and control characters, folds whitespace, caps the length. */
export function clean(value: unknown, max = 300): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(ESCAPES, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim()
  return [...text].slice(0, max).join('')
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const time = (value: unknown): number | null => (typeof value === 'string' ? num(Date.parse(value)) : null)
const status = (value: unknown): OcliStatus => (STATUSES as readonly unknown[]).includes(value) ? (value as OcliStatus) : 'failed'

/** Total of `run.end.dropped`, whose keys are CLI-controlled: only its values are read. */
function droppedTotal(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  return Object.values(value).reduce<number>((sum, n) => sum + (num(n) ?? 0), 0)
}

function toEvent(raw: unknown): OcliEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const runId = clean(r.runId, 128)
  if (r.v !== 1 || !runId || !Number.isInteger(r.seq) || (r.seq as number) < 0 || typeof r.kind !== 'string') return null
  const event: OcliEvent = {
    runId, seq: r.seq as number, at: time(r.at), task: clean(r.task, 120), role: clean(r.role, 40), cli: clean(r.cli, 40), kind: clean(r.kind, 40),
  }
  switch (event.kind) {
    case 'run.start':
      event.model = clean(r.model, 80); event.title = clean(r.title, 120); event.root = clean(r.root, 300); event.phase = clean(r.phase, 40)
      // Exactly the dispatcher's shape or nothing: never cleaned into something that looks like one.
      if (typeof r.prefixSha === 'string' && PREFIX_SHA.test(r.prefixSha)) event.prefixSha = r.prefixSha
      break
    case 'step': event.label = clean(r.label); break
    case 'tool.start':
    case 'tool.end': event.tool = clean(r.tool, 80); event.detail = clean(r.detail); event.ok = typeof r.ok === 'boolean' ? r.ok : null; break
    case 'message':
    case 'warn': event.text = clean(r.text); break
    case 'unparsed': event.text = clean(r.line); break
    case 'usage': event.input = num(r.input); event.output = num(r.output); event.cached = num(r.cached); break
    case 'run.end':
      event.status = status(r.status); event.exitCode = num(r.exitCode); event.ms = num(r.ms)
      event.score = num(r.score); event.dropped = droppedTotal(r.dropped)
      {
        const findings = r.witness && typeof r.witness === 'object' ? (r.witness as { findings?: unknown }).findings : undefined
        if (Array.isArray(findings)) {
          event.witness = findings.filter((x): x is string => typeof x === 'string').map(x => clean(x, 40)).filter(Boolean).slice(0, 10)
        }
      }
      break
  }
  return event
}

/** Complete lines only: an unparsable line (the torn last one of a file being written) is skipped. */
export function parseLines(text: string): OcliEvent[] {
  const events: OcliEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const event = toEvent(raw)
    if (event) events.push(event)
  }
  return events
}

const MAX_PHASES = 50

/** A task's declared phases from its plan.json, as `dispatch.mjs --declare-phases` writes it. null
 * unless it is `{v: 1, phases: [...]}` naming at least one phase (dispatch refuses an empty plan);
 * names cleaned like a run's phase, emptied ones dropped. */
export function foldPlan(text: string): string[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Array.isArray(r.phases)) return null
  const names = r.phases.map(p => (p && typeof p === 'object' ? clean((p as { name?: unknown }).name, 40) : ''))
  const phases = [...new Set(names.filter(Boolean))].slice(0, MAX_PHASES)
  return phases.length ? phases : null
}

export const add = (a: number | null, b: number | null | undefined): number | null => (b == null ? a : a == null ? b : a + b)

function summary(e: OcliEvent): string | null {
  switch (e.kind) {
    case 'run.start': return `start ${e.model ?? ''}`.trim()
    case 'step': return `step: ${e.label}`
    case 'tool.start':
    case 'tool.end': return `${e.kind} ${e.tool}: ${e.detail}${e.ok === false ? ' (failed)' : ''}`
    case 'message':
    case 'warn':
    case 'unparsed': return `${e.kind}: ${e.text}`
    case 'run.end': return `end ${e.status} exit ${e.exitCode ?? '?'}`
    default: return null // usage and unknown kinds leave the summary as it was
  }
}

const blank = (e: OcliEvent): OcliRun => ({
  runId: e.runId, task: e.task, role: e.role, cli: e.cli, model: null, title: '', where: '', phase: '', status: 'running',
  startedAt: null, endedAt: null, lastAt: null, lastSummary: '', toolCount: 0, warnCount: 0,
  tokens: { input: null, output: null }, exitCode: null, score: null, ms: null, dropped: 0, lastSeq: -1,
})

const MAX_BEATS = 200
const LOOP_AT = 8

/** What a tool call is, for the repeat streak: the tool and its whole detail (capped at ingest). A
 * prefix would merge different commands under one long wrapper or worktree path. */
const sigOf = (e: OcliEvent): string => `${e.tool ?? ''}: ${e.detail ?? ''}`

type Streak = NonNullable<OcliRun['streak']>
/** One more call of `sig`. After a success the same command starts over: only a run of failures since then is a loop. */
const repeat = (streak: Streak | undefined, sig: string): Streak =>
  streak?.sig === sig && !streak.okSince ? { ...streak, n: streak.n + 1 } : { sig, n: 1, okSince: false }

/** A run's identity: its live file, `<task>/<runId>.jsonl`. Neither part can hold a `/`. */
export const runKey = (run: { task: string; runId: string }): string => `${run.task}/${run.runId}`

/** Folds events into runs. Idempotent: an event whose seq a run already holds is skipped. */
export function reduce(runs: readonly OcliRun[], events: readonly OcliEvent[]): OcliRun[] {
  const byId = new Map(runs.map(run => [runKey(run), run] as const))
  for (const e of events) {
    const prev = byId.get(runKey(e)) ?? blank(e)
    if (e.seq <= prev.lastSeq) continue
    const run: OcliRun = { ...prev, tokens: { ...prev.tokens }, lastSeq: e.seq }
    if (e.at !== null) {
      run.lastAt = Math.max(run.lastAt ?? e.at, e.at)
      run.beats = [...(prev.beats ?? []), e.at].slice(-MAX_BEATS)
    }
    run.lastSummary = summary(e) ?? run.lastSummary
    if (e.kind === 'run.start') {
      run.model = e.model || null
      run.title = e.title ?? ''
      run.where = (e.root ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
      run.phase = e.phase ?? ''
      if (e.prefixSha) run.prefixSha = e.prefixSha
      run.startedAt = e.at
    } else if (e.kind === 'tool.start') {
      run.streak = { ...repeat(prev.streak, sigOf(e)), open: true }
    } else if (e.kind === 'tool.end') {
      run.toolCount += 1
      const sig = sigOf(e)
      // The end of the call a start opened closes it; the end of another call meanwhile leaves the
      // open one be. With none open (opencode and muse emit no tool.start) the end is itself the call.
      if (!prev.streak?.open) {
        const call = repeat(prev.streak, sig)
        run.streak = { ...call, okSince: e.ok === true, open: false }
      } else if (prev.streak.sig === sig) run.streak = { ...prev.streak, okSince: e.ok === true, open: false }
    } else if (e.kind === 'warn') run.warnCount += 1
    else if (e.kind === 'usage') {
      // A run whose input was summed before cached counts were read keeps cached unknown: a sum over
      // only the later events next to the whole input would draw a confidently wrong ratio.
      const isOld = prev.tokens.input != null && prev.tokens.cached === undefined
      run.tokens = { input: add(run.tokens.input, e.input), output: add(run.tokens.output, e.output), ...(isOld ? {} : { cached: add(run.tokens.cached ?? null, e.cached) }) }
    }
    else if (e.kind === 'run.end') {
      Object.assign(run, { status: e.status, endedAt: e.at, exitCode: e.exitCode, ms: e.ms, score: e.score, dropped: e.dropped })
      if (e.witness) run.witness = e.witness
      // An ended run draws no sparkline: what only the live row reads leaves $.state with it.
      delete run.beats
      delete run.streak
    }
    byId.set(runKey(e), run)
  }
  return [...byId.values()]
}

export const isEnded = (s: OcliStatus): boolean => s !== 'running'

/** Eight identical calls with no successful matching tool.end since: a CLI burning quota on
 * one failing command. A run folded by an older version has no streak and is not looping. */
export const isLooping = (run: OcliRun): boolean => (run.streak?.n ?? 0) >= LOOP_AT && !run.streak!.okSince

const BARS = ' ▁▂▃▄▅▆▇█'

/** Events per `binMs` bin over the last `cells` bins, oldest left, each as a bar relative to the
 * busiest bin (an empty bin a space); no event in the window at all is a flat line. A bin's older
 * edge belongs to it: an event exactly `binMs` ago is in the second-newest. Events dated after
 * `now` are not counted. */
export function sparkline(beats: readonly number[], now: number, cells = 10, binMs = 30_000): string {
  const counts = new Array<number>(cells).fill(0)
  for (const at of beats) {
    const back = Math.floor((now - at) / binMs)
    if (at <= now && back < cells) counts[cells - 1 - back]! += 1
  }
  const max = Math.max(...counts)
  return max ? counts.map(n => BARS[Math.ceil((n / max) * 8)]).join('') : '▁'.repeat(cells)
}

/** The live line of a running run: its sparkline, its last summary and `×n` once that call has
 * repeated three times; the count is kept when the summary is cut. */
function liveLine(run: OcliRun, now: number, columns: number): string {
  const s = run.streak
  // Only on the repeated call's own row, and not once it succeeded.
  const isOwn = !!s && !s.okSince && [`tool.start ${s.sig}`, `tool.end ${s.sig}`, `tool.end ${s.sig} (failed)`].includes(run.lastSummary)
  const repeats = isOwn && s.n >= 3 ? ` ×${s.n}` : ''
  return fit(`  ${sparkline(run.beats ?? [], now)} ↳ ${run.lastSummary}`, columns - cells(repeats)) + repeats
}

/** `stale` is never stored: a running run whose last event is older than 10 minutes, as of `now`. */
export function displayStatus(run: OcliRun, now: number): OcliStatus | 'stale' {
  const last = run.lastAt ?? run.startedAt
  return run.status === 'running' && last !== null && now - last > STALE_MS ? 'stale' : run.status
}

const GLYPH: Record<OcliStatus | 'stale', string> = {
  running: '●', stale: '◌', completed: '✓', blocked: '⊘', failed: '✗', 'spawn-error': '✗', 'dispatch-error': '✗',
}

export function duration(ms: number | null): string {
  if (ms === null || ms < 0) return '?'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

export const count = (n: number | null): string => (n === null ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// ponytail: emoji and East Asian wide ranges take two cells, the rest one; overcounting only cuts early.
const WIDE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u
const cellsOf = (ch: string): number => (WIDE.test(ch) ? 2 : 1)
/** Terminal cells the text takes. */
export const cells = (text: string): number => [...text].reduce((n, ch) => n + cellsOf(ch), 0)

/** Cuts to `columns` terminal cells, an ellipsis marking the cut. */
export const fit = (text: string, columns: number): string => {
  if (cells(text) <= columns) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    if (used + cellsOf(ch) > columns - 1) break
    out += ch
    used += cellsOf(ch)
  }
  return out + '…'
}

/** The model's last path segment, e.g. `glm-5.3`. */
const shortModel = (run: OcliRun): string => (run.model ?? '?').split('/').pop() || '?'
/** The LLM that has the run: the short model and the CLI, e.g. `glm-5.3 (opencode)`. */
const llm = (run: OcliRun): string => `${shortModel(run)} (${run.cli})`

/** A run's first line: glyph, status word unless running/completed, the LLM, elapsed, tools, tokens, role. */
export function runLine(run: OcliRun, now: number, columns: number): string {
  const shown = displayStatus(run, now)
  const word = shown === 'running' || shown === 'completed' ? '' : ` ${shown}`
  const elapsed = isEnded(run.status)
    ? (run.ms ?? (run.endedAt !== null && run.startedAt !== null ? run.endedAt - run.startedAt : null))
    : run.startedAt === null ? null : now - run.startedAt
  const parts = [
    `${GLYPH[shown]}${word}`, llm(run), duration(elapsed), `${run.toolCount}t`,
    `${count(run.tokens.input)}/${count(run.tokens.output)}`, `· ${run.role}`,
  ]
  return fit(parts.join(' '), columns)
}

/** All of a run's lines: the head, then what it is for and where it works, then its latest event.
 * A run folded by an older version has no title/where ($.state outlives a reload): those read as ''. */
export function runLines(run: OcliRun, now: number, columns: number): string[] {
  const lines = [runLine(run, now, columns)]
  const what = [run.title ?? '', run.where ?? ''].filter(Boolean).join(' · ')
  if (what) lines.push(fit(`  ${what}`, columns))
  if (run.lastSummary) lines.push(isEnded(run.status) ? fit(`  ↳ ${run.lastSummary}`, columns) : liveLine(run, now, columns))
  // Last, so the card can colour it: claims its own trace does not back (orchestra/witness.mjs).
  if (run.witness?.length) lines.push(fit(`  ⚠ unwitnessed: ${run.witness.join(', ')}`, columns))
  return lines
}

// --- cards: one per task, modelled on Claude Code's Workflow card ------------------------------

export type Shown = OcliStatus | 'stale'
export type TaskStatus = 'Running' | 'Blocked' | 'Failed' | 'Stale' | 'Completed'

/** The one colour map: a run's head, its dot and (through TASK_COLOR) a card's border. */
export const colorOf = (shown: Shown): string =>
  shown === 'running' ? 'suggestion' : shown === 'completed' ? 'success' : shown === 'blocked' || shown === 'stale' ? 'warning' : 'error'

export const TASK_COLOR: Record<TaskStatus, string> = {
  Running: 'suggestion', Completed: 'success', Blocked: 'warning', Stale: 'warning', Failed: 'error',
}

/** A run's card phase; a run folded before phases existed (or with none) is grouped by its role. */
export const phaseOf = (run: OcliRun): string => run.phase || run.role

const FAILED: readonly Shown[] = ['failed', 'spawn-error', 'dispatch-error']

/** Any running, else any blocked, else any failed-like, else all stale, else completed. */
export function taskStatus(runs: readonly OcliRun[], now: number): TaskStatus {
  const shown = runs.map(run => displayStatus(run, now))
  if (shown.includes('running')) return 'Running'
  if (shown.includes('blocked')) return 'Blocked'
  if (shown.some(s => FAILED.includes(s))) return 'Failed'
  if (shown.length > 0 && shown.every(s => s === 'stale')) return 'Stale'
  return 'Completed'
}

const startOf = (run: OcliRun): number | null => run.startedAt ?? run.lastAt
const byStart = (a: OcliRun, b: OcliRun) => (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity) || 0

/** Runs grouped by phase: the declared phases first, in declared order (with no runs, an empty
 * list), then the rest in first-seen order; runs by start within each. */
export function phasesOf(runs: readonly OcliRun[], declared: readonly string[] = []): [string, OcliRun[]][] {
  const phases = new Map<string, OcliRun[]>(declared.map(name => [name, []]))
  for (const run of [...runs].sort(byStart)) {
    const list = phases.get(phaseOf(run))
    if (list) list.push(run)
    else phases.set(phaseOf(run), [run])
  }
  return [...phases]
}

/** input + output over every run; null only while no run reported any. */
export const tokensOf = (runs: readonly OcliRun[]): number | null =>
  runs.reduce<number | null>((sum, run) => add(add(sum, run.tokens.input), run.tokens.output), null)

/** Earliest start to latest end, or to `now` while any run is running. A loop, not a spread: runs
 * in $.state are not capped, and a spread of ~200k arguments overflows the stack. */
export function taskSpan(runs: readonly OcliRun[], now: number): number | null {
  let first = Infinity
  let last = -Infinity
  let isRunning = false
  for (const run of runs) {
    first = Math.min(first, startOf(run) ?? Infinity)
    last = Math.max(last, run.endedAt ?? run.lastAt ?? -Infinity)
    isRunning ||= displayStatus(run, now) === 'running'
  }
  if (first === Infinity) return null
  return (isRunning ? now : last) - first
}

/** The newest event over runs, 0 when none has a time: the order of the cards. */
export const latestAt = (runs: readonly OcliRun[]): number => runs.reduce((max, run) => Math.max(max, run.lastAt ?? 0), 0)

export type Row =
  | { kind: 'text'; key: string; text: string; color?: string; isDim?: boolean; isBold?: boolean }
  /** Left filled with spaces to the width, so `right` sits at the right edge on every surface. */
  | { kind: 'split'; key: string; left: string; right: string; isBold?: boolean }
  /** A phase: `prefix` (chevron, name), one dot colour per run, `tail` (LLMs, fill), `right` (done/total). */
  /** A pressable: the pane's render hook knows what its key does. */
  | { kind: 'button'; key: string; label: string }
  | { kind: 'phase'; key: string; open: string; isOpen: boolean; prefix: string; dots: string[]; tail: string; right: string; isPending?: boolean }
/** `height` is what the card costs in rows: its rows and the two of its border. */
export type Card = { key: string; color?: string; rows: Row[]; height: number }

const width = cells
const fill = (text: string, columns: number) => text + ' '.repeat(Math.max(0, columns - width(text)))

/** A phase is done once it has a run and none of its runs is running or stale. */
// ponytail: CLIs whose `cached` is part of `input` (codex's cached_input_tokens); opencode's cache.read
// and agy's cache_read_tokens come on top of it. A new CLI with subset semantics belongs here.
const CACHED_IN_INPUT = new Set(['codex'])

/** ` cache N%`: cache reads over all input read, for the phase's runs that report both; '' when none
 * does (unknown is never 0%). */
function cacheNote(list: readonly OcliRun[]): string {
  let cached: number | null = null
  let read = 0
  for (const run of list) {
    const { input, cached: hit } = run.tokens
    if (input == null || hit == null) continue
    cached = add(cached, hit)
    read += CACHED_IN_INPUT.has(run.cli) ? input : input + hit
  }
  return cached === null || read <= 0 ? '' : ` cache ${Math.round((cached / read) * 100)}%`
}

/** ` ⚠prefix×K`: K > 1 distinct --prompt fingerprints among the phase's runs on one cli. */
function prefixNote(list: readonly OcliRun[]): string {
  const byCli = new Map<string, Set<string>>()
  for (const run of list) if (run.prefixSha) byCli.set(run.cli, (byCli.get(run.cli) ?? new Set()).add(run.prefixSha))
  const k = Math.max(0, ...[...byCli.values()].map(set => set.size))
  return k > 1 ? ` ⚠prefix×${k}` : ''
}

const isPhaseDone = (list: readonly OcliRun[], now: number): boolean =>
  list.length > 0 && list.every(run => !['running', 'stale'].includes(displayStatus(run, now)))

/** Rows a task card takes in its header form, its shortest: the other forms add a Phases row and a
 * row per phase (a card has a phase: it exists for a run or a non-empty plan). */
export const HEADER_HEIGHT = 6

/** One task's card, `columns` wide inside its border. `isOpen` says which `<task>/<phase>` rows are
 * expanded; `isHeader` draws the header form, for a card too tall even with every phase closed.
 * `declared` is the task's plan: those phases are drawn first, a pending row for any not yet run. */
export function card(task: string, runs: readonly OcliRun[], now: number, columns: number, isOpen: (key: string) => boolean, isHeader = false, declared: readonly string[] = []): Card {
  // A plan with no run yet is not "Completed" (what taskStatus says of no runs): it is neutral.
  const status = runs.length ? taskStatus(runs, now) : 'Declared'
  const color = runs.length ? TASK_COLOR[status as TaskStatus] : undefined
  const span = duration(taskSpan(runs, now))
  const tokens = tokensOf(runs)
  const recent = [...runs].filter(run => run.title).sort((a, b) => (b.lastAt ?? startOf(b) ?? 0) - (a.lastAt ?? startOf(a) ?? 0))[0]
  const phases = phasesOf(runs, declared)
  const done = `${phases.filter(([, list]) => isPhaseDone(list, now)).length}/${phases.length} phases`
  const tally = `${runs.length} run${runs.length === 1 ? '' : 's'} · ${count(tokens)} tokens`
  // The progress is why a plan exists: when the whole row does not fit, it leads, so it is never the part cut.
  const countRow = !declared.length ? tally : cells(`${tally} · ${done}`) <= columns ? `${tally} · ${done}` : `${done} · ${tally}`
  const rows: Row[] = [
    { kind: 'split', key: `head:${task}`, left: fill(fit(task, columns - width(span) - 1), columns - width(span)), right: span, isBold: true },
    { kind: 'text', key: 'status', text: `ocli · ${status}`, color, isDim: !runs.length },
    { kind: 'text', key: 'count', text: fit(countRow, columns), isDim: true },
  ]
  if (isHeader) {
    // HEADER_HEIGHT counts these four rows and the border.
    const note = `${phases.length} phase${phases.length === 1 ? '' : 's'} · pane too short to list them`
    rows.push({ kind: 'text', key: 'short', text: fit(note, columns), isDim: true })
    return { key: `task:${task}`, color, rows, height: rows.length + 2 }
  }
  if (recent) rows.push({ kind: 'text', key: 'what', text: fit(recent.title, columns), isDim: true })
  rows.push({ kind: 'text', key: 'phases', text: 'Phases', isBold: true })
  for (const [phase, list] of phases) {
    const open = `${task}/${phase}`
    const isOpenNow = isOpen(open)
    const shown = list.map(run => displayStatus(run, now))
    const right = `${list.filter(run => isEnded(run.status)).length}/${list.length}`
    const room = columns - width(right) - 1
    // A declared phase with no run yet says so where the LLM names would be.
    const note = list.length ? ` ${[...new Set(list.map(shortModel))].join(', ')}` : ' declared'
    // The name gives way to the dots and the LLM names, down to a third of the row.
    const nameRoom = Math.max(Math.ceil(room / 3), room - list.length - width(note) - 1)
    const prefix = `${fit(`${isOpenNow ? '▾' : '▸'} ${phase}`, Math.max(1, Math.min(room - 2, nameRoom)))} `
    // ponytail: a phase with more runs than room shows its newest dots and `+K` for the rest;
    // done/total still counts all.
    const dotRoom = Math.max(0, room - width(prefix))
    const keep = list.length <= dotRoom ? list.length : Math.max(0, dotRoom - 2 - String(list.length).length)
    const more = keep < list.length ? ` +${list.length - keep}` : ''
    const unwitnessed = list.filter(run => run.witness?.length).length
    const warn = unwitnessed ? ` ⚠${unwitnessed}` : ''
    const dots = shown.slice(list.length - keep).map(colorOf)
    // A prefix marker that does not fit whole is dropped, never cut into a misleading `⚠pre`.
    const drift = prefixNote(list)
    const marks = warn + (width(drift) <= room - width(prefix) - dots.length - width(more) - width(warn) ? drift : '')
    // The cache ratio leads the LLM names and is cut with them; a ratio that does not fit whole is dropped.
    const cache = cacheNote(list)
    const tailRoom = room - width(prefix) - dots.length - width(more) - width(marks)
    const names = width(cache) < tailRoom ? cache + note : note
    const tail = fill(more + marks + (tailRoom > 1 ? fit(names, tailRoom) : ''), columns - width(right) - width(prefix) - dots.length)
    rows.push({ kind: 'phase', key: `phase:${open}`, open, isOpen: isOpenNow, prefix, dots, tail, right, ...(list.length ? {} : { isPending: true }) })
    list.forEach((run, i) => {
      if (isOpenNow) {
        const lines = runLines(run, now, columns - 2)
        const warnAt = run.witness?.length ? lines.length - 1 : -1
        // runLines' ↳ line follows the head and, when there is one, the title/where line.
        const loopAt = isLooping(run) && !isEnded(run.status) && run.lastSummary ? (run.title || run.where ? 2 : 1) : -1
        lines.forEach((text, j) => rows.push(j === warnAt || j === loopAt
          ? { kind: 'text', key: `run:${runKey(run)}:${j}`, text: `  ${text}`, color: 'warning', isDim: false }
          : { kind: 'text', key: `run:${runKey(run)}:${j}`, text: `  ${text}`, color: j === 0 ? colorOf(shown[i]!) : undefined, isDim: j > 0 || isEnded(run.status) }))
      } else if (shown[i] === 'running' && run.lastSummary) {
        rows.push({ kind: 'text', key: `live:${runKey(run)}`, text: liveLine(run, now, columns), ...(isLooping(run) ? { color: 'warning' } : {}) })
      }
    })
  }
  return { key: `task:${task}`, color, rows, height: rows.length + 2 }
}

/** A task's card in every form, most detailed first: the phases `expanded` lists open, then closing
 * the earliest-expanded one at a time (the newest press survives), then all closed, then the header. */
export function cardVariants(task: string, runs: readonly OcliRun[], now: number, columns: number, expanded: readonly string[], declared: readonly string[] = []): Card[] {
  const mine = expanded.filter(key => key.startsWith(`${task}/`))
  const variants = mine.map((_, i) => {
    const open = new Set(mine.slice(i))
    return card(task, runs, now, columns, key => open.has(key), false, declared)
  })
  variants.push(card(task, runs, now, columns, () => false, false, declared), card(task, runs, now, columns, () => false, true, declared))
  return variants
}

/** Cards in order, each a list of variants (most detailed first): a card is drawn whole in the first
 * variant that fits, keeping a row for the "more" line while cards follow or any was cut; a card
 * that fits in none is cut (its index listed) and the cards after it still get their turn. A card
 * given as a function, none of whose variants is shorter than `min`, is built only if `min` fits:
 * a pane of hundreds of planned tasks builds the few it can draw. */
export function fitCards<C extends { height: number }>(cards: readonly (readonly C[] | (() => readonly C[]))[], room: number, min = 0): { shown: C[]; cut: number[] } {
  const shown: C[] = []
  const cut: number[] = []
  let used = 0
  for (const [i, card] of cards.entries()) {
    const reserve = cut.length > 0 || i < cards.length - 1 ? 1 : 0
    const variants = typeof card !== 'function' ? card : used + min + reserve <= room ? card() : []
    const pick = variants.find(c => used + c.height + reserve <= room)
    if (pick) {
      shown.push(pick)
      used += pick.height
    } else cut.push(i)
  }
  return { shown, cut }
}

// --- the checkpoint card: the newest <root>/checkpoints/*.md, so a reset lead resumes in the right place

const MAX_CP_ROWS = 50
const DRIFT_MS = 30 * 60_000
const cells_ = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())

/** A checkpoint's phase table, Next action paragraph and Resume backtick span. The table is the first
 * whose header has Phase and Status cells; `n` is its `#` cell, else the row's ordinal. Next action
 * and Resume are `##` or `###` sections, the last of each (checkpoints append, so the last is the
 * live one; a heading marked superseded never counts). null when there is neither a table nor a next
 * action. */
export function parseCheckpoint(name: string, md: string): Checkpoint | null {
  const lines = md.split('\n')
  const isRow = (line: string | undefined) => line !== undefined && line.trim().startsWith('|')
  let rows: Checkpoint['rows'] | null = null
  for (let i = 0; i < lines.length && rows === null; i++) {
    if (!isRow(lines[i]) || isRow(lines[i - 1])) continue
    const head = cells_(lines[i]!).map(cell => cell.toLowerCase())
    const at = { n: head.indexOf('#'), phase: head.indexOf('phase'), status: head.indexOf('status') }
    if (at.phase < 0 || at.status < 0) continue
    rows = []
    for (let j = i + 1; isRow(lines[j]) && rows.length < MAX_CP_ROWS; j++) {
      const cells = cells_(lines[j]!)
      if (cells.every(cell => /^:?-+:?$/.test(cell))) continue
      rows.push({ n: at.n < 0 ? String(rows.length + 1) : clean(cells[at.n], 80), phase: clean(cells[at.phase], 80), status: clean(cells[at.status], 80) })
    }
  }
  /** The lines under the last `##`/`###` heading matching `title`, up to the next heading of its level or above. */
  const section = (title: RegExp): string[] => {
    const start = lines.findLastIndex(line => title.test(line) && !/superseded/i.test(line))
    if (start < 0) return []
    const above = new RegExp(`^#{1,${/^#+/.exec(lines[start]!)![0].length}}\\s`)
    const end = lines.findIndex((line, i) => i > start && above.test(line))
    return lines.slice(start + 1, end < 0 ? undefined : end)
  }
  const paragraph: string[] = []
  for (const line of section(/^#{2,3}\s+next\s+(exact\s+)?actions?\b/i)) {
    if (line.trim()) paragraph.push(line)
    else if (paragraph.length) break
  }
  const next = clean(paragraph.join(' '), 300)
  const resume = clean(/`([^`\n]+)`/.exec(section(/^#{2,3}\s+resume\b/i).join('\n'))?.[1], 400)
  if (rows === null && !next) return null
  return { name: clean(name, 120), rows: rows ?? [], next, resume }
}

const is = (status: string, word: string) => status.toLowerCase() === word

/** A warning when the checkpoint says a phase is running while nothing moved for 30 minutes:
 * `newestEventAt` is the newest live event or checkpoint write the caller knows of. */
export function checkpointDrift(cp: Checkpoint, newestEventAt: number | null, now: number): string | null {
  if (!cp.rows.some(row => is(row.status, 'running'))) return null
  if (newestEventAt === null) return 'checkpoint says running, no live event seen'
  const idle = now - newestEventAt
  return idle > DRIFT_MS ? `checkpoint says running, no live event or checkpoint write for ${Math.floor(idle / 60_000)}m` : null
}

/** Only a plain file name reaches the prompt: no path, space, newline or backtick. */
export const CHECKPOINT_NAME = /^[A-Za-z0-9._-]+\.md$/

/** The fixed resume prompt: the root and the file name, never any checkpoint text. null for a name
 * that is not plain, or a root clean() would change (the prompt would name another path). */
export function resumePrompt(root: string, name: string): string | null {
  const file = clean(name, 120)
  return CHECKPOINT_NAME.test(file) && file === name && clean(root, 400) === root
    ? `Read ${root}/checkpoints/${file} first, then git status, then continue from the first phase that is not done.`
    : null
}

// A Map, not an object literal: a status cell reading `constructor` or `__proto__` must not reach a
// prototype (measured: the inherited function or object as <Text color> made the engine refuse the pane).
const CP_COLOR = new Map([['done', 'success'], ['running', 'suggestion'], ['blocked', 'warning']])

/** The checkpoint as a card `columns` wide: name and done/total, a row per phase (none when
 * `isCompact`, for a pane too short for them), next, resume, the drift warning, and a Queue resume
 * button when there is a resume command. */
export function checkpointCard(cp: Checkpoint, drift: string | null, columns: number, isCompact = false): Card {
  const right = `${cp.rows.filter(row => is(row.status, 'done')).length}/${cp.rows.length}`
  const rows: Row[] = [
    { kind: 'split', key: 'cp:head', left: fill(fit(cp.name, columns - width(right) - 1), columns - width(right)), right, isBold: true },
    ...(isCompact ? [] : cp.rows).map((row, i): Row => ({
      kind: 'text', key: `cp:row:${i}`, text: fit(`#${row.n} ${row.phase} · ${row.status}`, columns), color: CP_COLOR.get(row.status.toLowerCase()), isDim: true,
    })),
  ]
  if (cp.next) rows.push({ kind: 'text', key: 'cp:next', text: fit(`next: ${cp.next}`, columns) })
  if (cp.resume) rows.push({ kind: 'text', key: 'cp:resume', text: fit(`resume: ${cp.resume}`, columns), isDim: true })
  if (drift) rows.push({ kind: 'text', key: 'cp:drift', text: fit(drift, columns), color: 'warning' })
  if (cp.resume && CHECKPOINT_NAME.test(cp.name)) rows.push({ kind: 'button', key: 'checkpoint:resume', label: 'Queue resume' })
  return { key: 'checkpoint', rows, height: rows.length + 2 }
}
