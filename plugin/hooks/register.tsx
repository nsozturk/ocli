import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, FsEntry, Register } from 'claude-code'

import type { Checkpoint, OcliDir, OcliMeta, OcliPlan, OcliRun } from '../types'

type OcliCheckpoint = Checkpoint & { mtimeMs: number; root: string }
import { CHECKPOINT_NAME, checkpointCard, checkpointDrift, cardVariants, clean, displayStatus, fit, fitCards, foldPlan, HEADER_HEIGHT, isEnded, isLooping, latestAt, parseCheckpoint, parseLines, phaseOf, reduce, resumePrompt, runKey } from './reduce'
import type { Card, OcliEvent, Row } from './reduce'

const PANE = 'ocli'
const DIGEST_PANE = 'ocli-digest'
// What one Markdown draws at most: the engine's 100000-character limit counts the whole drawing
// (the Copy label too: 100000 here drew "… 4 more characters, not drawn"), so some room is left.
const MAX_DIGEST = 99_900
const TICK_MS = 2000
const DAY_MS = 24 * 3_600_000
// The engine rejects a $.fs.read over 4 MiB, so the 5 MB cap the lead set is tightened to 4 MiB.
const MAX_BYTES = 4 * 1024 * 1024
// Bounds what one tick reads, keeps in $.state and draws: a CLI under --yolo can create files here.
const MAX_FILES = 500
const MAX_TOASTS = 3
// Expanded phase rows kept in $.state; the oldest are forgotten past this.
const MAX_EXPANDED = 200
// A plan is at most 50 names of 40 code points: 64 KiB is room to spare.
const MAX_PLAN_BYTES = 64 * 1024
const MAX_CHECKPOINT_BYTES = 256 * 1024
// Dated checkpoints read, newest first, to find one with a resume command.
const MAX_CHECKPOINTS = 10
// The checkpoint is read on the first tick and every 30th after it: about once a minute.
const CHECKPOINT_TICKS = 30
const DATED = /^\d{4}-\d{2}-\d{2}/

const runsAtom = atom({ plugin: 'ocli-monitor', key: 'runs' } as const, [] as OcliRun[])
const metaAtom = atom({ plugin: 'ocli-monitor', key: 'meta' } as const, { dirs: [], lastTickAt: null, errors: 0, tooLarge: [], skipped: 0 } as OcliMeta)
const notifiedAtom = atom({ plugin: 'ocli-monitor', key: 'notified' } as const, [] as string[])
/** A run's "may be looping" key in notifiedAtom: `loop/` + its runKey has two `/`, an end key one. */
const loopKey = (run: OcliRun): string => `loop/${runKey(run)}`
const primedAtom = atom({ plugin: 'ocli-monitor', key: 'primed' } as const, false)
const expandedAtom = atom({ plugin: 'ocli-monitor', key: 'expanded' } as const, [] as string[])
// A list, not a record keyed by task: a task dir named `__proto__` must not reach a prototype
// (measured: a record with that key never drew under the kit).
const plansAtom = atom({ plugin: 'ocli-monitor', key: 'plans' } as const, [] as OcliPlan[])
const checkpointAtom = atom({ plugin: 'ocli-monitor', key: 'checkpoint' } as const, null as OcliCheckpoint | null)
const digestAtom = atom({ plugin: 'ocli-monitor', key: 'digest' } as const, '')

/** Each listed plan by task as one tick saw it; null when unreadable or malformed (not drawn). */
type Found = Map<string, OcliPlan | null>

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
async function projectRoot($: $): Promise<string | null> {
  for (const ask of [() => $.session.root(), () => $.session.cwd()]) {
    try {
      const path = await ask()
      if (typeof path === 'string' && path.startsWith('/')) return path.replace(/\/+$/, '')
    } catch {}
  }
  return null
}
const seen = new Map<string, string>()
/** A plan.json as last read: its `size:mtimeMs` (null: read again next tick) and what it parsed to. */
type CachedPlan = { signature: string | null; plan: OcliPlan | null }
// Each plan listed on the last scan, by path, rebuilt every scan: an unchanged plan is taken from
// here, never from $.state, and a plan whose dir could not be listed is carried over (a failed
// listing never drops it, not even for that tick). A plan no longer listed is forgotten.
let planCache = new Map<string, CachedPlan>()
let isBusy = false
let ticks = 0
let lastStatus: string | undefined | null = null
// The root the checkpoint was last loaded for (undefined: never), and what that load settled on: the
// root and the candidates' names, sizes and mtimes. An unchanged listing is not read again, so a
// refused file costs one error per change, not one a minute.
let checkpointRoot: string | null | undefined
let checkpointSeen: string | null = null

const DIGEST_CUT = '\n\n… cut: the digest is longer than this pane holds, so its end (Needs a decision) may be missing; run node <plugin root>/bin/digest.mjs for all of it'

/** bin/digest.mjs's markdown, made safe for the pane: each line cleaned on its own (clean()
 * folds newlines, so the whole text through it would be one line), at most MAX_DIGEST in all. A cut
 * (by the runtime, `truncated`, or here) ends in a line that says so: the decisions come last. */
export const digestText = (stdout: string, truncated = false): string => {
  const text = [...String(stdout).split('\n').map(line => clean(line, 500)).join('\n').trimEnd()]
  if (!truncated && text.length <= MAX_DIGEST) return text.join('')
  return `${text.slice(0, MAX_DIGEST - [...DIGEST_CUT].length).join('')}${DIGEST_CUT}`
}

/** The plugin's own digest script, <plugin root>/bin/digest.mjs (a byte-identical copy of the
 * checkout's dispatcher/digest.mjs, so a marketplace install that caches plugin/ alone has it), never
 * the session's project's: a clone's code is never run. Null when the runtime gives no absolute
 * plugin root. */
export const digestScript = (root: unknown): string | null =>
  typeof root === 'string' && root.startsWith('/') ? `${root.replace(/\/+$/, '')}/bin/digest.mjs` : null

/** /ocli-digest: run the digest script and draw what it printed in its own pane. Never submits a prompt. */
async function runDigest($: $): Promise<{ text: string }> {
  let text: string
  // One try around all of it: $.process missing on a runtime throws synchronously, a reject lands here too.
  try {
    const root = await projectRoot($)
    if (!root) throw new Error('no project root')
    // The script comes from the plugin; the project gives only the data it reads (read-only).
    const script = digestScript($.plugin.root)
    if (!script) throw new Error('plugin root unknown')
    const ran = await $.process.run(['node', script, '--root', `${root}/orchestra`], { timeoutMs: 20000 })
    if (ran.exitCode !== 0) throw new Error(`digest exited ${ran.exitCode}${ran.stderr.trim() ? `: ${ran.stderr.trim().split('\n').at(-1)}` : ''}`)
    text = digestText(ran.stdout, ran.isStdoutTruncated === true)
    if (!text) throw new Error('digest printed nothing')
  } catch (error) {
    return { text: `ocli digest unavailable: ${clean(error instanceof Error ? error.message : String(error), 200) || 'unknown error'}` }
  }
  await update($, digestAtom, () => text)
  const opened = await $.ui.open({ id: DIGEST_PANE, title: 'ocli digest' }).catch(() => ({ isPlaced: false as const, reason: 'open failed' }))
  return { text: opened.isPlaced ? 'ocli digest opened.' : `ocli digest waits: ${clean(String(opened.reason), 120)}` }
}

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

/** The file at `path`, only if it resolves under `root` and is not a link, before and after the read
 * (null otherwise). Throws when it cannot be read. */
async function readUnder($: $, path: string, root: string): Promise<string | null> {
  const stat = await $.fs.stat(path, { resolve: true })
  if (stat.isLink || !stat.realPath?.startsWith(`${root}/`)) return null
  const text = String(await $.fs.read(path))
  // ponytail: $.fs.read cannot refuse a link, so a swap after the check (of the file or a dir
  // above it) is caught here, after the read, as a moved realPath; a swap and a swap back
  // within one read still slips through, since the API has no no-follow open.
  return (await $.fs.stat(path, { resolve: true })).realPath === stat.realPath ? text : null
}

async function scan($: $, now: number, meta: Omit<OcliMeta, 'lastTickAt'>, plans: Found) {
  const events: OcliEvent[] = []
  let files = 0
  const kept = new Map<string, CachedPlan>()
  const keep = (path: string, cached: CachedPlan | undefined) => {
    if (!cached) return
    kept.set(path, cached)
    if (cached.plan) plans.set(cached.plan.task, cached.plan)
  }
  // A dir that cannot be listed costs one error and is skipped: it must not drop what other dirs
  // gave, nor its own plans (null: the caller carries them).
  const list = (path: string): Promise<FsEntry[] | null> => $.fs.list(path).catch(() => {
    meta.errors += 1
    return null
  })
  const carry = (prefix: string) => {
    for (const [path, cached] of planCache) if (path.startsWith(prefix) && (!cached.plan || now - cached.plan.at <= DAY_MS)) keep(path, cached)
  }
  for (const dir of dirs) {
    let root: string | undefined
    try {
      root = (await $.fs.stat(dir, { resolve: true })).realPath
    } catch {
      root = undefined
    }
    meta.dirs.push({ path: clean(dir), isMissing: root === undefined })
    if (root === undefined) continue
    const tasks = await list(dir)
    if (tasks === null) carry(`${dir}/`)
    for (const task of tasks ?? []) {
      if (task.kind !== 'dir' || task.isLink) continue
      const taskName = clean(task.name, 120)
      const entries = await list(`${dir}/${task.name}`)
      if (entries === null) {
        carry(`${dir}/${task.name}/`)
        continue
      }
      // The task's declared phases (dispatch.mjs --declare-phases). Like an ended run, a plan older
      // than a day is not drawn, nor one dated more than a day ahead (it would never age out).
      // ponytail: two live dirs with the same task name share one plan, the last.
      const plan = entries.find(f => f.name === 'plan.json' && f.kind === 'file' && !f.isLink && f.size <= MAX_PLAN_BYTES && Math.abs(now - f.mtimeMs) <= DAY_MS)
      const planPath = `${dir}/${task.name}/plan.json`
      const cached = planCache.get(planPath)
      // Past the cap the last plan read is kept, as runs past it keep theirs.
      if (plan && ++files > MAX_FILES) {
        meta.skipped += 1
        keep(planPath, cached)
      } else if (plan) {
        const signature = `${plan.size}:${plan.mtimeMs}`
        if (cached?.signature === signature) keep(planPath, cached)
        else {
          try {
            const text = await readUnder($, planPath, root)
            const phases = text === null ? null : foldPlan(text)
            // Kept with its signature even when malformed: one error per change of the file, not per tick.
            if (text !== null && phases === null) meta.errors += 1
            // Ordered as read now at the latest: a future mtime does not hold the top of the pane.
            keep(planPath, { signature, plan: phases && { task: taskName, phases, at: Math.min(plan.mtimeMs, now) } })
          } catch {
            // The last plan read stays drawn, and the file is read again next tick.
            meta.errors += 1
            keep(planPath, { signature: null, plan: cached?.plan ?? null })
          }
        }
      }
      for (const file of entries) {
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
          const text = await readUnder($, path, root)
          seen.set(path, signature)
          if (text === null) continue
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
  planCache = kept
  return events
}

/** The project's checkpoint into its atom: of the newest dated `<root>/checkpoints/*.md` files, the
 * first with a resume command, else the first that parses (a notes file or a feature checkpoint a
 * merge touched must not displace the lead's). No checkpoints dir, or one that is a link or lands
 * outside the root: no card, silently. Any other failure keeps the card drawn and costs one error. */
async function loadCheckpoint($: $, meta: { errors: number }, root: string | null) {
  if (root === null) return
  const dir = `${root}/checkpoints`
  try {
    const rootReal = (await $.fs.stat(root, { resolve: true })).realPath
    // Only a root listed without a checkpoints entry means there is none; how a stat failure reads
    // on this runtime is unproven, so its message is never parsed.
    const stat = await $.fs.stat(dir, { resolve: true }).catch(async (error: unknown) => {
      if ((await $.fs.list(root)).some(entry => entry.name === 'checkpoints')) throw error
      return null
    })
    // A link lands elsewhere, so a realPath equal to <real root>/checkpoints also refuses a linked dir.
    if (stat === null || rootReal === undefined || stat.realPath !== `${rootReal}/checkpoints`) {
      checkpointSeen = null
      await update($, checkpointAtom, () => null)
      return
    }
    const candidates = (await $.fs.list(dir))
      .filter(f => f.kind === 'file' && !f.isLink && f.size <= MAX_CHECKPOINT_BYTES && DATED.test(f.name) && CHECKPOINT_NAME.test(f.name))
      .sort((a, b) => b.name.slice(0, 10).localeCompare(a.name.slice(0, 10)) || b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_CHECKPOINTS)
    const signature = [root, ...candidates.map(f => `${f.name}:${f.size}:${f.mtimeMs}`)].join('\n')
    if (signature === checkpointSeen) return
    let found: OcliCheckpoint | null = null
    for (const f of candidates) {
      const text = await readUnder($, `${dir}/${f.name}`, stat.realPath)
      // Refused (a link swapped in, or outside the dir): one error, then the next candidate.
      if (text === null) meta.errors += 1
      const cp = text === null ? null : parseCheckpoint(f.name, text)
      if (cp && (!found || cp.resume)) found = { ...cp, mtimeMs: f.mtimeMs, root }
      if (cp?.resume) break
    }
    // ponytail: the lead's checkpoint is told apart only by its resume command; a feature checkpoint
    // that also has one and is newer wins.
    checkpointSeen = signature
    await update($, checkpointAtom, () => found)
  } catch {
    // A read or listing failed: the card stays, and the files are read again on the next load.
    meta.errors += 1
  }
}

async function tick($: $) {
  if (isBusy) return
  isBusy = true
  const prev = await read($, metaAtom).catch(() => null)
  const meta = { errors: prev?.errors ?? 0, tooLarge: [] as string[], dirs: [] as OcliDir[], skipped: 0 }
  let now: number | null = null
  try {
    now = await $.clock.now()
    const root = await projectRoot($)
    if (configured.length === 0) {
      const next = root === null ? [] : [`${root}/orchestra/live`]
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
    const found: Found = new Map()
    const events = await scan($, now, meta, found)
    // Only the plans listed this tick stay: a deleted plan.json leaves the card.
    await update($, plansAtom, () => [...found.values()].filter(plan => plan !== null))
    let runs = events.length ? await update($, runsAtom, list => reduce(list, events)) : await read($, runsAtom)
    // A CLI killed before run.end leaves its run stale for good: its beats (already outside the
    // 5-minute sparkline) leave $.state. The streak stays: it is small and still says what repeated.
    const isDead = (run: OcliRun) => !!run.beats && displayStatus(run, now!) === 'stale'
    if (runs.some(isDead)) runs = await update($, runsAtom, list => list.map(run => isDead(run) ? (({ beats: _, ...rest }) => rest)(run) : run))

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
      // A loop warning shares the tick's toasts with the ends; one past them waits for the next tick,
      // its key kept only once shown. A warning only: nothing here acts on the run.
      const loops = runs.filter(run => isLooping(run) && displayStatus(run, now!) === 'running' && !notified.has(loopKey(run)))
        .slice(0, Math.max(0, MAX_TOASTS - order.length))
      if (loops.length) await update($, notifiedAtom, list => [...list, ...loops.map(loopKey)])
      for (const run of loops) {
        $.ui.toast(`ocli: ${run.task}/${phaseOf(run)} ${run.cli} may be looping (${run.streak!.n}× ${clean(run.streak!.sig, 60)})`)
      }
    }

    // The session moved to another project (or lost its root): the old card goes now, and the new
    // project's checkpoint is read this tick, not up to a minute later.
    const isMoved = root !== checkpointRoot
    if (ticks++ % CHECKPOINT_TICKS === 0 || isMoved) {
      if (isMoved) {
        checkpointRoot = root
        checkpointSeen = null
        await update($, checkpointAtom, () => null)
      }
      await loadCheckpoint($, meta, root)
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
  checkpointRoot = undefined
  checkpointSeen = null

  on('session.start', async ($, e, next) => {
    // The timer first: nothing after it can stop the pane from ticking.
    $.clock.every(TICK_MS, () => void tick($))
    await $.command.register({ name: 'ocli', description: 'Show live developer-CLI runs (orchestra) in a pane' })
    void $.ui.open({ id: PANE, title: 'ocli' }).catch(() => undefined)
    // A second name, not an argument of /ocli: e.args stays free for a later --since.
    try {
      await $.command.register({ name: 'ocli-digest', description: 'Digest of the last 12 hours of developer-CLI runs (orchestra)' })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'ocli' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'ocli' })
    return { text: opened.isPlaced ? 'ocli pane opened.' : `ocli pane waits: ${opened.reason}` }
  })

  on('command.run', { command: 'ocli-digest' }, async $ => runDigest($))

  on('ui.render', { component: 'Pane', requestId: DIGEST_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const text = await read($, digestAtom)
    if (!text) return <Text dimColor>no digest yet: run /ocli-digest</Text>
    const copy = (press: { surface: Parameters<typeof $.ui.copy>[0]['surface'] }) => {
      const failed = () => $.ui.toast('ocli: the digest could not be copied')
      // The try covers a $.ui.copy missing on this runtime (a sync TypeError never reaches .catch).
      try {
        void $.ui.copy({ text, surface: press.surface }).then(result => { if (!result.isCopied) failed() }, failed)
      } catch {
        failed()
      }
    }
    return (
      <Box flexDirection="column">
        <Button label="Copy" onPress={copy} />
        {/* Markdown is not yet proven on the 2.1.294 runtime: without it, one Text per line. */}
        {Markdown ? <Markdown key="digest" text={text} /> : text.split('\n').map((line, i) => <Text key={`line:${i}`} wrap="truncate-end">{line}</Text>)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Every surface's table has Button (Box, Text, Button, Link, Code, Markdown are common to all).
    const { Box, Text, Button } = $.ui.resolve(e)
    const runs = await read($, runsAtom)
    const plans = new Map((await read($, plansAtom)).map(plan => [plan.task, plan] as const))
    const meta = await read($, metaAtom)
    const expanded = await read($, expandedAtom)
    const checkpoint = await read($, checkpointAtom)
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
    // A declared plan with no run yet is a card of its own, placed by the plan's mtime.
    for (const task of plans.keys()) if (!tasks.has(task)) tasks.set(task, [])
    // Each task card in every form it can take; the first that fits is drawn (cardVariants). Built
    // lazily: only the cards whose header form could still fit are built at all.
    const cards: (Card[] | (() => Card[]))[] = [...tasks]
      .map(([task, list]) => [list.length ? latestAt(list) : (plans.get(task)?.at ?? 0), task, list] as const)
      .sort((a, b) => b[0] - a[0])
      .map(([, task, list]) => () => cardVariants(task, list, now, inner, expanded, plans.get(task)?.phases ?? []))

    // The checkpoint leads: a reset lead (or the person in the morning) starts from it.
    if (checkpoint) {
      // The checkpoint's own write is a sign of life too: a lead whose subagents never write to the
      // live dir still rewrites it. ponytail: any live run counts, even one unrelated to the
      // running phase, so an unrelated run can hide a stall; the files say nothing that links them.
      const drift = checkpointDrift(checkpoint, Math.max(latestAt(runs), checkpoint.mtimeMs) || null, now)
      cards.unshift([checkpointCard(checkpoint, drift, inner), checkpointCard(checkpoint, drift, inner, true)])
    }
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
    const fitted = fitCards(cards, rows - 1 - head.length, HEADER_HEIGHT)
    // The subagents card is the last one; the row for this line was kept by fitCards.
    const isAgentsCut = fitted.cut.includes(cards.length - 1)
    const isCheckpointCut = checkpoint !== null && fitted.cut.includes(0)
    const cutTasks = fitted.cut.length - (isAgentsCut ? 1 : 0) - (isCheckpointCut ? 1 : 0)
    const more = [
      isCheckpointCut ? 'checkpoint hidden' : '', cutTasks ? `+${cutTasks} more task${cutTasks === 1 ? '' : 's'}` : '', isAgentsCut ? 'subagents hidden' : '',
    ].filter(Boolean).join(' · ')

    // A press acts on what is drawn: a phase drawn closed opens and becomes the newest expansion (the
    // one cardVariants keeps longest), one drawn open closes, whatever the stored list says.
    const toggle = (key: string, isDrawnOpen: boolean) => update($, expandedAtom, list => {
      const rest = list.filter(k => k !== key)
      return isDrawnOpen ? rest : [...rest, key].slice(-MAX_EXPANDED)
    })
    // Never auto-submitted: only a press queues it, and only the fixed text naming the file.
    const queueResume = () => {
      if (!checkpoint) return
      const prompt = resumePrompt(checkpoint.root, checkpoint.name)
      if (!prompt) return $.ui.toast('ocli: the project path is not plain; resume from its checkpoints dir by hand')
      const fallback = () => $.ui.toast(`ocli: copy this to resume: ${prompt}`)
      // The try covers a $.prompt missing on this runtime (a sync TypeError never reaches .catch).
      try {
        void $.prompt.submit({ text: prompt }).catch(fallback)
      } catch {
        fallback()
      }
    }
    const text = (line: Line | Extract<Row, { kind: 'text' }>) => (
      <Text key={line.key} color={line.color} dimColor={line.isDim} bold={line.isBold} wrap="truncate-end">
        {line.text}
      </Text>
    )
    const row = (r: Row) => {
      if (r.kind === 'text') return text(r)
      if (r.kind === 'button') return <Button key={r.key} label={r.label} onPress={queueResume} />
      if (r.kind === 'split') {
        return (
          <Box key={r.key} flexDirection="row">
            <Text bold={r.isBold} wrap="truncate-end">{r.left}</Text>
            <Text dimColor wrap="truncate-end">{r.right}</Text>
          </Box>
        )
      }
      // A declared phase with no run: nothing to open, so no Button; the whole row is drawn dim.
      if (r.isPending) return <Text key={`row:${r.key}`} dimColor wrap="truncate-end">{r.prefix + r.tail + r.right}</Text>
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
