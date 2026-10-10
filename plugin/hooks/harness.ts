// Test-only: the world beneath the plugin. The kit has no fs, so live dirs are an in-memory tree
// answered at fs.list / fs.stat / fs.read; the clock is the kit's mock clock.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export type Node = {
  kind: 'file' | 'dir' | 'other'
  text?: string
  size?: number
  mtimeMs?: number
  isLink?: boolean
  realPath?: string
}

export const ROOT = '/live'
export const NOW = Date.parse('2026-10-10T12:30:00.000Z')
export const OPTIONS = { options: { liveDirs: ROOT } }

const sizeOf = (node: Node) => node.size ?? node.text?.length ?? 0

export function harness(on: On) {
  const fs = new Map<string, Node>([[ROOT, { kind: 'dir' }]])
  const calls = {
    toast: [] as string[],
    status: [] as (string | undefined)[],
    read: [] as string[],
    open: [] as unknown[],
  }
  /** Paths whose fs.list rejects (EACCES), as a dir that cannot be read. */
  const failList = new Set<string>()
  /** Called after fs.stat answers: a test swaps the tree here to race the read that follows. */
  const hooks = { afterStat: (_path: string, _resolve: boolean) => {} }
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    calls.open.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.status', ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    calls.toast.push(e.text)
    return { value: undefined }
  })
  // No ui.notify hook: on the 2.1.294 runtime `on('ui.notify')` stops this module loading
  // ("is not an event") and $.ui.notify is undefined, so the plugin's blocked notice lands as a toast.
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'Explore', status: 'running', description: 'scan the repo' }],
  }))
  on('fs.stat', ($, e) => {
    const node = fs.get(e.path)
    if (!node) throw new Error(`ENOENT ${e.path}`)
    const stat = { kind: node.kind, size: sizeOf(node), mtimeMs: node.mtimeMs ?? 0, isLink: node.isLink ?? false }
    hooks.afterStat(e.path, e.resolve === true)
    return { value: e.resolve ? { ...stat, realPath: node.realPath ?? e.path } : stat }
  })
  on('fs.list', ($, e) => {
    if (failList.has(e.path)) throw new Error(`EACCES ${e.path}`)
    if (fs.get(e.path)?.kind !== 'dir') throw new Error(`ENOENT ${e.path}`)
    const entries = []
    for (const [path, node] of fs) {
      const name = path.slice(e.path.length + 1)
      if (!path.startsWith(`${e.path}/`) || name.includes('/')) continue
      const isFile = node.kind === 'file' && !node.isLink
      entries.push({
        name,
        kind: node.isLink ? ('other' as const) : node.kind,
        size: isFile ? sizeOf(node) : 0,
        mtimeMs: isFile ? (node.mtimeMs ?? 0) : 0,
        isLink: node.isLink ?? false,
      })
    }
    return { value: entries }
  })
  on('fs.read', ($, e) => {
    calls.read.push(e.path)
    const node = fs.get(e.path)
    if (node?.text === undefined) throw new Error(`EISDIR or ENOENT ${e.path}`)
    return { value: node.text }
  })

  const put = (path: string, lines: readonly string[], node: Partial<Node> = {}) => {
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!fs.has(dir)) fs.set(dir, { kind: 'dir' })
    }
    fs.set(path, { kind: 'file', text: lines.join('\n') + (lines.length ? '\n' : ''), mtimeMs: clock.now(), ...node })
  }

  return {
    fs,
    failList,
    hooks,
    calls,
    clock,
    put,
    start: ($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }) =>
      $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }),
    tick: () => clock.advance(2000),
  }
}

/** One run's lines in the live-file contract, `at` one second apart from `start`. */
export function runLines(runId: string, events: readonly Record<string, unknown>[], start = NOW, extra: Record<string, unknown> = {}) {
  return events.map((event, seq) =>
    JSON.stringify({ v: 1, runId, seq, at: new Date(start + seq * 1000).toISOString(), task: 'task-a', role: 'implement', cli: 'codex', ...extra, ...event }),
  )
}

export const PANE_PROPS = {
  title: 'ocli',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
