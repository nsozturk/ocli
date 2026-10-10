// Pure: live-file text -> events -> runs. No `$`. Every string from a live file is untrusted CLI
// output, so it is cleaned here, at ingest: nothing downstream (pane, toast, notify, status) can
// carry a terminal escape.
import type { OcliRun, OcliStatus } from '../types'

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
  label?: string
  tool?: string
  detail?: string
  ok?: boolean | null
  text?: string
  input?: number | null
  output?: number | null
  status?: OcliStatus
  exitCode?: number | null
  ms?: number | null
  score?: number | null
  dropped?: number
}

const STALE_MS = 10 * 60_000
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
      break
    case 'step': event.label = clean(r.label); break
    case 'tool.start':
    case 'tool.end': event.tool = clean(r.tool, 80); event.detail = clean(r.detail); event.ok = typeof r.ok === 'boolean' ? r.ok : null; break
    case 'message':
    case 'warn': event.text = clean(r.text); break
    case 'unparsed': event.text = clean(r.line); break
    case 'usage': event.input = num(r.input); event.output = num(r.output); break
    case 'run.end':
      event.status = status(r.status); event.exitCode = num(r.exitCode); event.ms = num(r.ms)
      event.score = num(r.score); event.dropped = droppedTotal(r.dropped)
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

/** A run's identity: its live file, `<task>/<runId>.jsonl`. Neither part can hold a `/`. */
export const runKey = (run: { task: string; runId: string }): string => `${run.task}/${run.runId}`

/** Folds events into runs. Idempotent: an event whose seq a run already holds is skipped. */
export function reduce(runs: readonly OcliRun[], events: readonly OcliEvent[]): OcliRun[] {
  const byId = new Map(runs.map(run => [runKey(run), run] as const))
  for (const e of events) {
    const prev = byId.get(runKey(e)) ?? blank(e)
    if (e.seq <= prev.lastSeq) continue
    const run: OcliRun = { ...prev, tokens: { ...prev.tokens }, lastSeq: e.seq }
    if (e.at !== null) run.lastAt = Math.max(run.lastAt ?? e.at, e.at)
    run.lastSummary = summary(e) ?? run.lastSummary
    if (e.kind === 'run.start') {
      run.model = e.model || null
      run.title = e.title ?? ''
      run.where = (e.root ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
      run.phase = e.phase ?? ''
      run.startedAt = e.at
    } else if (e.kind === 'tool.end') run.toolCount += 1
    else if (e.kind === 'warn') run.warnCount += 1
    else if (e.kind === 'usage') run.tokens = { input: add(run.tokens.input, e.input), output: add(run.tokens.output, e.output) }
    else if (e.kind === 'run.end') {
      Object.assign(run, { status: e.status, endedAt: e.at, exitCode: e.exitCode, ms: e.ms, score: e.score, dropped: e.dropped })
    }
    byId.set(runKey(e), run)
  }
  return [...byId.values()]
}

export const isEnded = (s: OcliStatus): boolean => s !== 'running'

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
  if (run.lastSummary) lines.push(fit(`  ↳ ${run.lastSummary}`, columns))
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

/** Runs grouped by phase, phases in first-seen order, runs by start within each. */
export function phasesOf(runs: readonly OcliRun[]): [string, OcliRun[]][] {
  const phases = new Map<string, OcliRun[]>()
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
  | { kind: 'phase'; key: string; open: string; isOpen: boolean; prefix: string; dots: string[]; tail: string; right: string }
/** `height` is what the card costs in rows: its rows and the two of its border. */
export type Card = { key: string; color?: string; rows: Row[]; height: number }

const width = cells
const fill = (text: string, columns: number) => text + ' '.repeat(Math.max(0, columns - width(text)))

/** One task's card, `columns` wide inside its border. `isOpen` says which `<task>/<phase>` rows are
 * expanded; `isHeader` draws the header form, for a card too tall even with every phase closed. */
export function card(task: string, runs: readonly OcliRun[], now: number, columns: number, isOpen: (key: string) => boolean, isHeader = false): Card {
  const status = taskStatus(runs, now)
  const span = duration(taskSpan(runs, now))
  const tokens = tokensOf(runs)
  const recent = [...runs].filter(run => run.title).sort((a, b) => (b.lastAt ?? startOf(b) ?? 0) - (a.lastAt ?? startOf(a) ?? 0))[0]
  const rows: Row[] = [
    { kind: 'split', key: `head:${task}`, left: fill(fit(task, columns - width(span) - 1), columns - width(span)), right: span, isBold: true },
    { kind: 'text', key: 'status', text: `ocli · ${status}`, color: TASK_COLOR[status] },
    { kind: 'text', key: 'count', text: fit(`${runs.length} run${runs.length === 1 ? '' : 's'} · ${count(tokens)} tokens`, columns), isDim: true },
  ]
  const phases = phasesOf(runs)
  if (isHeader) {
    const note = `${phases.length} phase${phases.length === 1 ? '' : 's'} · pane too short to list them`
    rows.push({ kind: 'text', key: 'short', text: fit(note, columns), isDim: true })
    return { key: `task:${task}`, color: TASK_COLOR[status], rows, height: rows.length + 2 }
  }
  if (recent) rows.push({ kind: 'text', key: 'what', text: fit(recent.title, columns), isDim: true })
  rows.push({ kind: 'text', key: 'phases', text: 'Phases', isBold: true })
  for (const [phase, list] of phases) {
    const open = `${task}/${phase}`
    const isOpenNow = isOpen(open)
    const shown = list.map(run => displayStatus(run, now))
    const right = `${list.filter(run => isEnded(run.status)).length}/${list.length}`
    const room = columns - width(right) - 1
    const llms = [...new Set(list.map(shortModel))].join(', ')
    // The name gives way to the dots and the LLM names, down to a third of the row.
    const nameRoom = Math.max(Math.ceil(room / 3), room - list.length - width(` ${llms}`) - 1)
    const prefix = `${fit(`${isOpenNow ? '▾' : '▸'} ${phase}`, Math.max(1, Math.min(room - 2, nameRoom)))} `
    // ponytail: a phase with more runs than room shows its newest dots and `+K` for the rest;
    // done/total still counts all.
    const dotRoom = Math.max(0, room - width(prefix))
    const keep = list.length <= dotRoom ? list.length : Math.max(0, dotRoom - 2 - String(list.length).length)
    const more = keep < list.length ? ` +${list.length - keep}` : ''
    const dots = shown.slice(list.length - keep).map(colorOf)
    const tailRoom = room - width(prefix) - dots.length - width(more)
    const tail = fill(more + (tailRoom > 1 ? fit(` ${llms}`, tailRoom) : ''), columns - width(right) - width(prefix) - dots.length)
    rows.push({ kind: 'phase', key: `phase:${open}`, open, isOpen: isOpenNow, prefix, dots, tail, right })
    list.forEach((run, i) => {
      if (isOpenNow) {
        runLines(run, now, columns - 2).forEach((text, j) => rows.push({
          kind: 'text', key: `run:${runKey(run)}:${j}`, text: `  ${text}`, color: j === 0 ? colorOf(shown[i]!) : undefined, isDim: j > 0 || isEnded(run.status),
        }))
      } else if (shown[i] === 'running' && run.lastSummary) {
        rows.push({ kind: 'text', key: `live:${runKey(run)}`, text: fit(`  ↳ ${run.lastSummary}`, columns) })
      }
    })
  }
  return { key: `task:${task}`, color: TASK_COLOR[status], rows, height: rows.length + 2 }
}

/** A task's card in every form, most detailed first: the phases `expanded` lists open, then closing
 * the earliest-expanded one at a time (the newest press survives), then all closed, then the header. */
export function cardVariants(task: string, runs: readonly OcliRun[], now: number, columns: number, expanded: readonly string[]): Card[] {
  const mine = expanded.filter(key => key.startsWith(`${task}/`))
  const variants = mine.map((_, i) => {
    const open = new Set(mine.slice(i))
    return card(task, runs, now, columns, key => open.has(key))
  })
  variants.push(card(task, runs, now, columns, () => false), card(task, runs, now, columns, () => false, true))
  return variants
}

/** Cards in order, each a list of variants (most detailed first): a card is drawn whole in the first
 * variant that fits, keeping a row for the "more" line while cards follow or any was cut; a card
 * that fits in none is cut (its index listed) and the cards after it still get their turn. */
export function fitCards<C extends { height: number }>(cards: readonly (readonly C[])[], room: number): { shown: C[]; cut: number[] } {
  const shown: C[] = []
  const cut: number[] = []
  let used = 0
  for (const [i, variants] of cards.entries()) {
    const reserve = cut.length > 0 || i < cards.length - 1 ? 1 : 0
    const pick = variants.find(c => used + c.height + reserve <= room)
    if (pick) {
      shown.push(pick)
      used += pick.height
    } else cut.push(i)
  }
  return { shown, cut }
}
