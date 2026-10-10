import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, FsEntry, Register } from 'claude-code'

import type { OcliDir, OcliMeta, OcliRun } from '../types'
import { cardVariants, clean, displayStatus, fit, fitCards, isEnded, latestAt, parseLines, reduce, runKey } from './reduce'
import type { Card, OcliEvent, Row } from './reduce'

const PANE = 'ocli'
const TICK_MS = 2000
const DAY_MS = 24 * 3_600_000
// The engine rejects a $.fs.read over 4 MiB, so the 5 MB cap the lead set is tightened to 4 MiB.
const MAX_BYTES = 4 * 1024 * 1024
// Bounds what one tick reads, keeps in $.state and draws: a CLI under --yolo can create files here.
const MAX_FILES = 500
const MAX_TOASTS = 3
// Expanded phase rows kept in $.state; the oldest are forgotten past this.
const MAX_EXPANDED = 200

const runsAtom = atom({ plugin: 'ocli-monitor', key: 'runs' } as const, [] as OcliRun[])
const metaAtom = atom({ plugin: 'ocli-monitor', key: 'meta' } as const, { dirs: [], lastTickAt: null, errors: 0, tooLarge: [], skipped: 0 } as OcliMeta)
const notifiedAtom = atom({ plugin: 'ocli-monitor', key: 'notified' } as const, [] as string[])
const primedAtom = atom({ plugin: 'ocli-monitor', key: 'primed' } as const, false)
const expandedAtom = atom({ plugin: 'ocli-monitor', key: 'expanded' } as const, [] as string[])

type $ = EngineInterface

const liveDirsOf = (value: unknown): string[] =>
  String(value ?? '').split(',').map(dir => dir.trim().replace(/\/+$/, '')).filter(dir => dir.startsWith('/'))

// Module memory, lost on reload by design: a fresh module re-reads every file once, and the
// seq dedupe in reduce makes that harmless. Everything drawn or announced lives in $.state.
let dirs: string[] = []
let configured: string[] = []

// No configured dir: watch <project root>/orchestra/live, resolved every tick (the session may move).
// try/catch, not .catch: on a build without session.root the call throws synchronously, and a
// rejected promise handler never sees that (CLI 2.1.294 measured: the pane said "tick never").
async function projectDirs($: $): Promise<string[]> {
  for (const ask of [() => $.session.root(), () => $.session.cwd()]) {
    try {
      const path = await ask()
      if (typeof path === 'string' && path.startsWith('/')) return [`${path.replace(/\/+$/, '')}/orchestra/live`]
    } catch {}
  }
  return []
}
const seen = new Map<string, string>()
let isBusy = false
let lastStatus: string | undefined | null = null

async function announce($: $, run: OcliRun) {
  const text = `ocli: ${run.cli}/${run.role} ${run.task} ${run.status}${run.exitCode === null ? '' : ` (exit ${run.exitCode})`}`
  // A developer out of quota must reach the person even away from the terminal. $.ui.notify is
  // declared by the 2.1.295 types but undefined on the 2.1.294 runtime (it throws a TypeError), and
  // sends nothing where no terminal is bound (the desktop): a toast says it then.
  if (run.status === 'blocked') {
    try {
      if ((await $.ui.notify(text, { title: 'ocli' })).isSent) return
    } catch {
      // fall through to the toast
    }
  }
  $.ui.toast(text)
}

async function scan($: $, now: number, meta: Omit<OcliMeta, 'lastTickAt'>) {
  const events: OcliEvent[] = []
  let files = 0
  // A dir that cannot be listed costs one error and is skipped: it must not drop what other dirs gave.
  const list = (path: string): Promise<FsEntry[]> => $.fs.list(path).catch(() => {
    meta.errors += 1
    return []
  })
  for (const dir of dirs) {
    let root: string | undefined
    try {
      root = (await $.fs.stat(dir, { resolve: true })).realPath
    } catch {
      root = undefined
    }
    meta.dirs.push({ path: clean(dir), isMissing: root === undefined })
    if (root === undefined) continue
    for (const task of await list(dir)) {
      if (task.kind !== 'dir' || task.isLink) continue
      const taskName = clean(task.name, 120)
      for (const file of await list(`${dir}/${task.name}`)) {
        if (file.kind !== 'file' || file.isLink || !file.name.endsWith('.jsonl') || file.name.endsWith('.raw.jsonl')) continue
        if (++files > MAX_FILES) {
          meta.skipped += 1
          continue
        }
        const path = `${dir}/${task.name}/${file.name}`
        if (file.size > MAX_BYTES) {
          meta.tooLarge.push(clean(`${task.name}/${file.name}`))
          continue
        }
        const signature = `${file.size}:${file.mtimeMs}`
        if (seen.get(path) === signature) continue
        try {
          const stat = await $.fs.stat(path, { resolve: true })
          seen.set(path, signature)
          if (stat.isLink || !stat.realPath?.startsWith(`${root}/`)) continue
          const text = String(await $.fs.read(path))
          // ponytail: $.fs.read cannot refuse a link, so a swap after the check (of the file or a dir
          // above it) is caught here, after the read, as a moved realPath; a swap and a swap back
          // within one read still slips through, since the API has no no-follow open.
          if ((await $.fs.stat(path, { resolve: true })).realPath !== stat.realPath) continue
          // A file speaks only for its own run: <task>/<runId>.jsonl, as dispatch.mjs writes it.
          const runId = file.name.slice(0, -'.jsonl'.length)
          const parsed = parseLines(text).filter(e => e.runId === runId && e.task === taskName)
          // ponytail: an old file is read once per module load to learn it ended.
          if (now - file.mtimeMs > DAY_MS && parsed.some(e => e.kind === 'run.end')) continue
          events.push(...parsed)
        } catch {
          seen.delete(path)
          meta.errors += 1
        }
      }
    }
  }
  return events
}

async function tick($: $) {
  if (isBusy) return
  isBusy = true
  const prev = await read($, metaAtom).catch(() => null)
  const meta = { errors: prev?.errors ?? 0, tooLarge: [] as string[], dirs: [] as OcliDir[], skipped: 0 }
  let now: number | null = null
  try {
    now = await $.clock.now()
    if (configured.length === 0) {
      const next = await projectDirs($)
      // The session moved to another project: its runs no longer update here, so drop them, and
      // prime again so the new project's already-ended runs are not announced as news.
      if (next.join('\n') !== dirs.join('\n')) {
        if (dirs.length) {
          await update($, runsAtom, () => [])
          await update($, primedAtom, () => false)
        }
        seen.clear()
        dirs = next
      }
    }
    const events = await scan($, now, meta)
    const runs = events.length ? await update($, runsAtom, list => reduce(list, events)) : await read($, runsAtom)

    const notified = new Set(await read($, notifiedAtom))
    const fresh = runs.filter(run => isEnded(run.status) && !notified.has(runKey(run)))
    const isPrimed = await read($, primedAtom)
    if (fresh.length) await update($, notifiedAtom, list => [...list, ...fresh.map(runKey)])
    if (!isPrimed) await update($, primedAtom, () => true)
    else {
      // Blocked first: it is the one the lead must act on. The rest of a burst is one summary toast.
      const order = [...fresh].sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked'))
      for (const run of order.slice(0, MAX_TOASTS)) await announce($, run).catch(() => (meta.errors += 1))
      if (order.length > MAX_TOASTS) $.ui.toast(`ocli: +${order.length - MAX_TOASTS} more runs ended`)
    }

    const running = runs.filter(run => displayStatus(run, now!) === 'running').length
    const status = running ? `ocli: ${running} running` : undefined
    if (status !== lastStatus) $.ui.status(status)
    lastStatus = status
  } catch {
    meta.errors += 1
    // What this tick read may never have reached $.state: read every file again next tick (seq dedupe).
    seen.clear()
  } finally {
    await update($, metaAtom, () => ({ ...meta, lastTickAt: now })).catch(() => undefined)
    isBusy = false
  }
}

export const register: Register = (on, options) => {
  configured = liveDirsOf(options.liveDirs)
  dirs = configured

  on('session.start', async ($, e, next) => {
    // The timer first: nothing after it can stop the pane from ticking.
    $.clock.every(TICK_MS, () => void tick($))
    await $.command.register({ name: 'ocli', description: 'Show live developer-CLI runs (orchestra) in a pane' })
    void $.ui.open({ id: PANE, title: 'ocli' }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ocli' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'ocli' })
    return { text: opened.isPlaced ? 'ocli pane opened.' : `ocli pane waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Every surface's table has Button (Box, Text, Button, Link, Code, Markdown are common to all).
    const { Box, Text, Button } = $.ui.resolve(e)
    const runs = await read($, runsAtom)
    const meta = await read($, metaAtom)
    const expanded = await read($, expandedAtom)
    const now = await $.clock.now()
    const columns = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(3, e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24)
    // Inside a card: its round border and one column of padding on each side.
    const inner = columns - 4
    let agents: AgentInfo[] | null
    try {
      agents = await $.agent.list()
    } catch {
      agents = null
    }

    type Line = { key: string; text: string; color?: string; isDim?: boolean; isBold?: boolean }
    const head: Line[] = []
    for (const dir of meta.dirs) if (dir.isMissing) head.push({ key: `missing:${dir.path}`, text: fit(`no live dir: ${dir.path}`, columns), color: 'warning' })
    if (meta.tooLarge.length === 1) head.push({ key: 'big', text: fit(`⚠ ${meta.tooLarge[0]} too large`, columns), color: 'warning' })
    else if (meta.tooLarge.length > 1) head.push({ key: 'big', text: fit(`⚠ ${meta.tooLarge.length} files too large: ${meta.tooLarge.join(', ')}`, columns), color: 'warning' })
    if (meta.skipped) head.push({ key: 'skipped', text: `⚠ too many live files: ${meta.skipped} skipped`, color: 'warning' })
    if (runs.length === 0 && meta.dirs.some(dir => !dir.isMissing)) head.push({ key: 'empty', text: 'no runs yet', isDim: true })

    const tasks = new Map<string, OcliRun[]>()
    for (const run of runs) {
      const list = tasks.get(run.task)
      if (list) list.push(run)
      else tasks.set(run.task, [run])
    }
    // Each task card in every form it can take; the first that fits is drawn (cardVariants).
    const cards: Card[][] = [...tasks]
      .map(([task, list]) => [latestAt(list), task, list] as const)
      .sort((a, b) => b[0] - a[0])
      .map(([, task, list]) => cardVariants(task, list, now, inner, expanded))

    const agentRows: Row[] = [{ kind: 'text', key: 'agents', text: 'Claude subagents', isBold: true }]
    if (agents === null) agentRows.push({ kind: 'text', key: 'agents:none', text: 'unavailable', isDim: true })
    else if (agents.length === 0) agentRows.push({ kind: 'text', key: 'agents:none', text: 'none', isDim: true })
    for (const agent of agents ?? []) {
      const text = `${clean(agent.id, 40)} ${clean(agent.type, 40)} ${agent.status} ${clean(agent.description)}`
      agentRows.push({ kind: 'text', key: `agent:${clean(agent.id, 64)}`, text: fit(text, inner), isDim: agent.status !== 'running' })
    }
    cards.push([{ key: 'agents', rows: agentRows, height: agentRows.length + 2 }])

    const tickAt = meta.lastTickAt === null ? 'never' : new Date(meta.lastTickAt).toISOString().slice(11, 19)
    const footer: Line = {
      key: 'footer', isDim: true,
      text: fit(`${meta.dirs.length} dir${meta.dirs.length === 1 ? '' : 's'} · tick ${tickAt} · errors ${meta.errors}`, columns),
    }
    // Lines above the cards and the footer are never cut; cards are drawn whole or not at all.
    const fitted = fitCards(cards, rows - 1 - head.length)
    // The subagents card is the last one; the row for this line was kept by fitCards.
    const isAgentsCut = fitted.cut.includes(cards.length - 1)
    const cutTasks = fitted.cut.length - (isAgentsCut ? 1 : 0)
    const more = [cutTasks ? `+${cutTasks} more task${cutTasks === 1 ? '' : 's'}` : '', isAgentsCut ? 'subagents hidden' : ''].filter(Boolean).join(' · ')

    // A press acts on what is drawn: a phase drawn closed opens and becomes the newest expansion (the
    // one cardVariants keeps longest), one drawn open closes, whatever the stored list says.
    const toggle = (key: string, isDrawnOpen: boolean) => update($, expandedAtom, list => {
      const rest = list.filter(k => k !== key)
      return isDrawnOpen ? rest : [...rest, key].slice(-MAX_EXPANDED)
    })
    const text = (line: Line | Extract<Row, { kind: 'text' }>) => (
      <Text key={line.key} color={line.color} dimColor={line.isDim} bold={line.isBold} wrap="truncate-end">
        {line.text}
      </Text>
    )
    const row = (r: Row) => {
      if (r.kind === 'text') return text(r)
      if (r.kind === 'split') {
        return (
          <Box key={r.key} flexDirection="row">
            <Text bold={r.isBold} wrap="truncate-end">{r.left}</Text>
            <Text dimColor wrap="truncate-end">{r.right}</Text>
          </Box>
        )
      }
      return (
        <Box key={`row:${r.key}`} flexDirection="row">
          {/* The 2.1.294 runtime refuses Text children in a Button (the types allow them): the dots sit beside it. */}
          <Button key={r.key} label={r.prefix.trimEnd()} plain onPress={() => toggle(r.open, r.isOpen)} />
          <Text> </Text>
          {r.dots.map((color, i) => <Text key={`dot:${i}`} color={color}>●</Text>)}
          <Text dimColor wrap="truncate-end">{r.tail}</Text>
          <Text dimColor wrap="truncate-end">{r.right}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {head.map(text)}
        {fitted.shown.map(c => (
          <Box key={c.key} flexDirection="column" borderStyle="round" borderColor={c.color} paddingX={1}>
            {c.rows.map(row)}
          </Box>
        ))}
        {more ? text({ key: 'more', text: more, isDim: true }) : null}
        {text(footer)}
      </Box>
    )
  })
}
