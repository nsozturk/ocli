// Pure: live-file text -> events -> runs. No `$`. Every string from a live file is untrusted CLI
// output, so it is cleaned here, at ingest: nothing downstream (pane, toast, notify, status) can
// carry a terminal escape.
import type { Checkpoint, OcliHistory, OcliQuota, OcliRun, OcliStatus, QuotaWindow, QuotaProvider, QuotaState } from '../types'

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
  brief?: string
  parentId?: string
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
      event.brief = clean(r.brief, 600); event.parentId = clean(r.parentId, 80)
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
const MAX_RECENT = 5
const MAX_WARNINGS = 3
const VERIFY_END = /^verify\.end code=(-?\d+|null)$/

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
      if (e.brief) run.brief = e.brief
      if (e.root) run.root = e.root
      if (e.parentId) run.parentId = e.parentId
      run.startedAt = e.at
    } else if (e.kind === 'tool.start') {
      run.streak = { ...repeat(prev.streak, sigOf(e)), open: true }
    } else if (e.kind === 'tool.end') {
      run.toolCount += 1
      const sig = sigOf(e)
      run.recent = [...(prev.recent ?? []), { text: sig, ok: e.ok ?? null }].slice(-MAX_RECENT)
      // The end of the call a start opened closes it; the end of another call meanwhile leaves the
      // open one be. With none open (opencode and muse emit no tool.start) the end is itself the call.
      if (!prev.streak?.open) {
        const call = repeat(prev.streak, sig)
        run.streak = { ...call, okSince: e.ok === true, open: false }
      } else if (prev.streak.sig === sig) run.streak = { ...prev.streak, okSince: e.ok === true, open: false }
    } else if (e.kind === 'warn') {
      run.warnCount += 1
      run.warnings = [...(prev.warnings ?? []), e.text ?? ''].slice(-MAX_WARNINGS)
    } else if (e.kind === 'message') run.lastMessage = e.text ?? ''
    else if (e.kind === 'step' && VERIFY_END.test(e.label ?? '')) {
      const code = VERIFY_END.exec(e.label!)![1]!
      run.verifyCode = code === 'null' ? null : Number(code)
    }
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
/** Start to end (`ms` when the dispatcher measured it), or to `now` while running. */
const elapsedOf = (run: OcliRun, now: number): number | null => isEnded(run.status)
  ? (run.ms ?? (run.endedAt !== null && run.startedAt !== null ? run.endedAt - run.startedAt : null))
  : run.startedAt === null ? null : now - run.startedAt

export function runLine(run: OcliRun, now: number, columns: number): string {
  const shown = displayStatus(run, now)
  const word = shown === 'running' || shown === 'completed' ? '' : ` ${shown}`
  const parts = [
    `${GLYPH[shown]}${word}`, llm(run), duration(elapsedOf(run, now)), `${run.toolCount}t`,
    `${count(run.tokens.input)}/${count(run.tokens.output)}`, `· ${run.role}`,
  ]
  return fit(parts.join(' '), columns)
}

/** Whole words greedily to `columns` cells, at most `max` lines; a word wider than a line is cut, and
 * text left over past the last line marks it cut with an ellipsis. */
export function wrap(text: string, columns: number, max: number): string[] {
  const lines: string[] = []
  for (const word of text.split(' ').filter(Boolean)) {
    const last = lines.at(-1)
    if (last !== undefined && cells(`${last} ${word}`) <= columns) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(fit(word, columns))
  }
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), fit(`${lines[max - 1]} ${lines[max]}`, columns)]
}

/** One line of a run's block in the expanded card. */
export type DetailLine = { text: string; color?: string; isDim?: boolean }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** How an ended run ended: status, exit code, score and the --verify verdict when one ran. */
function endLine(run: OcliRun): string {
  const verify = run.verifyCode === undefined ? '' : run.verifyCode === 0 ? ' · verify passed' : ` · verify failed (exit ${run.verifyCode ?? '?'})`
  return `end: ${run.status} · exit ${run.exitCode ?? '?'} · score ${run.score ?? '?'}${verify}`
}

/** A run's block in the expanded card, `columns` wide: what it is (status, LLM, role, elapsed), what
 * it was asked (the brief, else the title), where it works and what it continues, its tools and
 * tokens, then what it is doing (the live line, its last tool calls, its last message, warnings) and
 * how it ended. `isCompact` keeps one brief and message line and drops the calls and warnings. Every
 * line fits; a run folded by an older version (no brief, root, recent…) still draws. */
export function runDetail(run: OcliRun, now: number, columns: number, isCompact = false): DetailLine[] {
  const shown = displayStatus(run, now)
  const inner = Math.max(1, columns - 2)
  const lines: DetailLine[] = [{ text: fit(`${GLYPH[shown]} ${shown} · ${llm(run)} · ${run.role} · ${duration(elapsedOf(run, now))}`, columns), color: colorOf(shown) }]
  const body = (text: string, style: Omit<DetailLine, 'text'> = { isDim: true }) => lines.push({ text: `  ${fit(text, inner)}`, ...style })
  for (const line of wrap(run.brief || run.title || '', inner, isCompact ? 1 : 3)) body(line, {})
  const place = [run.root || run.where ? `in ${run.root || run.where}` : '', run.parentId ? `parent ${run.parentId}` : ''].filter(Boolean).join(' · ')
  if (place) body(place)
  const { input, output, cached } = run.tokens
  body([plural(run.toolCount, 'tool'), run.warnCount ? plural(run.warnCount, 'warning') : '',
    `tokens in ${count(input)} · out ${count(output)}${cached == null ? '' : ` · cached ${count(cached)}`}`].filter(Boolean).join(' · '))
  if (!isEnded(run.status) && run.lastSummary) {
    lines.push({ text: liveLine(run, now, columns), isDim: false, ...(isLooping(run) ? { color: 'warning' } : {}) })
  }
  if (!isCompact) {
    for (const step of run.recent ?? []) {
      if (step.ok === false) body(`✗ ${step.text}`, { color: 'error', isDim: false })
      else body(`${step.ok ? '✓' : '·'} ${step.text}`)
    }
  }
  if (run.lastMessage) for (const line of wrap(`says: ${run.lastMessage}`, inner, isCompact ? 1 : 2)) body(line)
  if (!isCompact) for (const warning of run.warnings ?? []) body(`⚠ ${warning}`, { color: 'warning', isDim: false })
  // Claims its own trace does not back (orchestra/witness.mjs): kept in the compact form too.
  if (run.witness?.length) body(`⚠ unwitnessed: ${run.witness.join(', ')}`, { color: 'warning', isDim: false })
  if (isEnded(run.status)) body(endLine(run))
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
  /** A pressable: the pane's render hook knows what its key does. */
  | { kind: 'button'; key: string; label: string }
  /** A card's head: the `label` Button (▸/▾ and the name) presses `press`; `pad` and `right` fill the
   * row to its width, less the two cells of ` ×` when there is a `dismiss` Button (its press key). */
  | { kind: 'head'; key: string; press: string; isOpen: boolean; label: string; pad: string; right: string; dismiss?: string }
  /** A `label` Button pressing `press`, then `text`. */
  | { kind: 'press'; key: string; press: string; label: string; text: string; color?: string }
  /** A phase: `prefix` (its name), one dot colour per run, `tail` (marks, LLMs, fill), `right` (done/total);
   * `isWarn` while one of its runs may be looping. */
  | { kind: 'phase'; key: string; prefix: string; dots: string[]; tail: string; right: string; isPending?: boolean; isWarn?: boolean }
  /** Styled pieces of one row, already cut to its width; `isDim` dims them all. */
  | { kind: 'segs'; key: string; segs: Seg[]; isDim?: boolean }
export type Seg = { text: string; color?: string; isBold?: boolean }
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

/** How much of a card is drawn: closed (`false`), or open with every run's block in full or compact. */
export type Detail = false | 'full' | 'compact'

const DISMISSIBLE: readonly TaskStatus[] = ['Completed', 'Failed', 'Blocked']

/** Only a card whose runs are all over may go to History: never one with a running or stale run (a
 * stale run may still be alive), nor a plan with no run yet. */
export const isDismissible = (runs: readonly OcliRun[], now: number): boolean =>
  runs.length > 0 && DISMISSIBLE.includes(taskStatus(runs, now)) && runs.every(run => !['running', 'stale'].includes(displayStatus(run, now)))

/** A card's head row `columns` wide: the ▸/▾ toggle naming it, `right` at the edge, then ` ×` when
 * `dismiss` is its press key. */
function headRow(key: string, press: string, isOpen: boolean, name: string, right: string, columns: number, dismiss?: string): Row {
  const room = columns - width(right) - (dismiss ? 2 : 0)
  const label = fit(`${isOpen ? '▾' : '▸'} ${name}`, Math.max(1, room - 1))
  return { kind: 'head', key, press, isOpen, label, pad: ' '.repeat(Math.max(0, room - width(label))), right, ...(dismiss ? { dismiss } : {}) }
}

/** One task's card, `columns` wide inside its border. Closed (`open` false) it is its head (the ▸
 * toggle, the span, × once dismissible), status, count, title and one row per phase; open, each phase
 * row is followed by a block per run (runDetail). `isHeader` draws the header form, for a card too
 * tall even closed. `declared` is the task's plan: those phases are drawn first, a pending row for
 * any not yet run. */
export function card(task: string, runs: readonly OcliRun[], now: number, columns: number, open: Detail, isHeader = false, declared: readonly string[] = [], quota: DetailLine | null = null): Card {
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
  const isOpen = !!open && !isHeader
  const rows: Row[] = [
    headRow(`head:${task}`, `card:${task}`, isOpen, task, span, columns, isDismissible(runs, now) ? `dismiss:${task}` : undefined),
    { kind: 'text', key: 'status', text: `ocli · ${status}`, color, isDim: !runs.length },
    { kind: 'text', key: 'count', text: fit(countRow, columns), isDim: true },
  ]
  if (isHeader) {
    // HEADER_HEIGHT counts these four rows and the border.
    const note = `${phases.length} phase${phases.length === 1 ? '' : 's'} · pane too short to list them`
    rows.push({ kind: 'text', key: 'short', text: fit(note, columns), isDim: true })
    return { key: `task:${task}`, color, rows, height: rows.length + 2 }
  }
  // After the header form's return: HEADER_HEIGHT stays its exact height.
  if (quota) rows.splice(2, 0, { kind: 'text', key: 'quota', ...quota, text: fit(quota.text, columns) })
  if (recent) rows.push({ kind: 'text', key: 'what', text: fit(recent.title, columns), isDim: true })
  rows.push({ kind: 'text', key: 'phases', text: 'Phases', isBold: true })
  for (const [phase, list] of phases) {
    const shown = list.map(run => displayStatus(run, now))
    const right = `${list.filter(run => isEnded(run.status)).length}/${list.length} done`
    const room = columns - width(right)
    // A declared phase with no run yet says so where the LLM names would be.
    const names = list.length ? [...new Set(list.map(shortModel))].join(', ') : 'declared'
    // The name gives way to the dots and the LLM names, down to a third of the row.
    const nameRoom = Math.max(Math.ceil(room / 3), room - list.length - width(names) - 7)
    const prefix = `${fit(`  ${phase}`, Math.max(1, Math.min(room - 4, nameRoom)))}  `
    // ponytail: a phase with more runs than room shows its newest dots and `+K` for the rest;
    // done/total still counts all.
    const dotRoom = Math.max(0, room - width(prefix) - 2)
    const keep = list.length <= dotRoom ? list.length : Math.max(0, dotRoom - 2 - String(list.length).length)
    const dots = shown.slice(list.length - keep).map(colorOf)
    const unwitnessed = list.filter(run => run.witness?.length).length
    const looping = list.filter((run, i) => shown[i] === 'running' && isLooping(run)).length
    // Parts joined with " · ", the done count last: the marks (never cut), the LLM names (cut to fit),
    // then the cache ratio and the prefix-drift marker, each drawn whole or dropped.
    const marks = [keep < list.length ? `+${list.length - keep}` : '', unwitnessed ? `⚠${unwitnessed}` : '', looping ? `⟳${looping}` : ''].filter(Boolean)
    const optional = [cacheNote(list).trim(), prefixNote(list).trim()].filter(Boolean)
    const tailRoom = room - width(prefix) - dots.length
    const lead = dots.length ? '  ' : ''
    const joined = (parts: string[]) => `${lead}${parts.join(' · ')} · `
    let extra = optional
    while (extra.length && width(joined([...marks, names, ...extra])) > tailRoom) extra = extra.slice(0, -1)
    const nameFit = tailRoom - width(joined([...marks, '', ...extra]))
    // ponytail: past the marks no room is left on a very narrow pane: the tail is cut, never the done count.
    const tail = tailRoom > 0 ? fit(joined([...marks, ...(nameFit > 1 ? [fit(names, nameFit)] : []), ...extra]), tailRoom) : ''
    rows.push({ kind: 'phase', key: `phase:${task}/${phase}`, prefix, dots, tail, right, ...(list.length ? {} : { isPending: true }), ...(looping ? { isWarn: true } : {}) })
    // Closed, a running run keeps one glanceable line under its phase: its sparkline and last action.
    if (!isOpen) {
      list.forEach((run, i) => {
        if (shown[i] !== 'running' || !run.lastSummary) return
        rows.push({ kind: 'text', key: `live:${runKey(run)}`, text: `  ${liveLine(run, now, columns - 2)}`, ...(isLooping(run) ? { color: 'warning' } : {}) })
      })
    }
    if (!isOpen) continue
    for (const run of list) {
      runDetail(run, now, columns - 2, open === 'compact').forEach((line, j) => rows.push({
        kind: 'text', key: `run:${runKey(run)}:${j}`, ...line, text: `  ${line.text}`,
      }))
    }
  }
  return { key: `task:${task}`, color, rows, height: rows.length + 2 }
}

/** A task's card in every form, most detailed first: open in full and compact while `expanded` names
 * the task, then closed, then the header. */
export function cardVariants(task: string, runs: readonly OcliRun[], now: number, columns: number, expanded: readonly string[], declared: readonly string[] = [], quota: DetailLine | null = null): Card[] {
  const forms: Detail[] = expanded.includes(task) ? ['full', 'compact', false] : [false]
  return [...forms.map(open => card(task, runs, now, columns, open, false, declared, quota)), card(task, runs, now, columns, false, true, declared)]
}

// --- History: cards the person moved out of the list, by hand only --------------------------------

const MAX_HISTORY = 100
const MAX_HISTORY_ROWS = 20
const HISTORY_STATUSES: readonly OcliHistory['status'][] = ['Completed', 'Failed', 'Blocked']

/** A dismissible task's snapshot as of `now`, in `scope` (the dirs the pane watches): what its
 * History row draws after its runs age out. */
export function historyEntry(scope: string, task: string, runs: readonly OcliRun[], now: number): OcliHistory {
  return { scope, task, status: taskStatus(runs, now) as OcliHistory['status'], runs: runs.length, tokens: tokensOf(runs), span: taskSpan(runs, now), lastAt: latestAt(runs), dismissedAt: now }
}

/** A dismissed card stays out of the list until one of its runs has an event newer than the
 * dismissal saw: a new run of the task brings the card back. */
export const isDismissed = (entry: OcliHistory | undefined, runs: readonly OcliRun[]): boolean =>
  !!entry && latestAt(runs) <= entry.lastAt

const sameEntry = (a: OcliHistory, b: OcliHistory) => a.scope === b.scope && a.task === b.task

/** `list` with `entries` added: one entry per (scope, task), the new one replacing the old; the newest 100. */
export function addHistory(list: readonly OcliHistory[], entries: readonly OcliHistory[]): OcliHistory[] {
  return [...list.filter(entry => !entries.some(added => sameEntry(entry, added))), ...entries].slice(-MAX_HISTORY)
}

const numOrNull = (value: unknown): number | null | undefined => (value === null ? null : num(value) ?? undefined)
// What a Date can hold: past it, toISOString throws and a clock reads NaN.
const MAX_TIME = 8.64e15
const timeOf = (value: unknown): number | null => {
  const n = num(value)
  return n !== null && Math.abs(n) <= MAX_TIME ? n : null
}

/** History as read back from $.store (a file under the user's config): every entry checked and its
 * strings cleaned; an entry with no scope (written before scopes) or out of range is dropped; one
 * per (scope, task), the last kept; the newest 100. */
export function foldHistory(raw: unknown): OcliHistory[] {
  if (!Array.isArray(raw)) return []
  let out: OcliHistory[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    const [scope, task] = [clean(r.scope, 4000), clean(r.task, 120)]
    const [tokens, span] = [numOrNull(r.tokens), numOrNull(r.span)]
    const [lastAt, dismissedAt] = [timeOf(r.lastAt), timeOf(r.dismissedAt)]
    const runs = Number.isInteger(r.runs) && (r.runs as number) >= 0 ? (r.runs as number) : null
    if (!scope || !task || !HISTORY_STATUSES.includes(r.status as OcliHistory['status']) || tokens === undefined || span === undefined
      || runs === null || lastAt === null || dismissedAt === null) continue
    out = addHistory(out, [{ scope, task, status: r.status as OcliHistory['status'], runs, tokens, span, lastAt, dismissedAt }])
  }
  return out
}

/** Local hours and minutes, as the person's clock reads them. */
const clockOf = (ms: number): string => [new Date(ms).getHours(), new Date(ms).getMinutes()].map(n => String(n).padStart(2, '0')).join(':')

/** The History card, `columns` wide: closed, its ▸ head and the count; open, also a row per entry,
 * newest first (at most 20, the rest counted), each with a restore Button. */
function historyCard(entries: readonly OcliHistory[], isOpen: boolean, columns: number): Card {
  const rows: Row[] = [headRow('history:head', 'history:toggle', isOpen, 'History', String(entries.length), columns)]
  if (isOpen) {
    const newest = [...entries].sort((a, b) => b.dismissedAt - a.dismissedAt)
    for (const entry of newest.slice(0, MAX_HISTORY_ROWS)) {
      const at = clockOf(entry.dismissedAt)
      const text = ` ${entry.task} · ${entry.status} · ${plural(entry.runs, 'run')} · ${count(entry.tokens)} tokens · ${duration(entry.span)} · dismissed ${at}`
      rows.push({ kind: 'press', key: `entry:${entry.task}`, press: `restore:${entry.task}`, label: 'restore', text: fit(text, columns - width('restore')), color: TASK_COLOR[entry.status] })
    }
    if (newest.length > MAX_HISTORY_ROWS) rows.push({ kind: 'text', key: 'history:more', text: `+${newest.length - MAX_HISTORY_ROWS} older`, isDim: true })
  }
  return { key: 'history', rows, height: rows.length + 2 }
}

/** The History card's forms, most detailed first: open (when it is), then closed. */
export const historyVariants = (entries: readonly OcliHistory[], isOpen: boolean, columns: number): Card[] =>
  isOpen ? [historyCard(entries, true, columns), historyCard(entries, false, columns)] : [historyCard(entries, false, columns)]

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

// --- the quota card: <live dir>/usage/latest.json, the dispatcher's last reading per provider -----

const QUOTA_PROVIDERS = ['codex', 'claude', 'glm', 'gemini', 'muse', 'cline'] as const
const QUOTA_STATES: readonly QuotaState[] = ['ok', 'stop', 'unknown']
const QUOTA_STATUSES: readonly QuotaProvider['status'][] = ['ok', 'unknown', 'unavailable']
/** Windows drawn per row: the binding one and the shortest of the rest. Ingest keeps them all (the
 * 64 KiB read cap bounds the count), so the binding one is chosen before any is dropped. */
const MAX_WINDOWS = 4
const MAX_ROUTES = 12
/** A reading older than this is drawn dim with its age. */
export const QUOTA_STALE_MS = 30 * 60_000
/** Inner columns below which the bars are dropped, then the route sub-rows. */
const QUOTA_BAR_COLUMNS = 60
const QUOTA_SUB_COLUMNS = 32
const BAR_CELLS = 5
/** The CLI a run names to the provider whose quota it spends. ponytail: opencode is GLM and agy is
 * Gemini in the ocli roster; an opencode run on another model would be shown GLM's quota. */
const PROVIDER_OF = new Map([['codex', 'codex'], ['claude', 'claude'], ['opencode', 'glm'], ['agy', 'gemini'], ['muse', 'muse'], ['cline', 'cline']])

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const stateOf = (value: unknown): QuotaState => (QUOTA_STATES as readonly unknown[]).includes(value) ? (value as QuotaState) : 'unknown'
const list = (value: unknown, max: number): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).map(record).filter((r): r is Record<string, unknown> => r !== null).slice(0, max)

const windowOf = (w: Record<string, unknown>): QuotaWindow =>
  ({ limitId: clean(w.limitId, 80), usedPercent: num(w.usedPercent), mins: num(w.windowDurationMins), resetsAt: time(w.resetsAt) })
const byMins = (a: QuotaWindow, b: QuotaWindow): number => (a.mins ?? Infinity) - (b.mins ?? Infinity)
/** The most used window (the shorter on a tie); null when none has a percentage. */
const fullestOf = (windows: readonly QuotaWindow[]): QuotaWindow | null =>
  [...windows].sort(byMins).reduce<QuotaWindow | null>((best, w) => w.usedPercent !== null && (best === null || w.usedPercent > best.usedPercent!) ? w : best, null)
/** A gate's `window`: the one the dispatcher's gate bound on, as written; null (or not a window)
 * binds none; undefined when the gate has no `window` key at all (a snapshot older than gate.window). */
const boundOf = (gate: unknown): QuotaWindow | null | undefined => {
  const g = record(gate)
  if (!g || !Object.hasOwn(g, 'window')) return undefined
  const w = record(g.window)
  return w && windowOf(w)
}

/** `<live dir>/usage/latest.json` (schema v1) as the pane draws it: only the six known providers, in
 * the fixed order, only the fields it draws (an identity or a secret a writer let through is never
 * kept), every string cleaned. null unless it is `{v: 1, providers: {...}}` naming one of them. */
export function foldQuota(text: string): OcliQuota | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const r = record(raw)
  const all = record(r?.providers)
  if (!r || r.v !== 1 || !all) return null
  const providers: QuotaProvider[] = []
  for (const name of QUOTA_PROVIDERS) {
    const p = Object.hasOwn(all, name) ? record(all[name]) : null
    if (!p) continue
    const stop = record(p.stop)
    const windows = list(p.windows, Infinity).map(windowOf)
    providers.push({
      name,
      readAt: time(p.readAt),
      status: (QUOTA_STATUSES as readonly unknown[]).includes(p.status) ? (p.status as QuotaProvider['status']) : 'unknown',
      reason: clean(p.reason, 120),
      windows,
      gate: stateOf(record(p.gate)?.state),
      window: boundOf(p.gate) === undefined ? fullestOf(windows) : boundOf(p.gate)!,
      routes: list(p.routes, MAX_ROUTES).map(x => {
        const window = boundOf(x.gate)
        return { role: clean(x.role, 40), model: clean(x.model, 80), gate: stateOf(record(x.gate)?.state), ...(window === undefined ? {} : { window }) }
      }).filter(x => x.model),
      stop: stop && { until: time(stop.until), reason: clean(stop.reason, 120) },
      setup: clean(p.setup, 160),
    })
  }
  return providers.length ? { writtenAt: time(r.writtenAt), providers } : null
}

type Chip = 'OK' | 'STOP' | '?'
const CHIP_COLOR = new Map<Chip, string>([['OK', 'success'], ['STOP', 'warning']])
const chipOf = (state: QuotaState): Chip => (state === 'ok' ? 'OK' : state === 'stop' ? 'STOP' : '?')
/** A provider stop with no end, or one still ahead (the dispatcher's providerStopActive: fail closed). */
const isStopActive = (p: QuotaProvider, now: number): boolean => p.stop !== null && (p.stop.until === null || p.stop.until > now)
/** An active stop or a stop gate: STOP; no reading: ?; else the gate. */
function providerChip(p: QuotaProvider, now: number): Chip {
  if (p.gate === 'stop' || isStopActive(p, now)) return 'STOP'
  return p.status === 'unavailable' ? '?' : chipOf(p.gate)
}
const untilAt = (ms: number | null, now: number): string => (ms === null ? 'until reset unknown' : `until ${clockOf(ms)} (${rel(ms - now)})`)
/** When a STOP ends: an active stop's own end (`until reset unknown` when it has none, an endless stop can always
 * be the longest); when a stop gate overlaps it, the later of that end and the gate window's reset; else, for a stop
 * gate alone, the reset of the window it bound on. '' when neither applies or the snapshot names no window. */
function untilOf(p: QuotaProvider, now: number, gate: QuotaState, bound: QuotaWindow | null): string {
  if (isStopActive(p, now)) {
    const end = p.stop!.until
    const reset = gate === 'stop' ? bound?.resetsAt ?? null : null
    return untilAt(end !== null && reset !== null && reset > end ? reset : end, now)
  }
  return gate === 'stop' && bound ? untilAt(bound.resetsAt, now) : ''
}

/** Short and coarse: `40m`, `2h10m`, `2d3h`. */
function rel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(m / 1440)}d${Math.floor(m / 60) % 24}h`
}
const ageOf = (ms: number): string => (ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`)
const windowLabel = (mins: number | null): string =>
  mins === null ? '?' : mins === 10080 ? 'wk' : mins >= 1440 ? `${Math.round(mins / 1440)}d` : mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`
const pct = (n: number | null): string => (n === null ? '?%' : `${Math.round(n)}%`)

/** The binding window: the gate's own (`bound`, matched in the list by limitId and length); none
 * when the gate binds none. Drawn first, so a narrow row cuts the other windows (shortest first,
 * MAX_WINDOWS in all) before it. */
function windowsOf(windows: readonly QuotaWindow[], bound: QuotaWindow | null) {
  const sorted = [...windows].sort(byMins)
  const binding = bound && (sorted.find(w => w.limitId === bound.limitId && w.mins === bound.mins) ?? bound)
  const shown = (binding ? [binding, ...sorted.filter(w => w !== binding)] : sorted).slice(0, MAX_WINDOWS)
  return { shown, binding }
}

const isStale = (p: QuotaProvider, now: number): boolean => p.readAt === null || now - p.readAt > QUOTA_STALE_MS

/** Segments cut to `columns` cells, the last one that does not fit with an ellipsis. */
function fitSegs(segs: readonly Seg[], columns: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    if (used + width(seg.text) <= columns) {
      out.push(seg)
      used += width(seg.text)
      continue
    }
    if (columns - used > 1) out.push({ ...seg, text: fit(seg.text, columns - used) })
    break
  }
  return out
}

const INDENT = ' '.repeat(7)

/** One provider's rows: its row (name, chip, until/stale, bar, windows with the binding one bold,
 * the reset), then the routes sub-row or the setup line when `isSub`. */
function providerRows(p: QuotaProvider, now: number, columns: number, isBars: boolean, isSub: boolean): Row[] {
  const chip = providerChip(p, now)
  const { shown: sorted, binding } = windowsOf(p.windows, p.window)
  const segs: Seg[] = [{ text: fill(p.name, 7) }, { text: fill(chip, 5), color: CHIP_COLOR.get(chip) }]
  const notes = [untilOf(p, now, p.gate, p.window), isStale(p, now) ? `stale ${p.readAt === null ? '?' : ageOf(now - p.readAt)}` : ''].filter(Boolean)
  if (notes.length) segs.push({ text: `${notes.join(' ')} ` })
  if (!sorted.length) segs.push({ text: p.reason || 'no reading' })
  else {
    if (isBars && binding?.usedPercent != null) {
      const n = Math.round((Math.min(100, Math.max(0, binding.usedPercent)) / 100) * BAR_CELLS)
      segs.push({ text: `${'█'.repeat(n)}${'░'.repeat(BAR_CELLS - n)} ` })
    }
    sorted.forEach((w, i) => {
      if (i) segs.push({ text: ' ' })
      segs.push({ text: `${windowLabel(w.mins)} ${pct(w.usedPercent)}`, ...(w === binding ? { isBold: true } : {}) })
    })
    if (binding?.resetsAt != null && binding.resetsAt > now) segs.push({ text: ` · resets ${rel(binding.resetsAt - now)}` })
  }
  const rows: Row[] = [{ kind: 'segs', key: `quota:row:${p.name}`, segs: fitSegs(segs, columns), ...(isStale(p, now) ? { isDim: true } : {}) }]
  if (isSub && p.routes.length) {
    const sub: Seg[] = [{ text: INDENT }]
    // An active provider stop refuses every route (the dispatcher's budget-stop), whatever its gate.
    const isStopped = isStopActive(p, now)
    routeGroups(p).forEach(([label, gate, bound], i) => {
      const state: QuotaState = isStopped ? 'stop' : gate
      sub.push({ text: `${i ? ' · ' : ''}${label} ` }, { text: chipOf(state), color: CHIP_COLOR.get(chipOf(state)) })
      if (bound) sub.push({ text: ' ' }, { text: `${windowLabel(bound.mins)} ${pct(bound.usedPercent)}`, isBold: true })
      const until = state === 'stop' ? untilOf(p, now, gate, bound) : ''
      if (until) sub.push({ text: ` ${until}` })
    })
    rows.push({ kind: 'segs', key: `quota:routes:${p.name}`, segs: fitSegs(sub, columns) })
  }
  if (isSub && p.status === 'unavailable' && p.setup) rows.push({ kind: 'text', key: `quota:setup:${p.name}`, text: fit(`${INDENT}setup: ${p.setup}`, columns), isDim: true })
  return rows
}

/** A route model's family and effort: `gemini-4-argon-high` is `argon`, `high`. */
function routeName(model: string): { family: string; effort: string } {
  const short = (model.split('/').pop() ?? model).replace(/^[a-z]+-[\d.]+-/, '')
  const at = short.lastIndexOf('-')
  const effort = at > 0 ? short.slice(at + 1) : ''
  return /^(min|low|medium|high|xhigh|max)$/.test(effort) ? { family: short.slice(0, at), effort } : { family: short, effort: '' }
}

/** Routes grouped by family, state and bound window, in first-seen order: `argon high/medium`,
 * `flash`. Efforts are named only for a family with more than one route. */
function routeGroups(p: QuotaProvider): [string, QuotaState, QuotaWindow | null][] {
  const names = p.routes.map(r => ({ ...routeName(r.model), gate: r.gate, window: r.window ?? null }))
  const groups = new Map<string, { family: string; efforts: string[]; gate: QuotaState; window: QuotaWindow | null }>()
  for (const n of names) {
    const key = [n.family, n.gate, n.window && JSON.stringify(n.window)].join('\u0000')
    const group = groups.get(key) ?? groups.set(key, { family: n.family, efforts: [], gate: n.gate, window: n.window }).get(key)!
    if (n.effort) group.efforts.push(n.effort)
  }
  return [...groups.values()].map(g => {
    const isMany = names.filter(n => n.family === g.family).length > 1
    return [isMany && g.efforts.length ? `${g.family} ${g.efforts.join('/')}` : g.family, g.gate, g.window]
  })
}

/** The Quota card, `columns` wide: its ▸/▾ head with `<ok>/<n> OK`; open, a row per provider, with
 * the bars on a wide pane and the route sub-rows and setup lines when `isSub` (and the pane is not
 * too narrow). */
function quotaCard(q: OcliQuota, now: number, columns: number, isOpen: boolean, isSub = true): Card {
  const ok = q.providers.filter(p => providerChip(p, now) === 'OK').length
  const rows: Row[] = [headRow('quota:head', 'quota:toggle', isOpen, 'Quota', `${ok}/${q.providers.length} OK`, columns)]
  if (isOpen) {
    for (const p of q.providers) rows.push(...providerRows(p, now, columns, columns >= QUOTA_BAR_COLUMNS, isSub && columns >= QUOTA_SUB_COLUMNS))
  }
  return { key: 'quota', rows, height: rows.length + 2 }
}

/** The Quota card's forms, most detailed first: open in full, open without sub-rows, closed. */
export const quotaVariants = (q: OcliQuota, now: number, columns: number, isOpen: boolean): Card[] =>
  isOpen ? [quotaCard(q, now, columns, true), quotaCard(q, now, columns, true, false), quotaCard(q, now, columns, false)] : [quotaCard(q, now, columns, false)]

/** A task card's quota line for its newest run's provider (its route, when the snapshot scopes
 * one): `quota: gemini flash OK · wk 39%`, or `quota: glm STOP until 14:05` in the warning colour.
 * null when there is no snapshot, no run, or the snapshot lacks the provider. */
export function quotaLine(runs: readonly OcliRun[], q: OcliQuota | null, now: number): DetailLine | null {
  const run = [...runs].sort((a, b) => (b.lastAt ?? startOf(b) ?? 0) - (a.lastAt ?? startOf(a) ?? 0))[0]
  const name = run && PROVIDER_OF.get(run.cli)
  const p = name ? q?.providers.find(x => x.name === name) : undefined
  if (!run || !p) return null
  const model = (run.model ?? '').split('/').pop()
  const route = p.routes.find(r => r.model.split('/').pop() === model)
  // The route's gate and window when the snapshot scopes one; an active provider stop overrides it.
  const gate = route ? route.gate : p.gate
  const bound = route ? (route.window === undefined ? fullestOf(p.windows) : route.window) : p.window
  const chip = route ? (isStopActive(p, now) ? 'STOP' : chipOf(gate)) : providerChip(p, now)
  const label = `quota: ${p.name}${route ? ` ${routeName(route.model).family}` : ''} ${chip}`
  if (chip === 'STOP') return { text: [label, untilOf(p, now, gate, bound)].filter(Boolean).join(' '), color: 'warning' }
  const { binding } = windowsOf(p.windows, bound)
  if (binding) return { text: `${label} · ${windowLabel(binding.mins)} ${pct(binding.usedPercent)}` }
  return { text: chip === 'OK' ? `${label} · no cap` : label }
}
