import { test, expect } from 'claude-code/testing'

import { GLM_LIVE } from './fixtures'
import { harness, NOW, OPTIONS, PANE_PROPS, ROOT, runLines } from './harness'
import { digestScript } from './register'
import { parseLines, reduce } from './reduce'

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
    return node.props?.borderStyle ? ['╭', ...inner, '╰'] : inner
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
/** The pane's rows after pressing each phase row named, on one mounted drawing. */
async function expanded($: unknown, surface: (typeof SURFACES)[number], phases: string[], bodyRows = 30) {
  const ui = await mount($, surface, bodyRows)
  for (const key of phases) await ui.press({ key: `phase:${key}` })
  const rows = rowsOf(await ui.drawn())
  for (const key of phases) await ui.press({ key: `phase:${key}` }) // collapse again: $.state is shared across surfaces
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
    expect(texts.some(t => /^▸ implement ● glm-5\.3 +1\/1$/.test(t))).toBe(true)
    expect((await expanded($, surface, ['glm-live/implement'])).some(t => t.startsWith('  ✓ glm-5.3 (opencode) 15m54s 37t'))).toBe(true)
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
    expect(texts.some(t => t.includes('evilmodel')) && texts.some(t => t.includes('↳ message: wipe the screen'))).toBe(true)
    expect(texts.some(t => t.startsWith('▸ phase 1 ●'))).toBe(true)
    const open = await expanded($, surface, ['task-x/phase 1'])
    for (const text of open) expect(text).not.toMatch(CONTROL)
    expect(open.some(t => t.includes('evilmodel (codex)'))).toBe(true)
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
    const runs = (await expanded($, surface, ['task-a/implement'])).filter(t => t.includes('(codex)')).map(t => t.trimStart())
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
  expect((await expanded($, 'terminal', ['task-a/implement'])).some(t => t.startsWith('  ◌ stale gpt-5.6-luna (codex)'))).toBe(true)
})

test('an ended run whose file is older than 24 h is ignored', OPTIONS, async ($, on) => {
  const h = harness(on)
  const old = NOW - 25 * 3_600_000
  h.put(`${ROOT}/task-a/r1.jsonl`, runLines('r1', [START, end('completed')], old), { mtimeMs: old })
  h.put(`${ROOT}/task-a/r2.jsonl`, runLines('r2', [START], old), { mtimeMs: old })
  await h.start($)
  await h.tick()
  const runs = (await expanded($, 'terminal', ['task-a/implement'])).filter(t => t.includes('(codex)'))
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
        else expect(drawn).toEqual([...whole.get(key)!.slice(0, 4), expect.stringMatching(/^\d+ phases? · pane too short to list them/), '╰'])
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

test('a task is one round card: header, status, runs and tokens, title, phases with dots, done/total, LLMs and the live line', OPTIONS, async ($, on) => {
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
    expect(rows[1]).toMatch(/^task-p +2m06s$/)
    expect(rows.slice(2, 6)).toEqual(['ocli · Running', '4 runs · 1k tokens', 'Slice 046 cards', 'Phases'])
    expect(rows[6]).toMatch(/^▸ implement ●● gpt-6-astra, glm-5\.3 +1\/2$/)
    expect(rows[7]).toBe('  ↳ tool.end bash: npm test')
    expect(rows[8]).toMatch(/^▸ review ● glm-5\.3 +1\/1$/)
    expect(rows[9]).toMatch(/^▸ reason ● gpt-5\.6-luna +1\/1$/)
    expect(rows.length).toBe(11)
  }
})

test('pressing a phase row expands it to its runs; it stays expanded in $.state across mounts; pressing again collapses', OPTIONS, async ($, on) => {
  const h = harness(on)
  cardTask(h)
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'phase:task-p/implement' })
    const open = rowsOf(await ui.drawn())
    await ui.unmount()
    expect(open.some(t => t.startsWith('▾ implement'))).toBe(true)
    expect(open.some(t => t.startsWith('  ✓ gpt-6-astra (codex)'))).toBe(true)
    expect(open.some(t => t.startsWith('  ● glm-5.3 (opencode)'))).toBe(true)
    expect(open.filter(t => t.includes('↳ tool.end bash: npm test')).length).toBe(1)
    // A fresh drawing (another mount, as after a reload) reads the expanded set from $.state.
    const again = await mount($, surface)
    expect(rowsOf(await again.drawn()).some(t => t.startsWith('▾ implement'))).toBe(true)
    await again.press({ key: 'phase:task-p/implement' })
    const closed = rowsOf(await again.drawn())
    await again.unmount()
    expect(closed.some(t => t.startsWith('▸ implement'))).toBe(true)
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
    expect(rows.some(t => /^▸ implement ● gpt-5\.6-luna +1\/1$/.test(t))).toBe(true)
  }
})

test('the expanded set is read from $.state: a drawing after a reload opens what was open', OPTIONS, async ($, on) => {
  on('state.get', async ($, e, next) => {
    const got = await next(e)
    return (got as { value: { version: number } }).value.version === 0 && (e as { key: string }).key === 'expanded'
      ? { value: { value: ['task-p/review'], version: 0 } }
      : got
  })
  const h = harness(on)
  cardTask(h)
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const rows = await paneText($, surface)
    expect(rows.some(t => t.startsWith('▾ review'))).toBe(true)
    expect(rows.some(t => t.startsWith('  ⊘ blocked glm-5.3 (codex)'))).toBe(true)
    expect(rows.some(t => t.startsWith('▸ implement'))).toBe(true)
  }
})

test('a press acts on what is drawn: when two open phases do not fit, the newest survives and pressing the closed one opens it', OPTIONS, async ($, on) => {
  const h = harness(on)
  for (const [i, phase] of ['A', 'A', 'A', 'B', 'B', 'B'].entries()) {
    h.put(`${ROOT}/task-q/q${i}.jsonl`, runLines(`q${i}`, [{ kind: 'run.start', model: 'openai/gpt-6-astra', phase, title: `slice ${i}` }, end('completed')], NOW - 60_000 + i * 1000, { task: 'task-q' }))
  }
  await h.start($)
  await h.tick()
  for (const surface of SURFACES) {
    const tall = await mount($, surface, 200)
    await tall.press({ key: 'phase:task-q/A' })
    const onlyA = rowsOf(await tall.drawn()).length
    await tall.press({ key: 'phase:task-q/B' }) // $.state now holds A then B
    await tall.unmount()
    const ui = await mount($, surface, onlyA) // room for one open phase, not two
    const before = rowsOf(await ui.drawn())
    expect(before.length).toBeLessThanOrEqual(onlyA)
    expect(before.some(t => t.startsWith('▾ B'))).toBe(true)
    expect(before.some(t => t.startsWith('▸ A'))).toBe(true)
    await ui.press({ key: 'phase:task-q/A' })
    const after = rowsOf(await ui.drawn())
    expect(after.some(t => t.startsWith('▾ A'))).toBe(true)
    expect(after.some(t => t.startsWith('▸ B'))).toBe(true)
    // Pressing what is drawn open closes it: A, then B, leaves nothing expanded for the next surface.
    await ui.press({ key: 'phase:task-q/A' })
    expect(rowsOf(await ui.drawn()).some(t => t.startsWith('▾ B'))).toBe(true)
    await ui.press({ key: 'phase:task-q/B' })
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
    const phases = rows.filter(r => /^[▸▾] /.test(r))
    expect(phases.map(r => r.split(/\s+/)[1])).toEqual(['implement', 'review', 'merge', 'hotfix'])
    expect(phases[1]).toMatch(/^▸ review +declared +0\/0$/)
    expect(phases[0]).toMatch(/1\/1$/)
    // The pending row is one dim Text, its name included: no Button (it has nothing to open).
    const all = (n: El | string | undefined): El[] => (!n || typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(all)])
    const named = all(tree).filter(n => /^▸ review\b/.test(flat(n)) && n.type !== 'Box')
    expect(named.map(n => [n.type, n.props?.dimColor])).toEqual([['Text', true]])
    expect(flat(named[0]!).trimEnd()).toMatch(/^▸ review +declared +0\/0$/)
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
    const ui = await mount($, surface)
    const tree = await ui.drawn()
    const box = (await ui.findAll({ type: 'Box' })).find(b => b.props.key === 'task:task-new')!
    expect(box.props.borderColor).toBeUndefined()
    await ui.unmount()
    const cards = cardsOf(tree)
    expect([...cards.keys()]).toEqual(['task:task-new', 'task:task-a', 'task:task-old', 'agents'])
    expect(cards.get('task:task-new')!.map(r => r.trimEnd())).toEqual(expect.arrayContaining(['ocli · Declared', '0 runs · ? tokens · 0/1 phases', expect.stringMatching(/^▸ x +declared +0\/0$/)]))
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
    expect(joined).toMatch(/^▸ implement ● glm-5\.3 +0\/1$/m)
    expect(joined).not.toContain('phases ·')
    expect(joined).toMatch(/^1 run · \? tokens$/m)
  }
  h.put(`${ROOT}/task-a/plan.json`, planText('implement', 'review'), { mtimeMs: NOW + 5000 })
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^▸ review +declared +0\/0$/m)
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
  expect(joined).toMatch(/^▸ kept +declared/m)
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
  expect(joined).toMatch(/^▸ proto +declared/m)
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
  expect(joined).toMatch(/^▸ capped +declared/m)
})

test('a task dir that cannot be listed for one tick does not lose its unchanged plan', OPTIONS, async ($, on) => {
  const h = harness(on)
  h.put(`${ROOT}/task-a/plan.json`, planText('survives'))
  await h.start($)
  await h.tick()
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^▸ survives +declared/m)
  h.failList.add(`${ROOT}/task-a`)
  await h.tick()
  // Not even for the tick whose listing failed: the plan last read is drawn.
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^▸ survives +declared/m)
  h.failList.clear()
  await h.tick()
  const joined = (await paneText($, 'terminal')).join('\n')
  expect(joined).toMatch(/^▸ survives +declared/m)
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
  expect(joined).toMatch(/^▸ last-good +declared/m)
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
  expect(joined).toMatch(/^▸ kept +declared/m)
  expect(joined).toMatch(/^▸ implement /m)
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
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^▸ back +declared/m)
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
  expect((await paneText($, 'terminal')).join('\n')).toMatch(/^▸ ageing +declared/m)
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
  expect(joined).toMatch(/^▸ second +declared/m)
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
    expect((await paneText($, surface)).find(t => t.startsWith('▸ implement'))).toMatch(/^▸ implement ●● ⚠1 /)
    expect((await expanded($, surface, ['task-w/implement'])).filter(t => t.includes('unwitnessed')).map(t => t.trim()))
      .toEqual(['⚠ unwitnessed: claimedTestsButNone, staleGreen'])
    const ui = await mount($, surface)
    await ui.press({ key: 'phase:task-w/implement' })
    const found = warnings(await ui.drawn())
    await ui.press({ key: 'phase:task-w/implement' })
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
    // 10 rows: a head line, the footer, a row for the "more" line, 7 for the card (the full one takes 10).
    const ui = await mount($, surface, 10)
    const tree = await ui.drawn()
    await ui.unmount()
    expect(cardsOf(tree).get('checkpoint')).toEqual(['╭', expect.stringMatching(/^2026-10-11_x\.md +1\/3$/), 'next: SENTINEL-NEXT-TEXT pick the build set', 'resume: cd /work && git log', 'checkpoint says running, no live event or checkpoint write for 50m', 'Queue resume', '╰'])
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
  expect(h.calls.process[0]![1]).toMatch(/\/plugin\/\.\.\/dispatcher\/digest\.mjs$/)
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
  expect(digestScript('/p/ocli/plugin/')).toBe('/p/ocli/plugin/../dispatcher/digest.mjs')
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
