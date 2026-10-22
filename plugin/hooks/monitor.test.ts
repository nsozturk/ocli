import { test, expect } from 'claude-code/testing'

import { GLM_LIVE } from './fixtures'
import { GLM_UNTIL, SNAPSHOT, snapshotText } from './quota-fixtures'
import { harness, NOW, OPTIONS, PANE_PROPS, ROOT, runLines } from './harness'
import { digestScript } from './register'
import { cells, parseLines, reduce } from './reduce'
import type { OcliRun } from '../types'

const START = { kind: 'run.start', model: 'gpt-5.6-luna' }
const end = (status: unknown) => ({ kind: 'run.end', exitCode: status === 'completed' ? 0 : 1, signal: null, ms: 5000, status, nodeId: null, score: null, dropped: {} })
const SURFACES = ['terminal', 'desktop'] as const
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

type El = { type: string; key?: string; props?: Record<string, unknown>; children?: (El | string)[] }
type Handle = {
  drawn: () => Promise<El>
  findAll: (q: { type?: string; key?: string }) => Promise<{ key: string | undefined; props: Record<string, unknown>; text: string }[]>
  press: (q: { key: string }) => Promise<unknown>
  unmount: () => Promise<void>
}
type Mountable = { ui: { mount: (target: never) => Promise<Handle> } }
const mount = ($: unknown, surface: (typeof SURFACES)[number], bodyRows = 30) => ($ as Mountable).ui.mount({
  plugin: 'ocli-monitor', surface, component: 'Pane', requestId: 'ocli',
  props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows } },
  viewport: { columns: 100, rows: bodyRows },
} as never)

const flat = (node: El | string): string =>
  typeof node === 'string' ? node : node.type === 'Button' ? String(node.props?.label ?? '') : (node.children ?? []).map(flat).join('')
/** The drawing as the rows it takes: a column Box stacks its children, a bordered one adds its two
 * border rows (drawn here as ╭ and ╰), and a Text, a Button or a row Box is one row. */
function rowsOf(node: El | string): string[] {
  if (typeof node === 'string') return [node]
  if (node.type === 'Box' && node.props?.flexDirection !== 'row') {
    const inner = (node.children ?? []).flatMap(rowsOf)
    // A margin below takes its rows too: drawn here as empty rows.
    const gap = Array<string>(Number(node.props?.marginBottom ?? 0)).fill('')
    return [...(node.props?.borderStyle ? ['╭', ...inner, '╰'] : inner), ...gap]
  }
  return [flat(node)]
}
/** Each bordered Box (a card) by its key: the rows it draws. */
/** The dot colours of each phase row, by the row's key (`row:phase:<task>/<phase>`). */
function dotsOf(node: El | string, out = new Map<string, unknown[]>()): Map<string, unknown[]> {
  if (typeof node === 'string') return out
  const key = String(node.props?.key ?? '')
  if (key.startsWith('row:phase:')) {
    out.set(key, (node.children ?? []).filter((c): c is El => typeof c !== 'string' && c.type === 'Text' && flat(c) === '●').map(c => c.props?.color))
  }
  for (const child of node.children ?? []) dotsOf(child, out)
  return out
}
function cardsOf(node: El | string, out = new Map<string, string[]>()): Map<string, string[]> {
  if (typeof node === 'string') return out
  if (node.type === 'Box' && node.props?.borderStyle) out.set(String(node.props.key), rowsOf(node))
  for (const child of node.children ?? []) cardsOf(child, out)
  return out
}
async function paneText($: unknown, surface: (typeof SURFACES)[number], bodyRows = 30) {
  const ui = await mount($, surface, bodyRows)
  const rows = rowsOf(await ui.drawn())
  await ui.unmount()
  return rows
}
/** The pane's rows after pressing the head of each task card named, on one mounted drawing. */
async function expanded($: unknown, surface: (typeof SURFACES)[number], tasks: string[], bodyRows = 30) {
  const ui = await mount($, surface, bodyRows)
  for (const task of tasks) await ui.press({ key: `card:${task}` })
  const rows = rowsOf(await ui.drawn())
  for (const task of tasks) await ui.press({ key: `card:${task}` }) // collapse again: $.state is shared across surfaces
  await ui.unmount()
  return rows
}

async function dots($: unknown) {
  const ui = await mount($, 'terminal')
  const found = [...dotsOf(await ui.drawn()).values()].flat()
  await ui.unmount()
  return found.length
}

test('session.start registers /ocli, opens the pane and ticks every 2 s', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, { kind: 'step', label: 'turn.started' }]))
  await h.start($)
  expect(h.calls.open).toEqual([{ id: 'ocli', title: 'ocli' }])
  expect(h.calls.read).toEqual([])
  await h.tick()
  expect(h.calls.read).toEqual([`${ROOT}/task-a/r1.jsonl`])
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
  const ran = await $.command.run({ command: 'ocli', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
  expect(ran.text).toContain('ocli')
})

test('pane draws a run line on terminal AND desktop, with subagents and footer', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/glm-live/00000000-0000-4000-8000-0000000000a1.jsonl`, GLM_LIVE, { mtimeMs: NOW })
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const texts = await paneText($, surface)
    const joined = texts.join('\n')
    expect(joined).toContain('glm-live')
    // GLM_LIVE is opencode: 3425600 cache reads on top of 119333 fresh input tokens (33 usage events)
    // -> 3425600 / 3544933 = 96.6%. The literal cached/input would print 2871%.
    expect(texts.filter(t => t.startsWith('  implement'))).toEqual(['  implement  ●  glm-5.3 · cache 97% · 1/1 done'])
    const open = await expanded($, surface, ['glm-live'])
    expect(open.some(t => t.startsWith('  ✓ completed · glm-5.3 (opencode) · implement · 15m54s'))).toBe(true)
    expect(open.some(t => t.startsWith('    37 tools · '))).toBe(true)
    expect(open.some(t => t.startsWith('    end: completed · exit 0 · score 1'))).toBe(true)
    expect(joined).toContain('Claude subagents')
    expect(joined).toContain('a1 Explore running scan the repo')
    expect(joined).toMatch(/^1 dir · tick /m)
    expect(joined).toMatch(/errors 0/)
  }
})

test('raw files are never read', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  h.put(`${ROOT}/task-a/r1.raw.jsonl`, runLines('r2', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.read).toEqual([`${ROOT}/task-a/r1.jsonl`])
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
})

test('blocked: announced exactly once across two ticks and a simulated reload', OPTIONS, async ($, on) => {
  const h = harness(on)
  const blocked = () => h.calls.toast.filter(t => t.includes('blocked'))
  await h.start($)
  await h.tick()
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, end('blocked')]))
  await h.tick()
  // $.ui.notify is tried first; on this 2.1.294 runtime it is undefined, so the toast carries it.
  expect(blocked()).toEqual(['ocli: codex/implement task-a blocked (exit 1)'])
  await h.tick()
  expect(blocked().length).toBe(1)
  // The kit has no reload: a fresh module re-reads every file, which a changed mtime forces here.
  h.fs.get(`${ROOT}/task-a/r1.jsonl`)!.mtimeMs = h.clock.now()
  await h.tick()
  expect(h.calls.read.filter(p => p.endsWith('r1.jsonl')).length).toBe(2)
  expect(blocked().length).toBe(1)
  expect(h.calls.toast.length).toBe(1)
})

test('a reload (fresh module, $.state kept) does not announce an end again', OPTIONS, async ($, on) => {
  const lines = runLines('r1', [START, end('blocked')])
  // What the previous module load left in $.state; this test's module starts with empty memory.
  const kept: Record<string, unknown> = { runs: reduce([], parseLines(lines.join('\n') + '\n')), notified: ['task-a/r1'], primed: true }
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    const key = (e as { key: string }).key
    return (got as { value: { version: number } }).value.version === 0 && key in kept
      ? { value: { value: kept[key], version: 0 } }
      : got
  })
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, lines)
  await h.start($)
  await h.tick()
  await h.tick()
  expect(h.calls.read).toEqual([`${ROOT}/task-a/r1.jsonl`])
  expect(h.calls.toast).toEqual([])
})

test('completed, failed and spawn-error toast once each; ends seen at the first tick are not announced', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/old.jsonl`, runLines('old', [START, end('completed')]))
  await h.start($)
  await h.tick()
  expect(h.calls.toast).toEqual([])
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, end('completed')]))
  h.put(`${ROOT}/task-a/r2.jsonl`, runLines('r2', [START, end('failed')]))
  h.put(`${ROOT}/task-b/r3.jsonl`, runLines('r3', [START, end('spawn-error')], NOW, { task: 'task-b' }))
  await h.tick()
  await h.tick()
  expect(h.calls.toast.length).toBe(3)
  expect([...h.calls.toast].sort()).toEqual([
    'ocli: codex/implement task-a completed (exit 0)',
    'ocli: codex/implement task-a failed (exit 1)',
    'ocli: codex/implement task-b spawn-error (exit 1)',
  ])
})

test('symlinks and files resolving outside the live dir are not read', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/good.jsonl`, runLines('good', [START]))
  h.put(`${ROOT}/task-a/link.jsonl`, runLines('link', [START]), { isLink: true, realPath: '/etc/x.jsonl' })
  h.put(`${ROOT}/task-a/out.jsonl`, runLines('out', [START]), { realPath: '/elsewhere/out.jsonl' })
  h.put(`${ROOT}/task-a/sib.jsonl`, runLines('sib', [START]), { realPath: `${ROOT}-evil/sib.jsonl` })
  h.fs.set(`${ROOT}/linked`, { kind: 'dir', isLink: true })
  h.put(`${ROOT}/linked/x.jsonl`, runLines('x', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.read).toEqual([`${ROOT}/task-a/good.jsonl`])
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
})

test('a file over the size cap is not read and is marked too large', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/big.jsonl`, runLines('big', [START]), { size: 5 * 1024 * 1024 })
  await h.start($)
  await h.tick()
  expect(h.calls.read).toEqual([])
  expect((await paneText($, 'terminal')).join('\n')).toContain('task-a/big.jsonl too large')
})

test('control characters and ANSI escapes from a live file never reach the drawing', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-x/r1.jsonl`, runLines('r1', [
    { kind: 'run.start', model: 'evil\u001b[2Jmodel\u0007', phase: 'pha\u001b[31mse\u202e 1\u0007' },
    { kind: 'message', text: '\u001b[2Jwipe\u0007 the\u001b]0;pwned\u0007 screen' },
  ], NOW, { task: 'task\u001b[31m-x', cli: 'co\u0007dex' }))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const texts = await paneText($, surface)
    for (const text of texts) expect(text).not.toMatch(CONTROL)
    expect(texts.join('\n')).toContain('task-x')
    expect(texts.some(t => t.includes('evilmodel'))).toBe(true)
    expect(texts.some(t => t.startsWith('  phase 1  ●'))).toBe(true)
    const open = await expanded($, surface, ['task-x'])
    for (const text of open) expect(text).not.toMatch(CONTROL)
    expect(open.some(t => t.includes('evilmodel (codex)'))).toBe(true)
    expect(open.some(t => t.includes('↳ message: wipe the screen')) && open.some(t => t.includes('says: wipe the screen'))).toBe(true)
  }
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
})

test('dispatch-error and an unknown status render as failed', OPTIONS, async ($, on) => {
  const h = harness(on)
  await h.start($)
  await h.tick()
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, end('dispatch-error')]))
  h.put(`${ROOT}/task-a/r2.jsonl`, runLines('r2', [START, end('exploded')]), {})
  await h.tick()
  for (const surface of SURFACES) {
    const runs = (await expanded($, surface, ['task-a'])).filter(t => t.includes('(codex)')).map(t => t.trimStart())
    expect(runs.length).toBe(2)
    expect(runs.every(t => t.startsWith('✗ '))).toBe(true)
    expect(runs.some(t => t.startsWith('✗ dispatch-error'))).toBe(true)
    expect(runs.some(t => t.startsWith('✗ failed'))).toBe(true)
    expect((await paneText($, surface)).some(t => t.trimEnd() === 'ocli · Failed')).toBe(true)
  }
  expect(h.calls.toast.length).toBe(2)
})

test('status line clears when nothing is running', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, end('completed')]))
  await h.tick()
  expect(h.calls.status.at(-1)).toBeUndefined()
})

test('a run silent for over 10 minutes is shown stale and not counted as running', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START], NOW - 11 * 60_000), { mtimeMs: NOW - 11 * 60_000 })
  await h.start($)
  await h.tick()
  expect(h.calls.status.at(-1)).toBeUndefined()
  expect((await paneText($, 'terminal')).some(t => t.trimEnd() === 'ocli · Stale')).toBe(true)
  expect((await expanded($, 'terminal', ['task-a'])).some(t => t.startsWith('  ◌ stale · gpt-5.6-luna (codex)'))).toBe(true)
})

test('an ended run whose file is older than 24 h is ignored', OPTIONS, async ($, on) => {
  const h = harness(on)
  const old = NOW - 25 * 3_600_000
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, end('completed')], old), { mtimeMs: old })
  h.put(`${ROOT}/task-a/r2.jsonl`, runLines('r2', [START], old), { mtimeMs: old })
  await h.start($)
  await h.tick()
  const runs = (await expanded($, 'terminal', ['task-a'])).filter(t => t.includes('(codex)'))
  expect(runs.length).toBe(1)
  expect(runs[0]).toMatch(/^ {2}◌ stale/)
})

test('a missing live dir is shown, not counted as an error', { options: { liveDirs: '/nope' } }, async ($, on) => {
  const h = harness(on)
  await h.start($)
  await h.tick()
  const joined = (await paneText($, 'desktop')).join('\n')
  expect(joined).toContain('no live dir: /nope')
  expect(joined).toMatch(/errors 0/)
})

test('a failing read is counted in the footer and never throws out of tick', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.fs.set(`${ROOT}/task-a`, { kind: 'dir' })
  h.fs.set(`${ROOT}/task-a/bad.jsonl`, { kind: 'file', size: 10, mtimeMs: NOW })
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/errors 1/)
})

test('the pane fits the rows it is given', OPTIONS, async ($, on) => {
  const h = harness(on)
  for (let i = 0; i < 40; i++) h.put(`${ROOT}/task-${i % 3}/r${i}.jsonl`, runLines(`r${i}`, [START], NOW, { task: `task-${i % 3}` }))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const texts = await paneText($, surface, 10)
    expect(texts.length).toBeLessThanOrEqual(10)
    expect(texts.join('\n')).toMatch(/more/)
    expect(texts.join('\n')).toMatch(/errors 0/)
  }
})

test('a dir that cannot be listed costs one error per tick and never drops the other dirs', { options: { liveDirs: `${ROOT},/other` } }, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  h.put(`${ROOT}/task-b/r2.jsonl`, runLines('r2', [START], NOW, { task: 'task-b' }))
  h.fs.set('/other', { kind: 'file', text: '' }) // stats fine, so it is not "missing"; fs.list rejects it
  h.failList.add(`${ROOT}/task-b`)
  await h.start($)
  await h.tick()
  await h.tick()
  expect(h.calls.status.at(-1)).toBe('ocli: 1 running')
  expect(h.calls.read).toEqual([`${ROOT}/task-a/r1.jsonl`])
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/errors 4/)
  h.failList.clear()
  await h.tick()
  expect(h.calls.status.at(-1)).toBe('ocli: 2 running')
})

test("a file's events count only for its own runId and task dir", OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/A.jsonl`, runLines('A', [START, { kind: 'step', label: 'work' }]))
  // B's own file forges A's end, and a far seq that would swallow every real A event after it.
  h.put(`${ROOT}/task-a/B.jsonl`, [
    ...runLines('B', [START]),
    JSON.stringify({ v: 1, runId: 'A', seq: 9e15, at: new Date(NOW).toISOString(), task: 'task-a', role: 'implement', cli: 'codex', kind: 'run.end', status: 'completed', exitCode: 0 }),
  ])
  // The same stem in another task dir, its lines claiming task-a: dropped.
  h.put(`${ROOT}/task-b/A.jsonl`, runLines('A', [{}, {}, {}, {}, {}, end('completed')]))
  // The same stem in another task dir, its lines naming that dir: a run of its own.
  h.put(`${ROOT}/task-c/A.jsonl`, runLines('A', [START], NOW, { task: 'task-c' }))
  await h.start($)
  await h.tick()
  expect(h.calls.status.at(-1)).toBe('ocli: 3 running')
  h.put(`${ROOT}/task-a/A.jsonl`, runLines('A', [START, { kind: 'step', label: 'work' }, end('blocked')]))
  await h.tick()
  expect(h.calls.toast).toEqual(['ocli: codex/implement task-a blocked (exit 1)'])
  expect(await dots($)).toBe(3)
})

test('one file with many runIds folds to its own run only', OPTIONS, async ($, on) => {
  const h = harness(on)
  const lines = runLines('r1', [START])
  for (let i = 0; i < 1000; i++) lines.push(JSON.stringify({ v: 1, runId: `x${i}`, seq: 0, kind: 'run.end', status: 'blocked', task: 'task-a' }))
  h.put(`${ROOT}/task-a/r1.jsonl`, lines)
  await h.start($)
  await h.tick()
  expect(await dots($)).toBe(1)
})

test('files past the per-tick cap are not read and are marked', OPTIONS, async ($, on) => {
  const h = harness(on)
  for (let i = 0; i < 501; i++) h.put(`${ROOT}/task-a/r${i}.jsonl`, runLines(`r${i}`, [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.read.length).toBe(500)
  expect((await paneText($, 'terminal')).join('\n')).toContain('too many live files: 1 skipped')
})

test('many ends in one tick: blocked first, three toasts, then one summary', OPTIONS, async ($, on) => {
  const h = harness(on)
  await h.start($)
  await h.tick()
  for (let i = 0; i < 9; i++) h.put(`${ROOT}/task-a/r${i}.jsonl`, runLines(`r${i}`, [START, end(i === 8 ? 'blocked' : 'completed')]))
  await h.tick()
  expect(h.calls.toast.length).toBe(4)
  expect(h.calls.toast[0]).toBe('ocli: codex/implement task-a blocked (exit 1)')
  expect(h.calls.toast[3]).toBe('ocli: +6 more runs ended')
})

for (const [what, swap] of [
  ['the file for a symlink', { isLink: true, realPath: '/etc/secret.jsonl' }],
  ['its task dir for a symlink', { realPath: '/elsewhere/task-a/r1.jsonl' }],
] as const) {
  test(`${what}, swapped between the check and the read, is dropped`, OPTIONS, async ($, on) => {
    const h = harness(on)
    const path = `${ROOT}/task-a/r1.jsonl`
    h.put(path, runLines('r1', [START]))
    let isSwapped = false
    h.hooks.afterStat = (p, resolve) => {
      if (p !== path || !resolve || isSwapped) return
      isSwapped = true
      h.put(path, runLines('r1', [{ kind: 'run.start', model: 'outside-secret' }]), swap)
    }
    await h.start($)
    await h.tick()
    expect(isSwapped).toBe(true)
    expect((await paneText($, 'terminal')).join('\n')).not.toContain('outside-secret')
  })
}

test('an empty liveDirs watches <project root>/orchestra/live', { options: { liveDirs: '' } }, async ($, on) => {
  const h = harness(on)
  on('session.root', () => ({ value: '/proj' }))
  h.put('/proj/orchestra/live/task-r/r9.jsonl', runLines('r9', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.read).toEqual(['/proj/orchestra/live/task-r/r9.jsonl'])
})

test('a session.root that throws falls back to session.cwd, and the tick still runs', { options: { liveDirs: '' } }, async ($, on) => {
  const h = harness(on)
  on('session.root', () => { throw new Error('session.root is not available on this build') })
  on('session.cwd', () => ({ value: '/proj' }))
  h.put('/proj/orchestra/live/task-r/r9.jsonl', runLines('r9', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.read).toEqual(['/proj/orchestra/live/task-r/r9.jsonl'])
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('tick never')
})

test('cards are cut whole at every height, the rest summed up as +N more tasks', OPTIONS, async ($, on) => {
  const h = harness(on)
  for (let i = 0; i < 6; i++) h.put(`${ROOT}/task-${i}/r${i}.jsonl`, runLines(`r${i}`, [START, { kind: 'tool.end', tool: 'bash', detail: `step ${i}`, ok: true }], NOW + i * 1000, { task: `task-${i}` }))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 200)
    const whole = cardsOf(await ui.drawn())
    await ui.unmount()
    expect(whole.size).toBe(7) // six tasks and the subagents
    for (let rows = 4; rows <= 40; rows++) {
      const ui = await mount($, surface, rows)
      const tree = await ui.drawn()
      await ui.unmount()
      const all = rowsOf(tree)
      expect(all.length).toBeLessThanOrEqual(rows)
      const cards = cardsOf(tree)
      // Whole, or (too tall even closed) its header form: the first rows of the whole card and one note.
      for (const [key, drawn] of cards) {
        if (drawn.length === whole.get(key)!.length) expect(drawn).toEqual(whole.get(key))
        else expect(drawn).toEqual([...whole.get(key)!.slice(0, 4), expect.stringMatching(/^\d+ phases? · pane too short to list them/), '╰', ''])
      }
      const tasks = [...cards.keys()].filter(key => key.startsWith('task:')).length
      if (tasks < 6) expect(all.join('\n')).toContain(`+${6 - tasks} more task`)
      // The "more" line says the subagents are hidden exactly when their card is not drawn.
      expect(all.join('\n').includes('subagents hidden')).toBe(!cards.has('agents'))
    }
  }
})

test('when the session moves to another project, the old project runs leave the pane and the new one is primed silently', { options: { liveDirs: '' } }, async ($, on) => {
  const h = harness(on)
  let root = '/a'
  on('session.root', () => ({ value: root }))
  h.put('/a/orchestra/live/task-a/ra.jsonl', runLines('ra', [START, { kind: 'run.end', exitCode: 0, signal: null, ms: 1, status: 'completed', nodeId: null, score: null, dropped: {} }], NOW, { task: 'task-a' }))
  h.put('/b/orchestra/live/task-b/rb.jsonl', runLines('rb', [START, { kind: 'run.end', exitCode: 1, signal: null, ms: 1, status: 'failed', nodeId: null, score: null, dropped: {} }], NOW, { task: 'task-b' }))
  await h.start($)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toContain('task-a')
  root = '/b'
  await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).not.toContain('task-a')
  expect(joined).toContain('task-b')
  expect(h.calls.toast).toEqual([])
})

const usage = (input: number, output: number) => ({ kind: 'usage', input, output })

/** task-p: two implement runs (codex/gpt-6-astra completed, opencode/glm-5.3 running), a review run
 * (blocked) and an old-dispatcher run with no phase, grouped by its role `reason`. */
function cardTask(h: ReturnType<typeof harness>) {
  const at = { task: 'task-p' }
  h.put(`${ROOT}/task-p/a.jsonl`, runLines('a', [{ kind: 'run.start', model: 'openai/gpt-6-astra', phase: 'implement', title: 'old' }, usage(1000, 200), end('completed')], NOW - 120_000, at))
  h.put(`${ROOT}/task-p/b.jsonl`, runLines('b', [{ kind: 'run.start', model: 'zai-coding-plan/glm-5.3', phase: 'implement', title: 'Slice 046 cards' }, { kind: 'tool.end', tool: 'bash', detail: 'npm test', ok: true }], NOW - 60_000, { ...at, cli: 'opencode' }))
  h.put(`${ROOT}/task-p/c.jsonl`, runLines('c', [{ kind: 'run.start', model: 'zai-coding-plan/glm-5.3', phase: 'review' }, end('blocked')], NOW - 90_000, at))
  h.put(`${ROOT}/task-p/d.jsonl`, runLines('d', [{ kind: 'run.start', model: 'gpt-5.6-luna' }, end('failed')], NOW - 80_000, { ...at, role: 'reason' }))
}

test('a task is one round card with a blank row under it: the ▸ toggle and span, status, runs and tokens, title, one row per phase with dots, LLMs and done count, and the running run\'s live line', OPTIONS, async ($, on) => {
  const h = harness(on)
  cardTask(h)
  await h.start($)
  await h.tick()
  await h.clock.advance(4000) // now = NOW + 6 s, the running run's last event at NOW - 59 s
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const tree = await ui.drawn()
    const box = (await ui.findAll({ type: 'Box' })).find(b => b.props.key === 'task:task-p')!
    expect(box.props).toMatchObject({ borderStyle: 'round', borderColor: 'suggestion' })
    await ui.unmount()
    expect(Object.fromEntries(dotsOf(tree))).toEqual({
      'row:phase:task-p/implement': ['success', 'suggestion'], 'row:phase:task-p/review': ['warning'], 'row:phase:task-p/reason': ['error'],
    })
    const rows = cardsOf(tree).get('task:task-p')!.map(r => r.trimEnd())
    expect(rows[1]).toMatch(/^▸ task-p +2m06s$/)
    expect(rows.slice(2, 6)).toEqual(['ocli · Running', '4 runs · 1k tokens', 'Slice 046 cards', 'Phases'])
    expect(rows[6]).toBe('  implement  ●●  gpt-6-astra, glm-5.3 · 1/2 done')
    // The running run's glanceable line: both events (NOW - 60 s, NOW - 59 s) in the third-newest 30 s cell at NOW + 6 s.
    expect(rows[7]).toBe(`    ${' '.repeat(7)}█   ↳ tool.end bash: npm test`)
    expect(rows[8]).toBe('  review  ●  glm-5.3 · 1/1 done')
    expect(rows[9]).toBe('  reason  ●  gpt-5.6-luna · 1/1 done')
    // Under its border, the blank row that parts it from the next card.
    expect(rows.slice(10)).toEqual(['╰', ''])
  }
})

test('pressing a card head expands it in place to its runs, by phase; it stays expanded in $.state across mounts; pressing again collapses', OPTIONS, async ($, on) => {
  const h = harness(on)
  cardTask(h)
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 60)
    await ui.press({ key: 'card:task-p' })
    const open = rowsOf(await ui.drawn())
    await ui.unmount()
    expect(open.some(t => t.startsWith('▾ task-p'))).toBe(true)
    const at = (prefix: string) => open.findIndex(t => t.startsWith(prefix))
    // Each run under its own phase row: implement's two, then review's.
    expect(at('  implement')).toBeLessThan(at('  ✓ completed · gpt-6-astra (codex) · implement'))
    expect(at('  ✓ completed · gpt-6-astra (codex)')).toBeLessThan(at('  ● running · glm-5.3 (opencode) · implement'))
    expect(at('  ● running · glm-5.3 (opencode)')).toBeLessThan(at('  review'))
    expect(at('  review')).toBeLessThan(at('  ⊘ blocked · glm-5.3 (codex) · implement'))
    // What it is for (no brief from this dispatcher: the title), its tool call and its live line.
    expect(open.some(t => t === '    Slice 046 cards')).toBe(true)
    expect(open.some(t => t === '    ✓ bash: npm test')).toBe(true)
    expect(open.filter(t => t.includes('↳ tool.end bash: npm test')).length).toBe(1)
    // A fresh drawing (another mount, as after a reload) reads the expanded set from $.state.
    const again = await mount($, surface, 60)
    expect(rowsOf(await again.drawn()).some(t => t.startsWith('▾ task-p'))).toBe(true)
    await again.press({ key: 'card:task-p' })
    const closed = rowsOf(await again.drawn())
    await again.unmount()
    expect(closed.some(t => t.startsWith('▸ task-p'))).toBe(true)
    expect(closed.some(t => t.includes('(codex)'))).toBe(false)
  }
})

test('runs kept in $.state by 0.1.x (no phase) still draw, grouped by role', OPTIONS, async ($, on) => {
  const lines = runLines('r1', [START, end('completed')])
  const old = reduce([], parseLines(lines.join('\n') + '\n')).map(run => {
    const copy = { ...run } as Record<string, unknown>
    delete copy.phase
    return copy
  })
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    return (got as { value: { version: number } }).value.version === 0 && (e as { key: string }).key === 'runs'
      ? { value: { value: old, version: 0 } }
      : got
  })
  const h = harness(on)
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const rows = await paneText($, surface)
    expect(rows.some(t => t === '  implement  ●  gpt-5.6-luna · 1/1 done')).toBe(true)
  }
})

test('the expanded set is read from $.state: a drawing after a reload opens what was open; a 0.3 phase key opens nothing', OPTIONS, async ($, on) => {
  let stored = ['task-p']
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    return (got as { value: { version: number } }).value.version === 0 && (e as { key: string }).key === 'expanded'
      ? { value: { value: stored, version: 0 } }
      : got
  })
  const h = harness(on)
  cardTask(h)
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const rows = await paneText($, surface, 60)
    expect(rows.some(t => t.startsWith('▾ task-p'))).toBe(true)
    expect(rows.some(t => t.startsWith('  ⊘ blocked · glm-5.3 (codex)'))).toBe(true)
  }
  stored = ['task-p/review']
  const rows = await paneText($, 'terminal', 60)
  expect(rows.some(t => t.startsWith('▸ task-p'))).toBe(true)
  expect(rows.some(t => t.includes('(codex)'))).toBe(false)
})

test('a press acts on what is drawn: when two open cards do not fit, the newest press survives and pressing the closed one opens it', OPTIONS, async ($, on) => {
  const h = harness(on)
  for (const [i, task] of ['task-q', 'task-q', 'task-q', 'task-r', 'task-r', 'task-r'].entries()) {
    h.put(`${ROOT}/${task}/q${i}.jsonl`, runLines(`q${i}`, [{ kind: 'run.start', model: 'openai/gpt-6-astra', phase: 'A', title: `slice ${i}` }, end('completed')], NOW - 60_000 + i * 1000, { task }))
  }
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const tall = await mount($, surface, 200)
    await tall.press({ key: 'card:task-q' })
    const onlyQ = rowsOf(await tall.drawn()).length
    await tall.press({ key: 'card:task-r' }) // $.state now holds q then r
    await tall.unmount()
    const ui = await mount($, surface, onlyQ) // room for one open card, not two
    const before = rowsOf(await ui.drawn())
    expect(before.length).toBeLessThanOrEqual(onlyQ)
    expect(before.some(t => t.startsWith('▾ task-r'))).toBe(true)
    expect(before.some(t => t.startsWith('▸ task-q'))).toBe(true)
    await ui.press({ key: 'card:task-q' })
    const after = rowsOf(await ui.drawn())
    expect(after.some(t => t.startsWith('▾ task-q'))).toBe(true)
    expect(after.some(t => t.startsWith('▸ task-r'))).toBe(true)
    // Pressing what is drawn open closes it: q, then r, leaves nothing expanded for the next surface.
    await ui.press({ key: 'card:task-q' })
    expect(rowsOf(await ui.drawn()).some(t => t.startsWith('▾ task-r'))).toBe(true)
    await ui.press({ key: 'card:task-r' })
    expect(rowsOf(await ui.drawn()).some(t => t.startsWith('▾'))).toBe(false)
    await ui.unmount()
  }
})

// --- declared phases (plan.json beside the run files) -------------------------------------------

const planText = (...names: string[]) => [JSON.stringify({ v: 1, phases: names.map(name => ({ name })), declaredAt: new Date(NOW).toISOString() })]
const PHASED = (phase: string) => ({ kind: 'run.start', model: 'zai-coding-plan/glm-5.3', phase })
/** The drawn element with this key (`props.key`). */
function byKey(node: El | string, key: string): El | undefined {
  if (typeof node === 'string') return undefined
  if (node.props?.key === key) return node
  for (const child of node.children ?? []) {
    const found = byKey(child, key)
    if (found) return found
  }
  return undefined
}

test('a plan beside a run file: declared phases drawn first, a pending one dim with 0/0, the count row D/M phases', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [PHASED('implement'), end('completed')], NOW - 60_000))
  h.put(`${ROOT}/task-a/r2.jsonl`, runLines('r2', [PHASED('hotfix')], NOW - 30_000))
  h.put(`${ROOT}/task-a/plan.json`, planText('implement', 'review', 'merge'))
  await h.start($)
  await h.tick()
  await h.tick()
  // Read once: an unchanged plan is not read again.
  expect(h.calls.read.filter(p => p.endsWith('plan.json'))).toEqual([`${ROOT}/task-a/plan.json`])
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const tree = await ui.drawn()
    await ui.unmount()
    const rows = cardsOf(tree).get('task:task-a')!.map(r => r.trimEnd())
    expect(rows).toContain('2 runs · ? tokens · 1/4 phases')
    const phases = rows.filter(r => /^ {2}\S/.test(r))
    expect(phases.map(r => r.split(/\s+/)[1])).toEqual(['implement', 'review', 'merge', 'hotfix'])
    expect(phases[1]).toBe('  review  declared · 0/0 done')
    expect(phases[0]).toMatch(/1\/1 done$/)
    // The pending row is one dim Text, its name included: no Button (phase rows open nothing).
    const all = (n: El | string | undefined): El[] => (!n || typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(all)])
    const named = all(tree).filter(n => /^ {2}review\b/.test(flat(n)) && n.type !== 'Box')
    expect(named.map(n => [n.type, n.props?.dimColor])).toEqual([['Text', true]])
    expect(flat(named[0]!).trimEnd()).toBe('  review  declared · 0/0 done')
    const ran = byKey(tree, 'row:phase:task-a/implement')!
    expect((ran.children ?? []).some(c => typeof c !== 'string' && c.type === 'Text' && !c.props?.dimColor)).toBe(true)
  }
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/errors 0/)
})

test('a plan with no runs yet is a card of its own, ordered by the plan mtime', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [PHASED('implement')], NOW - 60_000))
  h.put(`${ROOT}/task-old/plan.json`, planText('a', 'b'), { mtimeMs: NOW - 120_000 })
  h.put(`${ROOT}/task-new/plan.json`, planText('x'), { mtimeMs: NOW - 1000 })
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 40)
    const tree = await ui.drawn()
    const box = (await ui.findAll({ type: 'Box' })).find(b => b.props.key === 'task:task-new')!
    expect(box.props.borderColor).toBeUndefined()
    await ui.unmount()
    const cards = cardsOf(tree)
    expect([...cards.keys()]).toEqual(['task:task-new', 'task:task-a', 'task:task-old', 'agents'])
    expect(cards.get('task:task-new')!.map(r => r.trimEnd())).toEqual(expect.arrayContaining(['ocli · Declared', '0 runs · ? tokens · 0/1 phases', '  x  declared · 0/0 done']))
  }
})

test('a malformed plan costs one footer error, once; the pane still draws; a fixed plan draws, a deleted one goes', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [PHASED('implement')]))
  h.put(`${ROOT}/task-a/plan.json`, ['{"v":1,"phases":['])
  await h.start($)
  await h.tick()
  await h.tick()
  await h.tick()
  for (const surface of SURFACES) {
    const joined = (await paneText($, surface)).join('\n')
    expect(joined).toMatch(/errors 1/)
    expect(joined).toMatch(/^ {2}implement {2}● {2}glm-5\.3 · 0\/1 done$/m)
    expect(joined).not.toContain('phases ·')
    expect(joined).toMatch(/^1 run · \? tokens$/m)
  }
  h.put(`${ROOT}/task-a/plan.json`, planText('implement', 'review'), { mtimeMs: NOW + 5000 })
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^ {2}review {2}declared · 0\/0 done$/m)
  h.fs.delete(`${ROOT}/task-a/plan.json`)
  await h.tick()
  const joined = (await paneText($, 'desktop')).join('\n')
  expect(joined).not.toContain('declared')
  expect(joined).toMatch(/errors 1/)
})

test('a plan that is a link, resolves outside, is over 64 KiB or is older than a day is not used', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-l/plan.json`, planText('linked'), { isLink: true, realPath: '/etc/plan.json' })
  h.put(`${ROOT}/task-o/plan.json`, planText('outside'), { realPath: '/elsewhere/plan.json' })
  h.put(`${ROOT}/task-b/plan.json`, planText('big'), { size: 64 * 1024 + 1 })
  h.put(`${ROOT}/task-d/plan.json`, planText('old'), { mtimeMs: NOW - 25 * 3_600_000 })
  h.put(`${ROOT}/task-k/plan.json`, planText('kept'), { size: 64 * 1024 })
  await h.start($)
  await h.tick()
  expect(h.calls.read).toEqual([`${ROOT}/task-k/plan.json`])
  const joined = (await paneText($, 'terminal')).join('\n')
  for (const name of ['linked', 'outside', 'big', 'old']) expect(joined).not.toContain(name)
  expect(joined).toMatch(/^ {2}kept +declared/m)
})

test('a swapped plan (check, then a link at read time) is dropped, and a __proto__ task reaches no prototype', OPTIONS, async ($, on) => {
  const h = harness(on)
  const path = `${ROOT}/task-a/plan.json`
  h.put(path, planText('fine'))
  h.put(`${ROOT}/__proto__/plan.json`, planText('proto'))
  let isSwapped = false
  h.hooks.afterStat = (p, resolve) => {
    if (p !== path || !resolve || isSwapped) return
    isSwapped = true
    h.put(path, planText('outside-secret'), { realPath: '/elsewhere/plan.json' })
  }
  await h.start($)
  await h.tick()
  expect(isSwapped).toBe(true)
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).not.toContain('outside-secret')
  expect(joined).toMatch(/^ {2}proto +declared/m)
  expect(({} as Record<string, unknown>).phases).toBeUndefined()
})

test('when the session moves to another project, its plans leave the pane too', { options: { liveDirs: '' } }, async ($, on) => {
  const h = harness(on)
  let root = '/a'
  on('session.root', () => ({ value: root }))
  h.put('/a/orchestra/live/task-a/plan.json', planText('alpha'))
  await h.start($)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toContain('alpha')
  root = '/b'
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('alpha')
})

test('a plan past the per-tick file cap keeps what was drawn, as runs do', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-z/plan.json`, planText('capped'))
  await h.start($)
  await h.tick()
  // Listed before task-z, these fill the cap: task-z's plan is past it from now on.
  const files = new Map([...h.fs].filter(([path]) => !path.startsWith(`${ROOT}/task-z`)))
  for (let i = 0; i < 500; i++) files.set(`${ROOT}/task-a/r${i}.jsonl`, { kind: 'file', text: runLines(`r${i}`, [START]).join('\n') + '\n', mtimeMs: NOW })
  files.set(`${ROOT}/task-a`, { kind: 'dir' })
  for (const [path, node] of h.fs) if (path.startsWith(`${ROOT}/task-z`)) files.set(path, node)
  h.fs.clear()
  for (const [path, node] of files) h.fs.set(path, node)
  await h.tick()
  const joined = (await paneText($, 'terminal', 200)).join('\n')
  expect(joined).toContain('too many live files: 1 skipped')
  expect(joined).toMatch(/^ {2}capped +declared/m)
})

test('a task dir that cannot be listed for one tick does not lose its unchanged plan', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/plan.json`, planText('survives'))
  await h.start($)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^ {2}survives +declared/m)
  h.failList.add(`${ROOT}/task-a`)
  await h.tick()
  // Not even for the tick whose listing failed: the plan last read is drawn.
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^ {2}survives +declared/m)
  h.failList.clear()
  await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toMatch(/^ {2}survives +declared/m)
  expect(joined).toMatch(/errors 1/)
  expect(h.calls.read.filter(p => p.endsWith('plan.json')).length).toBe(1)
})

test('a plan whose re-read throws keeps the last plan read, and costs an error', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/plan.json`, planText('last-good'))
  await h.start($)
  await h.tick()
  h.fs.set(`${ROOT}/task-a/plan.json`, { kind: 'file', size: 10, mtimeMs: NOW + 5000 }) // changed; fs.read throws
  await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toMatch(/^ {2}last-good +declared/m)
  expect(joined).toMatch(/errors 1/)
})

test('a live dir that cannot be listed for one tick keeps its plans drawn, as it keeps its runs', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/plan.json`, planText('kept'))
  h.put(`${ROOT}/task-b/r1.jsonl`, runLines('r1', [PHASED('implement')], NOW, { task: 'task-b' }))
  await h.start($)
  await h.tick()
  h.failList.add(ROOT)
  await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toMatch(/^ {2}kept +declared/m)
  expect(joined).toMatch(/^ {2}implement /m)
  expect(joined).toMatch(/errors 1/)
})

test('a plan that left the listing is forgotten: one that comes back unchanged is read again', OPTIONS, async ($, on) => {
  const h = harness(on)
  const path = `${ROOT}/task-a/plan.json`
  h.put(path, planText('back'), { mtimeMs: NOW - 1000 })
  await h.start($)
  await h.tick()
  const node = h.fs.get(path)!
  h.fs.delete(path)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('back')
  h.fs.set(path, node)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^ {2}back +declared/m)
  expect(h.calls.read.filter(p => p === path).length).toBe(2)
})

test('a plan dated in the future: past a day ahead it is not drawn; within it, it sorts as read now, below a newer run', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-far/plan.json`, planText('far'), { mtimeMs: NOW + 2 * 24 * 3_600_000 })
  h.put(`${ROOT}/task-soon/plan.json`, planText('soon'), { mtimeMs: NOW + 3_600_000 })
  await h.start($)
  await h.tick()
  // A run whose last event is after the plan was read (but long before the plan's mtime) sorts above it.
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [PHASED('implement')], NOW + 3000))
  await h.tick()
  const ui = await mount($, 'terminal')
  const tree = await ui.drawn()
  await ui.unmount()
  expect([...cardsOf(tree).keys()]).toEqual(['task:task-a', 'task:task-soon', 'agents'])
})

test('a plan carried over a failed listing still ages out after a day', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/plan.json`, planText('ageing'), { mtimeMs: NOW - 24 * 3_600_000 + 3000 })
  await h.start($)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^ {2}ageing +declared/m)
  h.failList.add(`${ROOT}/task-a`)
  await h.tick()
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('ageing')
})

test('a plan whose re-read threw is read again next tick, and its new phases drawn', OPTIONS, async ($, on) => {
  const h = harness(on)
  const path = `${ROOT}/task-a/plan.json`
  h.put(path, planText('first'))
  await h.start($)
  await h.tick()
  const text = planText('second')[0]! + '\n'
  h.fs.set(path, { kind: 'file', size: text.length, mtimeMs: NOW + 5000 }) // changed; fs.read throws
  await h.tick()
  h.fs.set(path, { kind: 'file', text, mtimeMs: NOW + 5000 }) // same size:mtime, now readable
  await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toMatch(/^ {2}second +declared/m)
  expect(joined).not.toContain('first')
})

test('a run whose claims its trace does not back: ⚠1 on its phase row, a warning line under it, on terminal AND desktop', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-w/r1.jsonl`, runLines('r1', [{ ...START, phase: 'implement' }, { ...end('completed'), witness: { findings: ['claimedTestsButNone', '\u001b[2JstaleGreen'] } }], NOW, { task: 'task-w' }))
  h.put(`${ROOT}/task-w/r2.jsonl`, runLines('r2', [{ ...START, phase: 'implement' }, { ...end('completed'), witness: { findings: [] } }], NOW, { task: 'task-w' }))
  await h.start($)
  await h.tick()
  const warnings = (node: El | string): El[] => typeof node === 'string' ? []
    : [...(node.type === 'Text' && flat(node).includes('unwitnessed') ? [node] : []), ...(node.children ?? []).flatMap(warnings)]
  for (const surface of SURFACES) {
    expect((await paneText($, surface)).find(t => t.startsWith('  implement'))).toBe('  implement  ●●  ⚠1 · gpt-5.6-luna · 2/2 done')
    expect((await expanded($, surface, ['task-w'])).filter(t => t.includes('unwitnessed')).map(t => t.trim()))
      .toEqual(['⚠ unwitnessed: claimedTestsButNone, staleGreen'])
    const ui = await mount($, surface)
    await ui.press({ key: 'card:task-w' })
    const found = warnings(await ui.drawn())
    await ui.press({ key: 'card:task-w' })
    await ui.unmount()
    expect(found.map(n => n.props?.color)).toEqual(['warning'])
    for (const n of found) expect(flat(n)).not.toMatch(CONTROL)
  }
})

// --- the checkpoint card ---------------------------------------------------------------------------

const CHECKPOINT = [
  '# night', '', '## Phases', '| # | Phase | Status | Evidence |', '|---|---|---|---|',
  '| 0 | Cards merged | done | b0ccaca |', '| 1 | Build features | running | wf_x |', '| 2 | Report | pending | |', '',
  '## Next action', 'SENTINEL-NEXT-TEXT pick the build set', '', '## Resume', '`cd /work && git log`', '',
]
const PROMPT = 'Read /work/checkpoints/2026-10-11_x.md first, then git status, then continue from the first phase that is not done.'

/** /work/checkpoints with the newest (by date prefix) and an older file touched later, a link and a non-md. */
function checkpoints(h: ReturnType<typeof harness>, on: Parameters<typeof harness>[0]) {
  on('session.root', () => ({ value: '/work' }))
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT)
  h.put('/work/checkpoints/2026-10-09_old.md', ['## Next action', 'OLD-NEXT'], { mtimeMs: NOW + 60_000 })
  h.put('/work/checkpoints/2026-10-12_link.md', ['## Next action', 'LINK-NEXT'], { isLink: true, realPath: '/etc/x.md' })
  h.put('/work/checkpoints/2026-10-12_notes.txt', ['## Next action', 'TXT-NEXT'])
}

test('the newest checkpoint is the first card: done/total, phase rows, next and resume, on terminal AND desktop', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  await h.start($)
  await h.tick()
  expect(h.calls.read).toContain('/work/checkpoints/2026-10-11_x.md')
  expect(h.calls.read.filter(p => p.startsWith('/work/'))).toEqual(['/work/checkpoints/2026-10-11_x.md'])
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const tree = await ui.drawn()
    await ui.unmount()
    const cards = cardsOf(tree)
    expect([...cards.keys()][0]).toBe('checkpoint')
    const drawn = cards.get('checkpoint')!
    expect(drawn[1]).toMatch(/^2026-10-11_x\.md +1\/3$/)
    expect(drawn.slice(2, 5)).toEqual(['#0 Cards merged · done', '#1 Build features · running', '#2 Report · pending'])
    expect(drawn).toContain('next: SENTINEL-NEXT-TEXT pick the build set')
    expect(drawn).toContain('resume: cd /work && git log')
    expect(drawn).toContain('Queue resume')
    // A live event 0 s ago: no drift.
    expect(drawn.join('\n')).not.toContain('no live event')
    expect(rowsOf(tree).join('\n')).toMatch(/errors 0/)
  }
})

test('a pane too short for the phase rows draws the checkpoint compact; shorter still, it says checkpoint hidden', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT, { mtimeMs: NOW - 50 * 60_000 })
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    // 11 rows: a head line, the footer, a row for the "more" line, 8 for the card and the blank row
    // under it (the full one takes 11).
    const ui = await mount($, surface, 11)
    const tree = await ui.drawn()
    await ui.unmount()
    expect(cardsOf(tree).get('checkpoint')).toEqual(['╭', expect.stringMatching(/^2026-10-11_x\.md +1\/3$/), 'next: SENTINEL-NEXT-TEXT pick the build set', 'resume: cd /work && git log', 'checkpoint says running, no live event or checkpoint write for 50m', 'Queue resume', '╰', ''])
    const short = (await paneText($, surface, 5)).join('\n')
    expect(short).toContain('checkpoint hidden')
    expect(short).not.toContain('more task')
  }
})

test('Queue resume submits only the fixed prompt with the file name; a throwing submit toasts it instead; both surfaces', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  const submitted: unknown[] = []
  let isBroken = false
  on('prompt.submit', ($, e) => {
    if (isBroken) throw new Error('prompt.submit is not available')
    submitted.push(e)
    return { text: e.text }
  })
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    isBroken = false
    submitted.length = 0
    h.calls.toast.length = 0
    const ui = await mount($, surface)
    await ui.press({ key: 'checkpoint:resume' })
    expect(submitted.map(e => (e as { text: string }).text)).toEqual([PROMPT])
    expect(JSON.stringify(submitted)).not.toContain('SENTINEL')
    expect(h.calls.toast).toEqual([])
    isBroken = true
    await ui.press({ key: 'checkpoint:resume' })
    await ui.unmount()
    expect(h.calls.toast).toEqual([`ocli: copy this to resume: ${PROMPT}`])
  }
})

test('a checkpoint that says running while no live event came for over 30 minutes draws a warning line', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT, { mtimeMs: NOW - 50 * 60_000 })
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START], NOW - 40 * 60_000))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const drawn = cardsOf(await ui.drawn()).get('checkpoint')!
    await ui.unmount()
    expect(drawn).toContain('checkpoint says running, no live event or checkpoint write for 40m')
  }
})

test('a checkpoint written 20 minutes ago is a sign of life: no drift line, whatever the live dir says', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT, { mtimeMs: NOW - 20 * 60_000 })
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START], NOW - 119 * 60_000))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const drawn = cardsOf(await (async () => { const ui = await mount($, surface); const t = await ui.drawn(); await ui.unmount(); return t })()).get('checkpoint')!
    expect(drawn.join('\n')).not.toContain('checkpoint says running')
  }
})

test('the card is the newest checkpoint with a resume command: a newer notes file and a newer feature checkpoint are passed over, at no error', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  // Not a checkpoint at all (no table, no Next action), and dated later.
  h.put('/work/checkpoints/2026-10-12_notes.md', ['# notes', '', 'prose only'])
  // A feature checkpoint git touched after the lead's (a merge): a table, no Resume.
  h.put('/work/checkpoints/2026-10-11_feature.md', ['| Phase | Status |', '|---|---|', '| FEATURE-ROW | done |', '', '## Next action', 'FEATURE-NEXT'], { mtimeMs: NOW + 60_000 })
  await h.start($)
  for (let i = 0; i < 61; i++) await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toContain('SENTINEL-NEXT-TEXT')
  expect(joined).not.toContain('FEATURE')
  expect(joined).toMatch(/errors 0/)
  // Nothing changed in the listing: the files are not read again every minute.
  expect(h.calls.read.filter(p => p.startsWith('/work/')).length).toBeLessThanOrEqual(3)
})

test('no checkpoint with a resume command: the newest that parses is drawn; none that parses is no card, at no error', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.root', () => ({ value: '/work' }))
  h.put('/work/checkpoints/2026-10-12_notes.md', ['# notes'])
  h.put('/work/checkpoints/2026-10-11_feature.md', ['## Next action', 'FEATURE-NEXT'])
  await h.start($)
  await h.tick()
  let joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toContain('FEATURE-NEXT')
  expect(joined).not.toContain('Queue resume')
  h.fs.delete('/work/checkpoints/2026-10-11_feature.md')
  for (let i = 0; i < 30; i++) await h.tick()
  joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).not.toContain('FEATURE-NEXT')
  expect(joined).toMatch(/errors 0/)
})

test('a checkpoints dir that cannot be statted (not missing) keeps the card and costs an error', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  await h.start($)
  await h.tick()
  h.hooks.afterStat = path => {
    if (path === '/work/checkpoints') throw new Error('EACCES /work/checkpoints')
  }
  for (let i = 0; i < 30; i++) await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toContain('SENTINEL-NEXT-TEXT')
  expect(joined).toMatch(/errors 1/)
})

test('a checkpoints dir that resolves outside the project is not read: no card', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.root', () => ({ value: '/work' }))
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT, { realPath: '/home/secret/2026-10-11_x.md' })
  h.fs.set('/work/checkpoints', { kind: 'dir', realPath: '/home/secret' })
  await h.start($)
  await h.tick()
  expect(h.calls.read.filter(p => p.startsWith('/work/'))).toEqual([])
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('Queue resume')
})

test('the session moves to another project: its checkpoint is drawn on the next tick, and Queue resume names it; no root is no card', OPTIONS, async ($, on) => {
  const h = harness(on)
  let root: string | null = '/work'
  on('session.root', () => {
    if (root === null) throw new Error('no root')
    return { value: root }
  })
  on('session.cwd', () => {
    if (root === null) throw new Error('no cwd')
    return { value: root }
  })
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT)
  h.put('/other/checkpoints/2026-10-11_y.md', ['## Next action', 'OTHER-NEXT', '', '## Resume', '`cd /other`'])
  await h.start($)
  await h.tick()
  root = '/other'
  await h.tick()
  const ui = await mount($, 'terminal')
  expect(rowsOf(await ui.drawn()).join('\n')).toContain('OTHER-NEXT')
  await ui.press({ key: 'checkpoint:resume' })
  await ui.unmount()
  expect(submitted).toEqual(['Read /other/checkpoints/2026-10-11_y.md first, then git status, then continue from the first phase that is not done.'])
  root = null
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('OTHER-NEXT')
})

test('a project root that clean() would change is never put in the prompt: the press toasts instead', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.root', () => ({ value: '/my  work' }))
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  h.put('/my  work/checkpoints/2026-10-11_x.md', CHECKPOINT)
  await h.start($)
  await h.tick()
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'checkpoint:resume' })
  await ui.unmount()
  expect(submitted).toEqual([])
  expect(h.calls.toast).toEqual(['ocli: the project path is not plain; resume from its checkpoints dir by hand'])
})

test('no session.root: the checkpoint is found under session.cwd; no checkpoints dir is no card and no error', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.cwd', () => ({ value: '/work' }))
  await h.start($)
  await h.tick()
  let joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).not.toContain('Queue resume')
  expect(joined).toMatch(/errors 0/)
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT)
  for (let i = 0; i < 29; i++) await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('Queue resume')
  await h.tick()
  joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toContain('Queue resume')
  expect(joined).toMatch(/errors 0/)
})

test('an unreadable checkpoint keeps the card drawn and costs an error', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  await h.start($)
  await h.tick()
  h.fs.set('/work/checkpoints/2026-10-11_x.md', { kind: 'file', size: 10, mtimeMs: NOW + 1 })
  for (let i = 0; i < 30; i++) await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toContain('Queue resume')
  expect(joined).toMatch(/errors 1/)
})

test('a checkpoint that resolves outside the checkpoints dir is not read, and costs an error', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.root', () => ({ value: '/work' }))
  h.put('/work/checkpoints/2026-10-11_x.md', CHECKPOINT, { realPath: '/elsewhere/2026-10-11_x.md' })
  await h.start($)
  await h.tick()
  expect(h.calls.read.filter(p => p.startsWith('/work/'))).toEqual([])
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).not.toContain('Queue resume')
  expect(joined).toMatch(/errors 1/)
})

test('a checkpoint over 256 KiB is passed over for the next newest', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  h.put('/work/checkpoints/2026-10-12_big.md', ['## Next action', 'BIG-NEXT'], { size: 256 * 1024 + 1 })
  await h.start($)
  await h.tick()
  expect(h.calls.read.filter(p => p.startsWith('/work/'))).toEqual(['/work/checkpoints/2026-10-11_x.md'])
  expect((await paneText($, 'terminal')).join('\n')).not.toContain('BIG-NEXT')
})

const mountDigest = ($: unknown, surface: (typeof SURFACES)[number]) => ($ as Mountable).ui.mount({
  plugin: 'ocli-monitor', surface, component: 'Pane', requestId: 'ocli-digest',
  props: { ...PANE_PROPS, title: 'ocli digest' }, viewport: { columns: 100, rows: 30 },
} as never)
const runDigest = ($: { command: { run: (e: never) => Promise<{ text?: string }> } }) =>
  $.command.run({ command: 'ocli-digest', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
const DIGEST = '# ocli digest since 2026-10-10T18:30:00.000Z\n\n## t1 · 1/2 phases\n\n- implement: 1 run \u001b[31m(completed 1)\u0007 · pass 1/1 scored · 0 unscored\n'

test('/ocli-digest runs the digest script and draws its markdown, cleaned per line, with a Copy button', OPTIONS, async ($, on) => {
  const h = harness(on)
  // The 2.1.294 runtime has no session.root: the project root is session.cwd.
  on('session.cwd', () => ({ value: '/work' }))
  h.proc.result = { exitCode: 0, stdout: DIGEST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  await h.start($)
  // Its own name, so /ocli keeps its args free.
  expect(h.calls.register).toEqual(['ocli', 'ocli-digest'])
  const ran = await runDigest($ as never)
  expect(ran.text).toBe('ocli digest opened.')
  // The plugin's own script, never the project's; the project's orchestra dir is only the data it reads.
  expect(h.calls.process).toHaveLength(1)
  expect(h.calls.process[0]![1]).toMatch(/\/plugin\/lib\/digest\.mjs$/)
  expect(h.calls.process[0]!.slice(2)).toEqual(['--root', '/work/orchestra'])
  expect(h.calls.open).toContainEqual({ id: 'ocli-digest', title: 'ocli digest' })
  for (const surface of SURFACES) {
    const ui = await mountDigest($, surface)
    const [md] = await ui.findAll({ type: 'Markdown' })
    expect(md!.props.text).toBe('# ocli digest since 2026-10-10T18:30:00.000Z\n\n## t1 · 1/2 phases\n\n- implement: 1 run (completed 1) · pass 1/1 scored · 0 unscored')
    expect(String(md!.props.text).replace(/\n/g, '')).not.toMatch(CONTROL)
    await ui.press({ key: 'Copy' })
    expect(h.calls.copy.at(-1)).toMatchObject({ text: md!.props.text, surface })
    await ui.unmount()
  }
  expect(h.calls.toast).toEqual([])
})

test('/ocli-digest degrades to an unavailable line when process.run rejects or the script fails', OPTIONS, async ($, on) => {
  const h = harness(on)
  let cwd: string | null = null
  on('session.cwd', () => ({ value: cwd as never }))
  await h.start($)
  expect((await runDigest($ as never)).text).toBe('ocli digest unavailable: no project root')
  expect(h.calls.process).toEqual([])
  cwd = '/work'
  h.proc.result = new Error('spawn node ENOENT')
  // A throwing hook is skipped and the kit's own process.run rejects ("no implementation"): a rejection either way.
  expect((await runDigest($ as never)).text).toMatch(/^ocli digest unavailable: \S/)
  h.proc.result = { exitCode: 2, stdout: '', stderr: 'warn\n[digest] --since is not a date\u001b[0m\n', isStdoutTruncated: false, isStderrTruncated: false }
  expect((await runDigest($ as never)).text).toBe('ocli digest unavailable: digest exited 2: [digest] --since is not a date')
  expect(h.calls.open).not.toContainEqual({ id: 'ocli-digest', title: 'ocli digest' })
  const ui = await mountDigest($, 'terminal')
  expect(rowsOf(await ui.drawn()).join('\n')).toContain('no digest yet')
  expect(await ui.findAll({ type: 'Markdown' })).toEqual([])
  await ui.unmount()
})

test('/ocli-digest never runs a script from the session\'s project; with no plugin root it is unavailable', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.cwd', () => ({ value: '/clone' }))
  h.proc.result = { exitCode: 0, stdout: DIGEST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  await h.start($)
  await runDigest($ as never)
  const [argv] = h.calls.process
  expect(argv![1]).not.toMatch(/^\/clone\//)
  expect(argv!.slice(2)).toEqual(['--root', '/clone/orchestra'])
  // The degraded path: a runtime whose $.plugin has no absolute root.
  expect(digestScript(undefined)).toBe(null)
  expect(digestScript('')).toBe(null)
  expect(digestScript('relative/dir')).toBe(null)
  expect(digestScript('/p/ocli/plugin/')).toBe('/p/ocli/plugin/lib/digest.mjs')
})

test('/ocli-digest says when the digest was cut, by the runtime or by the pane, instead of dropping its end silently', OPTIONS, async ($, on) => {
  const h = harness(on)
  on('session.cwd', () => ({ value: '/work' }))
  await h.start($)
  const drawn = async () => {
    const ui = await mountDigest($, 'terminal')
    const [md] = await ui.findAll({ type: 'Markdown' })
    await ui.unmount()
    return String(md!.props.text)
  }
  h.proc.result = { exitCode: 0, stdout: DIGEST, stderr: '', isStdoutTruncated: true, isStderrTruncated: false }
  await runDigest($ as never)
  expect(await drawn()).toMatch(/\n\n… cut: [^\n]*Needs a decision[^\n]*$/)
  h.proc.result = { exitCode: 0, stdout: `${DIGEST}${'- x\n'.repeat(40_000)}## Needs a decision\n\n- t1 / implement failed\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  await runDigest($ as never)
  const long = await drawn()
  expect([...long].length).toBe(99_900)
  expect(long).toMatch(/\n\n… cut: [^\n]*for all of it$/)
  h.proc.result = { exitCode: 0, stdout: DIGEST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  await runDigest($ as never)
  expect(await drawn()).not.toContain('… cut')
})

// --- heartbeat sparkline and loop detector -----------------------------------------------------

const TEST_START = { kind: 'tool.start', tool: 'bash', detail: 'npm test' }
const LOOP_TOAST = 'ocli: task-a/implement codex may be looping (8× bash: npm test)'
/** r1: run.start then `n` identical tool.starts and a failed end, from 30 s before NOW. */
const loopLines = (n: number) => runLines('r1', [START, ...Array(n).fill(TEST_START), { kind: 'tool.end', tool: 'bash', detail: 'npm test', ok: false }], NOW - 30_000)
/** Each drawn Text whose text has the live arrow, with its colour. */
const liveTexts = (node: El | string): El[] => typeof node === 'string' ? []
  : [...(node.type === 'Text' && flat(node).includes('↳') ? [node] : []), ...(node.children ?? []).flatMap(liveTexts)]

test('eight identical tool.starts with no ok end: one "may be looping" toast, never again across ticks or a re-read', OPTIONS, async ($, on) => {
  const h = harness(on)
  const looping = () => h.calls.toast.filter(t => t.includes('may be looping'))
  const path = `${ROOT}/task-a/r1.jsonl`
  // Append-only, as dispatch.mjs writes it: seven starts, then the eighth and a failed end.
  h.put(path, loopLines(7).slice(0, -1))
  await h.start($)
  await h.tick()
  await h.tick()
  expect(looping()).toEqual([])
  h.put(path, loopLines(8))
  await h.tick()
  expect(looping()).toEqual([LOOP_TOAST])
  await h.tick()
  await h.tick()
  // A fresh module re-reads every file (a changed mtime forces it here): the seq dedupe and the kept key hold.
  h.fs.get(path)!.mtimeMs = h.clock.now()
  await h.tick()
  expect(h.calls.read.filter(p => p === path).length).toBe(3)
  expect(looping()).toEqual([LOOP_TOAST])
  expect(h.calls.toast).toEqual([LOOP_TOAST])
})

test('a reload ($.state kept, fresh module): a loop already announced is not announced again; one not yet is', OPTIONS, async ($, on) => {
  const lines = loopLines(8)
  const notified = ['loop/task-a/r1']
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    const key = (e as { key: string }).key
    const kept: Record<string, unknown> = { runs: reduce([], parseLines(lines.join('\n') + '\n')), notified, primed: true }
    return (got as { value: { version: number } }).value.version === 0 && key in kept ? { value: { value: kept[key], version: 0 } } : got
  })
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, lines)
  await h.start($)
  await h.tick()
  await h.tick()
  expect(h.calls.toast).toEqual([])
  h.put(`${ROOT}/task-b/r2.jsonl`, runLines('r2', [START, ...Array(8).fill(TEST_START)], NOW - 30_000, { task: 'task-b' }))
  await h.tick()
  expect(h.calls.toast).toEqual(['ocli: task-b/implement codex may be looping (8× bash: npm test)'])
})

test('a loop toast counts against the three toasts a tick may show, and waits for the next tick', OPTIONS, async ($, on) => {
  const h = harness(on)
  await h.start($)
  await h.tick()
  for (const id of ['e1', 'e2', 'e3']) h.put(`${ROOT}/task-e/${id}.jsonl`, runLines(id, [START, end('completed')], NOW, { task: 'task-e' }))
  h.put(`${ROOT}/task-a/r1.jsonl`, loopLines(8))
  await h.tick()
  expect(h.calls.toast.length).toBe(3)
  expect(h.calls.toast.some(t => t.includes('may be looping'))).toBe(false)
  await h.tick()
  expect(h.calls.toast.slice(3)).toEqual([LOOP_TOAST])
  await h.tick()
  expect(h.calls.toast.length).toBe(4)
})

test('a looping run silent for over 10 minutes is stale, not running: no loop toast', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, ...Array(8).fill(TEST_START)], NOW - 11 * 60_000))
  await h.start($)
  await h.tick()
  await h.tick()
  expect(h.calls.toast).toEqual([])
})

test('the live row: a sparkline, ×n and the warning colour while looping in the open card; the closed card marks the phase ⟳; within bodyColumns on terminal AND desktop', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, loopLines(8))
  h.put(`${ROOT}/task-a/r2.jsonl`, runLines('r2', [{ ...START, title: 'x'.repeat(300) }, { kind: 'tool.start', tool: 'bash', detail: 'y'.repeat(300) }], NOW - 30_000, { task: 'task-a', phase: 'review' }))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const closed = await mount($, surface)
    const tree = await closed.drawn()
    await closed.unmount()
    // Closed: the running runs keep their live line; only the looping one is warning-coloured.
    expect(liveTexts(tree).filter(n => n.props?.color === 'warning').map(flat)).toEqual([expect.stringMatching(/^ {4}[ ▁-█]{10} ↳ tool\.end bash: npm test \(failed\) ×8$/)])
    const mark = byKey(tree, 'row:phase:task-a/implement')!.children!.find(c => typeof c !== 'string' && flat(c).includes('⟳1')) as El
    expect(mark.props?.color).toBe('warning')
    const ui = await mount($, surface, 60)
    await ui.press({ key: 'card:task-a' })
    const live = liveTexts(await ui.drawn())
    await ui.press({ key: 'card:task-a' })
    await ui.unmount()
    const loop = live.find(n => flat(n).endsWith('×8'))!
    expect(flat(loop)).toMatch(/^ {4}[ ▁-█]{10} ↳ tool\.end bash: npm test \(failed\) ×8$/)
    expect(loop.props?.color).toBe('warning')
    expect(live.filter(n => n.props?.color === 'warning').length).toBe(1)
    const open = await expanded($, surface, ['task-a'], 60)
    for (const rows of [await paneText($, surface), open]) {
      for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(PANE_PROPS.bodyColumns)
    }
    expect(open.filter(t => /[▁-█] ↳ tool\.end bash: npm test \(failed\) ×8$/.test(t)).length).toBe(1)
  }
})

test('a task dir named "loop:<task>" cannot silence a loop toast: loop keys cannot equal an end key', OPTIONS, async ($, on) => {
  const h = harness(on)
  // Ended before the first tick: its end key (`loop:task-a/r1`) is kept at once.
  h.put(`${ROOT}/loop:task-a/r1.jsonl`, runLines('r1', [START, end('completed')], NOW, { task: 'loop:task-a' }))
  await h.start($)
  await h.tick()
  h.put(`${ROOT}/task-a/r1.jsonl`, loopLines(8))
  await h.tick()
  expect(h.calls.toast).toEqual([LOOP_TOAST])
})

test('a run silent past the stale cutoff (a killed CLI, no run.end) leaves its beats out of $.state', OPTIONS, async ($, on) => {
  const kept: { runs?: OcliRun[] } = {}
  on('state.set', async ($, e, next) => {
    if ((e as { key: string }).key === 'runs') kept.runs = (e as { value: OcliRun[] }).value
    return next(e)
  })
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, ...Array.from({ length: 300 }, (_, i) => ({ kind: 'tool.start', tool: 'bash', detail: `step ${i}` }))], NOW - 400_000))
  await h.start($)
  await h.tick()
  expect(kept.runs?.[0]?.beats?.length).toBe(200)
  await h.clock.advance(11 * 60_000)
  expect(kept.runs?.[0]?.beats).toBeUndefined()
  expect(kept.runs?.[0]?.streak).toBeDefined()
  expect(JSON.stringify(kept.runs).length).toBeLessThan(1000)
})

// --- 0.4: History (by hand only), the open card's brief ------------------------------------------

/** task-done (completed), task-bad (failed) and task-live (running, newest). */
function historyTasks(h: ReturnType<typeof harness>) {
  h.put(`${ROOT}/task-done/d.jsonl`, runLines('d', [START, end('completed')], NOW - 90_000, { task: 'task-done' }))
  h.put(`${ROOT}/task-bad/b.jsonl`, runLines('b', [START, end('failed')], NOW - 80_000, { task: 'task-bad' }))
  h.put(`${ROOT}/task-live/l.jsonl`, runLines('l', [START], NOW - 10_000, { task: 'task-live' }))
}
const keysOf = async ($: unknown, surface: (typeof SURFACES)[number], bodyRows = 60) => {
  const ui = await mount($, surface, bodyRows)
  const keys = [...cardsOf(await ui.drawn()).keys()]
  await ui.unmount()
  return keys
}
/** Local hours and minutes, as History draws them: computed here, so tests hold in every timezone. */
const hhmm = (ms: number) => [new Date(ms).getHours(), new Date(ms).getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
/** A History entry as $.store keeps it; scope is the watched dir (OPTIONS: ROOT). */
const stored = (task: string, over: Record<string, unknown> = {}) =>
  ({ scope: ROOT, task, status: 'Completed', runs: 1, tokens: null, span: 1000, lastAt: NOW - 89_000, dismissedAt: NOW - 1000, ...over })
const BULK = 'Move completed to history'

test('× moves an ended card to a closed History at the bottom; never by itself; opening it lists the card, restore brings it back; on both surfaces', OPTIONS, async ($, on) => {
  const h = harness(on)
  historyTasks(h)
  await h.start($)
  for (let i = 0; i < 5; i++) await h.tick()
  // Ticks alone never move a finished card.
  expect(await keysOf($, 'terminal')).toEqual(['task:task-live', 'task:task-bad', 'task:task-done', 'agents'])
  for (const surface of SURFACES) {
    const ui = await mount($, surface, 60)
    // A running card has no ×.
    await expect(ui.press({ key: 'dismiss:task-live' })).rejects.toThrow()
    await ui.press({ key: 'dismiss:task-done' })
    const tree = await ui.drawn()
    const cards = cardsOf(tree)
    expect([...cards.keys()]).toEqual(['task:task-live', 'task:task-bad', 'agents', 'history'])
    // Closed by default (the first surface; the open state is shared $.state, so the second finds it open).
    if (surface === 'terminal') expect(cards.get('history')!.slice(1, -2)).toEqual([expect.stringMatching(/^▸ History +1$/)])
    if (cards.get('history')![1]!.startsWith('▸')) await ui.press({ key: 'history:toggle' })
    const open = cardsOf(await ui.drawn()).get('history')!
    expect(open[1]).toMatch(/^▾ History +1$/)
    expect(open[2]).toBe(`restore task-done · Completed · 1 run · ? tokens · 1s · dismissed ${hhmm(h.clock.now())}`)
    await ui.press({ key: 'restore:task-done' })
    // Restored, History is empty: no card for it at all.
    expect([...cardsOf(await ui.drawn()).keys()]).toEqual(['task:task-live', 'task:task-bad', 'task:task-done', 'agents'])
    await ui.unmount()
  }
})

test('"Move completed to history" moves Completed cards only: Failed and Blocked keep their own ×, a running one is never moved; with none left it is not drawn', OPTIONS, async ($, on) => {
  const h = harness(on)
  historyTasks(h)
  await h.start($)
  await h.tick()
  const ui = await mount($, 'terminal', 60)
  expect(rowsOf(await ui.drawn())[0]).toBe(BULK)
  await ui.press({ key: 'history:all' })
  const rows = rowsOf(await ui.drawn())
  expect([...cardsOf(await ui.drawn()).keys()]).toEqual(['task:task-live', 'task:task-bad', 'agents', 'history'])
  expect(rows).not.toContain(BULK)
  // The failed card keeps its own ×, which still works.
  await ui.press({ key: 'dismiss:task-bad' })
  expect([...cardsOf(await ui.drawn()).keys()]).toEqual(['task:task-live', 'agents', 'history'])
  await ui.unmount()
  // Persisted for the next session.
  expect(h.stored.at(-1)!.key).toBe('history')
  expect(h.stored.at(-1)!.value).toEqual([expect.objectContaining({ scope: ROOT, task: 'task-done' }), expect.objectContaining({ scope: ROOT, task: 'task-bad', status: 'Failed' })])
  // The running one ends blocked: no bulk button for it, only its ×.
  h.put(`${ROOT}/task-live/l.jsonl`, runLines('l', [START, end('blocked')], NOW - 10_000, { task: 'task-live' }))
  await h.tick()
  const again = await mount($, 'terminal', 60)
  const drawn = rowsOf(await again.drawn())
  expect(drawn).not.toContain(BULK)
  await again.press({ key: 'dismiss:task-live' })
  expect([...cardsOf(await again.drawn()).keys()]).toEqual(['agents', 'history'])
  await again.unmount()
})

test('a completed card beside a stale run has no ×, and the bulk button neither draws for it nor moves it', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-mix/a.jsonl`, runLines('a', [START, end('completed')], NOW - 90_000, { task: 'task-mix' }))
  h.put(`${ROOT}/task-mix/s.jsonl`, runLines('s', [START], NOW - 11 * 60_000, { task: 'task-mix' }))
  await h.start($)
  await h.tick()
  const ui = await mount($, 'terminal', 60)
  expect(rowsOf(await ui.drawn())).not.toContain(BULK)
  expect(rowsOf(await ui.drawn()).some(t => t.trimEnd() === 'ocli · Completed')).toBe(true)
  await expect(ui.press({ key: 'dismiss:task-mix' })).rejects.toThrow()
  await ui.unmount()
})

test('bulk moved twice: an entry already in History keeps its first dismissedAt', OPTIONS, async ($, on) => {
  const h = harness(on)
  historyTasks(h)
  await h.start($)
  await h.tick()
  const ui = await mount($, 'terminal', 60)
  await ui.press({ key: 'history:all' })
  const first = h.clock.now()
  await h.clock.advance(120_000)
  // Another task completes: the button is back, and pressing it adds only that one.
  h.put(`${ROOT}/task-new/n.jsonl`, runLines('n', [START, end('completed')], NOW, { task: 'task-new' }))
  await h.tick()
  await ui.press({ key: 'history:all' })
  await ui.unmount()
  const list = h.stored.at(-1)!.value as { task: string; dismissedAt: number }[]
  expect(list.map(e => e.task)).toEqual(['task-done', 'task-new'])
  expect(list[0]!.dismissedAt).toBe(first)
  expect(list[1]!.dismissedAt).toBeGreaterThan(first)
})

test('History is per project: only the watched scope\'s entries hide cards and draw; restore acts in this scope only', OPTIONS, async ($, on) => {
  // The same task dismissed in another project (scope /other), and task-bad dismissed only there.
  const h = harness(on, { store: { history: [stored('task-done'), stored('task-done', { scope: '/other' }), stored('task-bad', { scope: '/other' })] } })
  historyTasks(h)
  await h.start($)
  await h.tick()
  expect(await keysOf($, 'terminal')).toEqual(['task:task-live', 'task:task-bad', 'agents', 'history'])
  const ui = await mount($, 'terminal', 60)
  await ui.press({ key: 'history:toggle' })
  const open = cardsOf(await ui.drawn()).get('history')!
  expect(open[1]).toMatch(/^▾ History +1$/)
  await ui.press({ key: 'restore:task-done' })
  await ui.unmount()
  // The other project's entries, task-done among them, are untouched.
  expect(h.stored.at(-1)!.value).toEqual([stored('task-done', { scope: '/other' }), stored('task-bad', { scope: '/other' })])
})

test('History outlives the session through $.store: merged with $.state on load, never replacing it; a dismissed task comes back when its runs move', OPTIONS, async ($, on) => {
  // A reload: $.state still holds one entry, $.store another (and junk, dropped on load).
  const kept: Record<string, unknown> = { history: [stored('task-bad', { status: 'Failed', lastAt: NOW - 79_000 })] }
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    const key = (e as { key: string }).key
    return (got as { value: { version: number } }).value.version === 0 && key in kept ? { value: { value: kept[key], version: 0 } } : got
  })
  const h = harness(on, { store: { history: [stored('task-done'), { task: 'legacy', status: 'Completed' }, stored('evil', { dismissedAt: 1e20 })] } })
  historyTasks(h)
  await h.start($)
  await h.tick()
  expect(await keysOf($, 'terminal')).toEqual(['task:task-live', 'agents', 'history'])
  // A new run in a dismissed task: its card is back in the list, and out of History.
  h.put(`${ROOT}/task-done/n.jsonl`, runLines('n', [START], NOW, { task: 'task-done' }))
  await h.tick()
  expect(await keysOf($, 'terminal')).toEqual(['task:task-done', 'task:task-live', 'agents', 'history'])
})

test('a stored entry with a dismissedAt past Date\'s range is dropped: History still opens and draws', OPTIONS, async ($, on) => {
  const h = harness(on, { store: { history: [stored('task-done'), stored('task-gone', { dismissedAt: 1e20 })] } })
  historyTasks(h)
  await h.start($)
  await h.tick()
  const ui = await mount($, 'terminal', 60)
  await ui.press({ key: 'history:toggle' })
  const open = cardsOf(await ui.drawn()).get('history')!
  await ui.unmount()
  expect(open.slice(1, 3)).toEqual([expect.stringMatching(/^▾ History +1$/), expect.stringMatching(/^restore task-done · Completed/)])
})

test('a $.store read that fails is retried next tick, and nothing is persisted before a read succeeded', OPTIONS, async ($, on) => {
  const h = harness(on, { store: { history: [stored('task-done')] } })
  h.storeFails.get = 1
  historyTasks(h)
  await h.start($)
  await h.tick()
  // Not loaded yet: the bulk press changes $.state, but nothing reaches $.store.
  const ui = await mount($, 'terminal', 60)
  await ui.press({ key: 'dismiss:task-bad' })
  expect(h.stored).toEqual([])
  await h.tick()
  // Loaded now, merged with what $.state holds.
  expect([...cardsOf(await ui.drawn()).keys()]).toEqual(['task:task-live', 'agents', 'history'])
  await ui.unmount()
})

test('the pane fits its rows with the bulk button drawn above the cards', OPTIONS, async ($, on) => {
  const h = harness(on)
  historyTasks(h)
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    for (let rows = 4; rows <= 40; rows++) {
      const all = await paneText($, surface, rows)
      expect(all[0]).toBe(BULK)
      expect(all.length, `${surface} ${rows}`).toBeLessThanOrEqual(rows)
    }
  }
})

test('the open card says what each run was asked: run.start.brief, else the title; and where it works', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-b/r1.jsonl`, runLines('r1', [{ ...START, title: 'RK1', root: '/w/wt-rk1', parentId: 'node-7', brief: 'slice RK1 · worktree wt-rk1 · Catalogue adapter · Write the GLM adapter.' }], NOW, { task: 'task-b' }))
  h.put(`${ROOT}/task-b/r2.jsonl`, runLines('r2', [{ ...START, title: 'RK2 older dispatcher' }], NOW, { task: 'task-b' }))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const open = await expanded($, surface, ['task-b'], 60)
    expect(open).toContain('    slice RK1 · worktree wt-rk1 · Catalogue adapter · Write the GLM adapter.')
    expect(open).toContain('    in /w/wt-rk1 · parent node-7')
    expect(open).toContain('    RK2 older dispatcher')
    for (const row of open) expect(row).not.toMatch(CONTROL)
  }
})

// --- the quota card: <live dir>/usage/latest.json ------------------------------------------------

const QUOTA = `${ROOT}/usage/latest.json`
const mountAt = ($: unknown, surface: (typeof SURFACES)[number], columns: number, bodyRows = 30) => ($ as Mountable).ui.mount({
  plugin: 'ocli-monitor', surface, component: 'Pane', requestId: 'ocli',
  props: { ...PANE_PROPS, bodyColumns: columns, scroll: { offset: 0, bodyRows } },
  viewport: { columns, rows: bodyRows },
} as never)
async function drawnAt($: unknown, surface: (typeof SURFACES)[number], columns = 100, bodyRows = 30) {
  const ui = await mountAt($, surface, columns, bodyRows)
  const tree = await ui.drawn()
  await ui.unmount()
  return tree
}
/** The node keyed `key` anywhere in the tree. */
function nodeOf(node: El | string, key: string): El | null {
  if (typeof node === 'string') return null
  if (String(node.props?.key ?? node.key ?? '') === key) return node
  for (const child of node.children ?? []) {
    const found = nodeOf(child, key)
    if (found) return found
  }
  return null
}
/** Every Text under `node`: its text and the props that style it. */
function textsOf(node: El | string | null, out: { text: string; bold: boolean; dim: boolean; color: unknown }[] = []) {
  if (!node || typeof node === 'string') return out
  if (node.type === 'Text') out.push({ text: flat(node), bold: node.props?.bold === true, dim: node.props?.dimColor === true, color: node.props?.color })
  else for (const child of node.children ?? []) textsOf(child, out)
  return out
}
const QUOTA_ROWS = (until: string) => [
  'codex  OK   ██░░░ 5h 42% wk 18% · resets 2h10m',
  'claude OK   stale 2h ██░░░ 5h 30% wk 20% · resets 1h00m',
  `glm    STOP until ${until} █████ 5h 96% · resets 40m`,
  'gemini OK   ██░░░ 5h 10% wk 39% · resets 2d3h',
  '       argon high/medium STOP · flash OK',
  'muse   ?    no reader',
  '       setup: usage.muse is not set in the ocli config',
]

test('the Quota card leads the pane, above the checkpoint: one row per provider in the fixed order, on terminal AND desktop', OPTIONS, async ($, on) => {
  const h = harness(on)
  checkpoints(h, on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  expect(h.calls.read).toContain(QUOTA)
  for (const surface of SURFACES) {
    const tree = await drawnAt($, surface)
    const cards = cardsOf(tree)
    expect([...cards.keys()].slice(0, 2)).toEqual(['quota', 'checkpoint'])
    const drawn = cards.get('quota')!
    expect(drawn[1]).toMatch(/^▾ Quota +3\/5 OK$/)
    expect(drawn.slice(2, -2)).toEqual(QUOTA_ROWS(hhmm(GLM_UNTIL)))
    expect(rowsOf(tree).join('\n')).toMatch(/errors 0/)
  }
})

test('the binding window is bold, the others are not; STOP, OK and ? chips take the pane status colours', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const texts = textsOf(nodeOf(await drawnAt($, surface), 'quota'))
    expect(texts.filter(t => t.bold).map(t => t.text)).toEqual(['5h 42%', '5h 30%', '5h 96%', 'wk 39%'])
    for (const plain of ['wk 18%', 'wk 20%', '5h 10%']) expect(texts.find(t => t.text === plain)?.bold).toBe(false)
    const chips = texts.filter(t => /^(OK|STOP|\?) *$/.test(t.text))
    expect(chips.map(t => [t.text.trim(), t.color])).toEqual([
      ['OK', 'success'], ['OK', 'success'], ['STOP', 'warning'], ['OK', 'success'], ['STOP', 'warning'], ['OK', 'success'], ['?', undefined],
    ])
  }
})

test('a reading older than 30 minutes draws its row dim with its age; a fresh one is not dim', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const tree = await drawnAt($, surface)
    const claude = textsOf(nodeOf(tree, 'quota:row:claude'))
    expect(claude.map(t => t.text).join('')).toContain('stale 2h')
    expect(claude.every(t => t.dim)).toBe(true)
    const codex = textsOf(nodeOf(tree, 'quota:row:codex'))
    expect(codex.some(t => t.dim)).toBe(false)
    expect(codex.map(t => t.text).join('')).not.toContain('stale')
  }
  // 29 minutes old: still fresh.
  const fresh = structuredClone(SNAPSHOT)
  fresh.providers.claude.readAt = new Date(NOW - 29 * 60_000).toISOString()
  h.put(QUOTA, snapshotText(fresh), { mtimeMs: NOW + 1 })
  await h.tick()
  const claude = textsOf(nodeOf(await drawnAt($, 'terminal'), 'quota:row:claude'))
  expect(claude.some(t => t.dim)).toBe(false)
  expect(claude.map(t => t.text).join('')).not.toContain('stale')
})

test('the setup line is dim under the unavailable provider; scoped routes get one sub-row', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const tree = await drawnAt($, surface)
    const setup = textsOf(nodeOf(tree, 'quota')).filter(t => t.text.includes('setup:'))
    expect(setup.map(t => t.text)).toEqual(['       setup: usage.muse is not set in the ocli config'])
    expect(setup.every(t => t.dim)).toBe(true)
    expect(rowsOf(nodeOf(tree, 'quota:routes:gemini')!)).toEqual(['       argon high/medium STOP · flash OK'])
    // Only gemini has routes.
    expect(cardsOf(tree).get('quota')!.filter(row => row.includes('·') && row.startsWith('       ') && !row.includes('setup'))).toHaveLength(1)
  }
})

test('a malformed snapshot draws no Quota card, never throws out of the tick, and costs one error per change', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  h.put(QUOTA, ['{"v":1,"providers":'])
  await h.start($)
  await h.tick()
  await h.tick()
  for (const surface of SURFACES) {
    const tree = await drawnAt($, surface)
    expect(cardsOf(tree).has('quota')).toBe(false)
    expect(cardsOf(tree).has('task:task-a')).toBe(true)
    expect(rowsOf(tree).join('\n')).toMatch(/errors 1$/)
  }
  // Valid JSON of the wrong shape is malformed too; a fixed file brings the card back.
  h.put(QUOTA, ['{"v":2,"providers":{}}'], { mtimeMs: NOW + 5000 })
  await h.tick()
  expect(cardsOf(await drawnAt($, 'terminal')).has('quota')).toBe(false)
  h.put(QUOTA, snapshotText(), { mtimeMs: NOW + 7000 })
  await h.tick()
  const tree = await drawnAt($, 'terminal')
  expect(cardsOf(tree).has('quota')).toBe(true)
  expect(rowsOf(tree).join('\n')).toMatch(/errors 2/)
})

test('no snapshot: no Quota card and no error; a file over 64 KiB or a link is never read', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START]))
  await h.start($)
  await h.tick()
  let tree = await drawnAt($, 'terminal')
  expect(cardsOf(tree).has('quota')).toBe(false)
  expect(rowsOf(tree).join('\n')).toMatch(/errors 0/)
  h.put(QUOTA, snapshotText(), { size: 65 * 1024 })
  await h.tick()
  tree = await drawnAt($, 'terminal')
  expect(cardsOf(tree).has('quota')).toBe(false)
  expect(rowsOf(tree)).toContain('⚠ usage/latest.json too large')
  h.put(QUOTA, snapshotText(), { isLink: true, realPath: '/elsewhere/latest.json' })
  await h.tick()
  expect(cardsOf(await drawnAt($, 'terminal')).has('quota')).toBe(false)
  expect(h.calls.read).not.toContain(QUOTA)
  // No task card is made of the usage dir.
  expect([...cardsOf(tree).keys()].filter(key => key.includes('usage'))).toEqual([])
})

test('an unchanged snapshot is read once; a changed one is read again', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  await h.tick()
  await h.tick()
  expect(h.calls.read.filter(p => p === QUOTA)).toHaveLength(1)
  h.put(QUOTA, snapshotText(), { mtimeMs: NOW + 9000 })
  await h.tick()
  expect(h.calls.read.filter(p => p === QUOTA)).toHaveLength(2)
})

test("a task card names its newest run's provider quota: the route for gemini, STOP until for a stopped one, nothing for a provider the snapshot lacks", OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  h.put(`${ROOT}/task-g/r1.jsonl`, runLines('r1', [{ kind: 'run.start', model: 'gpt-5.6-luna' }], NOW - 60_000, { task: 'task-g' }))
  h.put(`${ROOT}/task-g/r2.jsonl`, runLines('r2', [{ kind: 'run.start', model: 'gemini-3.8-flash-high' }], NOW, { task: 'task-g', cli: 'agy' }))
  h.put(`${ROOT}/task-z/r3.jsonl`, runLines('r3', [{ kind: 'run.start', model: 'zai-coding-plan/glm-5.3' }], NOW, { task: 'task-z', cli: 'opencode' }))
  h.put(`${ROOT}/task-c/r4.jsonl`, runLines('r4', [{ kind: 'run.start', model: 'mimo-v2.6-pro' }], NOW, { task: 'task-c', cli: 'cline' }))
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const tree = await drawnAt($, surface, 100, 60)
    const cards = cardsOf(tree)
    expect(cards.get('task:task-g')![3]).toBe('quota: gemini flash OK · wk 39%')
    expect(cards.get('task:task-z')![3]).toBe(`quota: glm STOP until ${hhmm(GLM_UNTIL)}`)
    expect(textsOf(nodeOf(tree, 'task:task-z')).find(t => t.text.startsWith('quota:'))?.color).toBe('warning')
    expect(cards.get('task:task-c')!.some(row => row.startsWith('quota:'))).toBe(false)
  }
})

test('narrow panes drop the bars first, then the sub-rows; shorter still the card closes, then hides', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const narrow = cardsOf(await drawnAt($, surface, 50)).get('quota')!
    expect(narrow[2]).toBe('codex  OK   5h 42% wk 18% · resets 2h10m')
    expect(narrow.join('\n')).not.toMatch(/[█░]/)
    expect(narrow).toContain('       argon high/medium STOP · flash OK')
    for (const row of narrow) expect(cells(row)).toBeLessThanOrEqual(46)
    // 12 rows: the full card (10 and its gap) does not fit, the one without sub-rows does.
    const short = cardsOf(await drawnAt($, surface, 100, 12)).get('quota')!
    expect(short.slice(2, -2)).toEqual(QUOTA_ROWS(hhmm(GLM_UNTIL)).filter(row => !row.startsWith(' ')))
    const closed = cardsOf(await drawnAt($, surface, 100, 8)).get('quota')!
    expect(closed).toEqual(['╭', expect.stringMatching(/^▸ Quota +3\/5 OK$/), '╰', ''])
    const hidden = await drawnAt($, surface, 100, 4)
    expect(cardsOf(hidden).has('quota')).toBe(false)
    expect(rowsOf(hidden).join('\n')).toContain('quota hidden')
    for (let rows = 4; rows <= 30; rows++) expect((await paneText($, surface, rows)).length).toBeLessThanOrEqual(rows)
  }
})

test('the Quota card collapses from its head and stays collapsed across drawings', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(QUOTA, snapshotText())
  await h.start($)
  await h.tick()
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'quota:toggle' })
  await ui.unmount()
  for (const surface of SURFACES) {
    expect(cardsOf(await drawnAt($, surface)).get('quota')).toEqual(['╭', expect.stringMatching(/^▸ Quota +3\/5 OK$/), '╰', ''])
  }
  const again = await mount($, 'desktop')
  await again.press({ key: 'quota:toggle' })
  await again.unmount()
  expect(cardsOf(await drawnAt($, 'terminal')).get('quota')!.length).toBe(11)
})
