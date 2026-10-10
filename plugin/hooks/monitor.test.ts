import { test, expect } from 'claude-code/testing'

import { GLM_LIVE } from './fixtures'
import { harness, NOW, OPTIONS, PANE_PROPS, ROOT, runLines } from './harness'
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
