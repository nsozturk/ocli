import { test, expect, describe } from 'claude-code/testing'

import { AGY, CODEX, GLM_LIVE, MUSE, OPENCODE } from './fixtures'
import { card, cardVariants, clean, colorOf, displayStatus, fitCards, latestAt, parseLines, phasesOf, reduce, runLine, runLines, taskSpan, taskStatus, tokensOf } from './reduce'
import type { Card } from './reduce'
import type { OcliRun } from '../types'

const file = (lines: readonly string[]) => lines.join('\n') + '\n'
const fold = (lines: readonly string[]) => reduce([], parseLines(file(lines)))
const ev = (seq: number, kind: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, runId: 'r1', seq, at: new Date(Date.UTC(2026, 9, 10, 12, 0, seq)).toISOString(),
    task: 't', role: 'implement', cli: 'codex', kind, ...fields })

describe('reduce over the four CLI fixtures (normalized by the real normalize at generation time)', () => {
  const cases = [
    { name: 'codex', lines: CODEX, model: 'gpt-5.6-luna', tools: 1, warns: 3, input: 115922, output: 59 },
    { name: 'opencode', lines: OPENCODE, model: 'zai-coding-plan/glm-5.3', tools: 1, warns: 0, input: 59747, output: 24 },
    // events.mjs no longer emits agy's result.usage when step usage was seen (it repeats their sum).
    { name: 'agy', lines: AGY, model: 'gemini-3.8-flash-medium', tools: 2, warns: 0, input: 43768, output: 645 },
    { name: 'muse', lines: MUSE, model: 'muse', tools: 2, warns: 0, input: null, output: null },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const runs = fold(c.lines)
      expect(runs.length).toBe(1)
      const run = runs[0]!
      expect(run.runId).toBe(`fixture-${c.name}`)
      expect(run.cli).toBe(c.name)
      expect(run.model).toBe(c.model)
      expect(run.status).toBe('completed')
      expect(run.toolCount).toBe(c.tools)
      expect(run.warnCount).toBe(c.warns)
      expect(run.tokens).toEqual({ input: c.input, output: c.output })
      expect(run.lastSeq).toBe(c.lines.length - 1)
      expect(run.exitCode).toBe(0)
      expect(run.lastSummary).toBe('end completed exit 0')
    })
  }
  test('muse run.end.dropped is stored as its total only', () => {
    expect(fold(MUSE)[0]!.dropped).toBe(80)
  })
})

test('the scrubbed real GLM live file folds to one completed run', () => {
  const runs = fold(GLM_LIVE)
  expect(runs.length).toBe(1)
  const run = runs[0]!
  expect(run).toMatchObject({
    runId: '00000000-0000-4000-8000-0000000000a1', task: 'glm-live', role: 'implement', cli: 'opencode',
    model: 'zai-coding-plan/glm-5.3', status: 'completed', toolCount: 37, exitCode: 0, score: 1, ms: 954297, lastSeq: 117,
    tokens: { input: 119333, output: 11149 },
  })
  expect(run.startedAt).toBe(Date.parse('2026-10-10T18:38:57.108Z'))
  expect(run.endedAt).toBe(Date.parse('2026-10-10T18:58:03.413Z'))
})

test('a torn last line is skipped, then folded once complete', () => {
  const whole = file(GLM_LIVE)
  const torn = whole.slice(0, whole.length - 40)
  const partial = reduce([], parseLines(torn))
  expect(partial[0]!.lastSeq).toBe(116)
  expect(partial[0]!.status).toBe('running')
  const done = reduce(partial, parseLines(whole))
  expect(done).toEqual(fold(GLM_LIVE))
})

test('the same file fed twice gives the same state (dedupe by runId + seq)', () => {
  const once = fold(GLM_LIVE)
  const twice = reduce(once, parseLines(file(GLM_LIVE)))
  expect(twice).toEqual(once)
  expect(twice[0]!.toolCount).toBe(37)
})

test('token sums are null-aware: unknown stays null, never 0', () => {
  const runs = fold([
    ev(0, 'run.start', { model: 'm' }),
    ev(1, 'usage', { input: null, output: null, cached: null, reasoning: null }),
    ev(2, 'usage', { input: 5, output: null }),
    ev(3, 'usage', { input: 7, output: null }),
  ])
  expect(runs[0]!.tokens).toEqual({ input: 12, output: null })
})

test('run.end.dropped with hostile keys is counted, never spread into state', () => {
  const runs = fold([
    ev(0, 'run.start'),
    '{"v":1,"runId":"r1","seq":1,"at":"2026-10-10T12:00:01Z","task":"t","role":"r","cli":"c","kind":"run.end","status":"completed","exitCode":0,"dropped":{"__proto__":{"polluted":1},"constructor":2,"x":3}}',
  ])
  expect(runs[0]!.dropped).toBe(5)
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(Object.keys(runs[0]!)).not.toContain('constructor')
  expect(Object.keys(runs[0]!)).not.toContain('x')
})

test('a __proto__ runId does not reach any prototype', () => {
  const runs = reduce([], parseLines(ev(0, 'run.start').replace('"r1"', '"__proto__"') + '\n'))
  expect(runs.map(run => run.runId)).toEqual(['__proto__'])
  expect(({} as Record<string, unknown>).task).toBeUndefined()
})

test('statuses: dispatch-error is kept, an unknown string reads as failed', () => {
  expect(fold([ev(0, 'run.start'), ev(1, 'run.end', { status: 'dispatch-error' })])[0]!.status).toBe('dispatch-error')
  expect(fold([ev(0, 'run.start'), ev(1, 'run.end', { status: 'exploded' })])[0]!.status).toBe('failed')
  expect(fold([ev(0, 'run.start'), ev(1, 'run.end', { status: 7 })])[0]!.status).toBe('failed')
})

test('stale = no run.end and last event older than 10 minutes, computed at render time', () => {
  const run = fold([ev(0, 'run.start'), ev(1, 'step', { label: 'x' })])[0]!
  const last = run.lastAt!
  expect(displayStatus(run, last + 10 * 60_000)).toBe('running')
  expect(displayStatus(run, last + 10 * 60_000 + 1)).toBe('stale')
  const ended = fold([ev(0, 'run.start'), ev(1, 'run.end', { status: 'completed' })])[0]!
  expect(displayStatus(ended, last + 3_600_000)).toBe('completed')
})

test('control characters and ANSI escapes are stripped at ingest', () => {
  expect(clean('x\u202ey\u2066z\u200f')).toBe('xyz')
  // ARABIC LETTER MARK (the third implicit bidi mark), zero-width space and word joiner; ZWJ/ZWNJ stay.
  expect(clean('a\u061cb\u200bc\u2060d')).toBe('abcd')
  expect(clean('\u{1F469}\u200d\u{1F4BB} \u0645\u06cc\u200c\u062e')).toBe('\u{1F469}\u200d\u{1F4BB} \u0645\u06cc\u200c\u062e')
  expect(clean('a\u001b[2Jb\u0007c\u001b]0;title\u0007d\u009b31me\u001bMf\u0000g\u007fh\ni')).toBe('abcdefgh i')
  const run = fold([ev(0, 'run.start', { model: 'evil\u001b[2J' }), ev(1, 'message', { text: 'hi\u001b[31mred\u0007' })])[0]!
  expect(run.model).toBe('evil')
  expect(run.lastSummary).toBe('message: hired')
  const line = runLine(run, run.lastAt!, 200)
  expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
})

test('lastSummary names the latest event; usage leaves it alone', () => {
  const run = fold([
    ev(0, 'run.start'),
    ev(1, 'tool.end', { tool: 'bash', detail: 'cat hello.txt', ok: true }),
    ev(2, 'usage', { input: 1, output: 1 }),
  ])[0]!
  expect(run.lastSummary).toBe('tool.end bash: cat hello.txt')
  expect(run.toolCount).toBe(1)
})

test('runLine fits its columns', () => {
  const run = fold(GLM_LIVE)[0]!
  const line = runLine(run, run.endedAt!, 40)
  expect([...line].length).toBeLessThanOrEqual(40)
  expect(line.startsWith('✓ glm-5.3 (opencode)')).toBe(true)
})

test('a run says which LLM has it, which slice it is and where it works', () => {
  const run = fold([
    ev(0, 'run.start', { cli: 'opencode', model: 'zai-coding-plan/glm-5.3', title: 'Slice 045 \u001b[2Jpane', root: '/w/repo-ocli-pane' }),
    ev(1, 'tool.end', { cli: 'opencode', tool: 'bash', detail: 'npm test', ok: true }),
  ])[0]!
  const [head, what, last] = runLines(run, run.lastAt!, 80)
  expect(head).toContain('glm-5.3 (opencode)')
  expect(head).toContain('implement')
  expect(what).toBe('  Slice 045 pane · repo-ocli-pane')
  expect(last).toBe('  ↳ tool.end bash: npm test')
  for (const line of runLines(run, run.lastAt!, 20)) expect([...line].length).toBeLessThanOrEqual(20)
})

test('a run folded before titles existed still draws (old $.state)', () => {
  const run = { ...fold([ev(0, 'run.start')])[0]! } as Record<string, unknown>
  delete run.title; delete run.where
  expect(() => runLines(run as never, Date.UTC(2026, 9, 10, 12), 60)).not.toThrow()
})

// --- cards -------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 9, 10, 12)
const BASE = fold([ev(0, 'run.start')])[0]!
const mk = (runId: string, over: Partial<OcliRun> = {}): OcliRun =>
  ({ ...BASE, runId, task: 't', startedAt: T0, lastAt: T0, lastSummary: `step: ${runId}`, ...over })
const NOW_C = T0 + 60_000
const STALE_AT = T0 + 11 * 60_000

test('task status precedence: running > blocked > failed-like > all stale > completed', () => {
  const at = (status: OcliRun['status'], lastAt = NOW_C) => mk(status, { status, lastAt })
  const stale = mk('s', { status: 'running', lastAt: T0 })
  expect(taskStatus([at('completed'), at('blocked'), at('failed'), at('running')], NOW_C)).toBe('Running')
  expect(taskStatus([at('completed'), at('failed'), at('blocked')], NOW_C)).toBe('Blocked')
  for (const failed of ['failed', 'spawn-error', 'dispatch-error'] as const) {
    expect(taskStatus([at('completed'), at(failed)], NOW_C)).toBe('Failed')
  }
  expect(taskStatus([stale, at('failed')], STALE_AT)).toBe('Failed')
  expect(taskStatus([stale, { ...stale, runId: 's2' }], STALE_AT)).toBe('Stale')
  expect(taskStatus([stale, at('completed')], STALE_AT)).toBe('Completed')
  expect(taskStatus([at('completed')], NOW_C)).toBe('Completed')
})

test('dot colours: running suggestion, completed success, blocked/stale warning, failed-like error', () => {
  expect(colorOf('running')).toBe('suggestion')
  expect(colorOf('completed')).toBe('success')
  expect(colorOf('blocked')).toBe('warning')
  expect(colorOf('stale')).toBe('warning')
  for (const s of ['failed', 'spawn-error', 'dispatch-error'] as const) expect(colorOf(s)).toBe('error')
})

test('phases come from run.phase in first-seen order; a run without one falls back to its role', () => {
  const runs = [
    mk('c', { phase: 'review', startedAt: T0 + 3000 }),
    mk('a', { phase: 'implement', startedAt: T0 + 1000 }),
    mk('b', { phase: '', role: 'reason', startedAt: T0 + 2000 }),
    mk('d', { phase: 'implement', startedAt: T0 + 4000 }),
  ]
  const old = { ...mk('e', { role: 'easy', startedAt: T0 + 5000 }) } as Record<string, unknown>
  delete old.phase
  const phases = phasesOf([...runs, old as OcliRun])
  expect(phases.map(([name, list]) => [name, list.map(run => run.runId)])).toEqual([
    ['implement', ['a', 'd']], ['reason', ['b']], ['review', ['c']], ['easy', ['e']],
  ])
})

test('tokens: input+output summed over runs; unknown stays unknown', () => {
  expect(tokensOf([mk('a', { tokens: { input: null, output: null } })])).toBeNull()
  expect(tokensOf([mk('a', { tokens: { input: 10, output: 5 } }), mk('b', { tokens: { input: null, output: 7 } })])).toBe(22)
})

test('span: earliest start to latest end, or to now while anything runs', () => {
  const done = [mk('a', { status: 'completed', startedAt: T0, endedAt: T0 + 5000 }), mk('b', { status: 'failed', startedAt: T0 + 1000, endedAt: T0 + 9000 })]
  expect(taskSpan(done, NOW_C)).toBe(9000)
  expect(taskSpan([...done, mk('c', { startedAt: T0 + 2000, lastAt: NOW_C })], NOW_C)).toBe(60_000)
})

const texts = (c: Card) => c.rows.map(row => row.kind === 'text' ? row.text : row.kind === 'split' ? row.left + row.right : row.prefix + row.dots.map(() => '●').join('') + row.tail + row.right)

test('a card: header, status, runs and tokens, description, phases with dots, done/total and LLMs', () => {
  const runs = [
    mk('a', { phase: 'implement', model: 'openai/gpt-6-astra', cli: 'codex', status: 'completed', startedAt: T0, endedAt: T0 + 5000, tokens: { input: 1000, output: 500 }, title: 'old title' }),
    mk('b', { phase: 'implement', model: 'zai-coding-plan/glm-5.3', cli: 'opencode', status: 'running', startedAt: T0 + 2000, lastAt: NOW_C, lastSummary: 'tool.end bash: npm test', title: 'Slice 046 cards' }),
    mk('c', { phase: 'review', model: 'zai-coding-plan/glm-5.3', status: 'blocked', startedAt: T0 + 1000, endedAt: T0 + 3000 }),
    mk('d', { phase: 'implement', model: 'openai/gpt-6-astra', status: 'failed', startedAt: T0 + 3000, endedAt: T0 + 4000 }),
  ]
  const c = card('t', runs, NOW_C, 60, () => false)
  expect(c.color).toBe('suggestion')
  expect(c.height).toBe(c.rows.length + 2)
  const lines = texts(c)
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60)
  expect(lines[0]).toMatch(/^t +1m00s$/)
  expect(lines[1]!.trimEnd()).toBe('ocli · Running')
  expect(lines[2]!.trimEnd()).toBe('4 runs · 2k tokens')
  expect(lines[3]!.trimEnd()).toBe('Slice 046 cards')
  expect(lines[4]!.trimEnd()).toBe('Phases')
  expect(lines[5]).toMatch(/^▸ implement ●●● gpt-6-astra, glm-5.3 +2\/3$/)
  const impl = c.rows[5]!
  if (impl.kind !== 'phase') throw new Error('not a phase row')
  expect(impl.dots).toEqual(['success', 'suggestion', 'error'])
  expect(impl.open).toBe('t/implement')
  expect(lines[6]!.trimEnd()).toBe('  ↳ tool.end bash: npm test')
  expect(lines[7]).toMatch(/^▸ review ● glm-5.3 +1\/1$/)
  expect(lines.length).toBe(8)
})

test('an expanded phase lists its runs with runLines and no second live line', () => {
  const runs = [mk('a', { phase: 'implement', status: 'running', lastAt: NOW_C, lastSummary: 'step: x', title: 'S', where: 'wt' })]
  const open = texts(card('t', runs, NOW_C, 60, key => key === 't/implement'))
  expect(open[5]).toMatch(/^▾ implement/)
  const rest = open.slice(6).map(line => line.trimEnd())
  expect(rest).toEqual(runLines(runs[0]!, NOW_C, 58).map(line => `  ${line}`.trimEnd()))
  expect(rest.filter(line => line.includes('↳')).length).toBe(1)
})

test('cards are cut whole: one that does not fit is skipped and counted; an open card falls back to closed', () => {
  const box = (key: string, height: number): Card => ({ key, rows: [], height })
  expect(fitCards([[box('a', 4)], [box('b', 4)], [box('c', 4)]], 8).shown.map(c => c.key)).toEqual(['a'])
  expect(fitCards([[box('a', 4)], [box('b', 4)], [box('c', 4)]], 8).cut).toEqual([1, 2])
  expect(fitCards([[box('a', 4)], [box('b', 4)]], 8).shown.map(c => c.key)).toEqual(['a', 'b'])
  expect(fitCards([[box('a', 4)], [box('b', 5)]], 8).shown.map(c => c.key)).toEqual(['a'])
  expect(fitCards([[box('open', 9), box('closed', 4)]], 5).shown.map(c => c.key)).toEqual(['closed'])
  // A card too tall in every form does not hide the smaller ones after it; the "more" row is kept.
  expect(fitCards([[box('a', 9)], [box('b', 2)]], 5)).toEqual({ shown: [box('b', 2)], cut: [0] })
  expect(fitCards([[box('a', 9)], [box('b', 4)]], 4)).toEqual({ shown: [], cut: [0, 1] })
})

test('a busy task too tall even closed is drawn as its header, not hidden, and does not hide the older blocked task', () => {
  const busy = Array.from({ length: 25 }, (_, i) =>
    mk(`n${i}`, { task: 'noisy', phase: `p${i}`, status: 'running', lastAt: NOW_C - 1000, lastSummary: 'tool.end bash: x' }))
  const legit = [mk('b', { task: 'legit', status: 'blocked', endedAt: T0 + 1000 })]
  const noisy = cardVariants('noisy', busy, NOW_C, 46, [])
  const header = noisy.at(-1)!
  expect(header.rows.map(row => row.kind === 'text' ? row.text : row.kind === 'split' ? (row.left + row.right) : '').map(t => t.trimEnd()))
    .toEqual([expect.stringMatching(/^noisy +\d/), 'ocli · Running', '25 runs · ? tokens', '25 phases · pane too short to list them'])
  const agents: Card = { key: 'agents', rows: [], height: 3 }
  const fitted = fitCards([noisy, cardVariants('legit', legit, NOW_C, 46, []), [agents]], 23)
  expect(fitted.shown.map(c => c.key)).toEqual(['task:noisy', 'task:legit', 'agents'])
  expect(fitted.shown[0]).toBe(header)
  expect(fitted.shown[1]).toEqual(card('legit', legit, NOW_C, 46, () => false))
  expect(fitted.cut).toEqual([])
})

test('variants close the earliest-expanded phase first, so the newest expansion is the one that survives', () => {
  const runs = ['A', 'A', 'B', 'B'].map((phase, i) => mk(`r${i}`, { phase, status: 'completed', endedAt: T0 + 1000, title: 'S', where: 'wt' }))
  const opened = (c: Card) => c.rows.flatMap(row => row.kind === 'phase' && row.isOpen ? [row.open] : [])
  const variants = cardVariants('t', runs, NOW_C, 60, ['other/X', 't/A', 't/B'])
  expect(variants.map(opened)).toEqual([['t/A', 't/B'], ['t/B'], [], []])
  expect(variants.map(c => c.height)).toEqual([...variants.map(c => c.height)].sort((a, b) => b - a))
})

/** An independent count of terminal cells: emoji and Han characters take two. */
const cellsOf = (text: string) => [...text].reduce((n, ch) => n + (/\p{Extended_Pictographic}|\p{Script=Han}/u.test(ch) ? 2 : 1), 0)

test('wide glyphs count two cells: no card row is wider than its columns', () => {
  const runs = [
    mk('a', { task: '漢字'.repeat(40), phase: '\u{1F680}'.repeat(30), title: '漢'.repeat(80), status: 'running', lastAt: NOW_C, lastSummary: '\u{1F600}'.repeat(80) }),
    mk('b', { phase: '漢字のフェーズ'.repeat(6), model: 'm/' + '\u{1F916}'.repeat(40), status: 'completed', endedAt: T0 + 1000 }),
  ]
  for (const columns of [20, 46, 60]) {
    const c = card('漢字'.repeat(40), runs, NOW_C, columns, () => true)
    for (const line of texts(c)) expect(cellsOf(line)).toBeLessThanOrEqual(columns)
  }
})

test('a long phase name gives way to the dots and the LLM names; dropped dots are counted', () => {
  const long = 'implement the very long phase label'
  const of = (n: number) => {
    const runs = Array.from({ length: n }, (_, i) => mk(`l${i}`, { phase: long, model: 'openai/gpt', status: 'completed', endedAt: T0 + 1000 }))
    const row = card('t', runs, NOW_C, 46, () => false).rows.find(r => r.kind === 'phase')!
    if (row.kind !== 'phase') throw new Error('not a phase row')
    return row
  }
  const ten = of(10)
  expect(ten.dots.length).toBe(10)
  expect(ten.tail).toContain('gpt')
  expect(ten.tail).not.toContain('+')
  const sixty = of(60)
  const hidden = Number(/\+(\d+)/.exec(sixty.tail)?.[1])
  expect(sixty.dots.length + hidden).toBe(60)
  expect(sixty.dots.length).toBeGreaterThan(10)
  expect(sixty.right).toBe('60/60')
})

// A spread of the runs overflows the stack at ~200k arguments under Node and between 500k and 1M in
// this kit's runtime (measured), so 1M runs.
test('span and latest activity over 1M runs do not overflow the stack', () => {
  const many = Array.from({ length: 1_000_000 }, (_, i) => mk(`s${i}`, { status: 'completed', startedAt: T0 + i, endedAt: T0 + i + 10, lastAt: T0 + i + 10 }))
  expect(taskSpan(many, NOW_C)).toBe(999_999 + 10)
  expect(latestAt(many)).toBe(T0 + 999_999 + 10)
  expect(latestAt([mk('x', { lastAt: null })])).toBe(0)
})

test('a card from an old $.state run (no phase, title or where) still draws', () => {
  const run = { ...mk('a') } as Record<string, unknown>
  delete run.phase; delete run.title; delete run.where
  const c = card('t', [run as OcliRun], NOW_C, 40, () => true)
  expect(texts(c).some(line => line.startsWith('▾ implement'))).toBe(true)
})
