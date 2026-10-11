import { test, expect, describe } from 'claude-code/testing'

import { AGY, CODEX, GLM_LIVE, MUSE, OPENCODE } from './fixtures'
import { card, cardVariants, checkpointCard, checkpointDrift, clean, colorOf, displayStatus, fitCards, foldPlan, HEADER_HEIGHT, latestAt, parseCheckpoint, parseLines, resumePrompt, phasesOf, reduce, runLine, runLines, taskSpan, taskStatus, tokensOf } from './reduce'
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

const texts = (c: Card) => c.rows.map(row => row.kind === 'text' ? row.text : row.kind === 'split' ? row.left + row.right : row.kind === 'button' ? row.label : row.prefix + row.dots.map(() => '●').join('') + row.tail + row.right)

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

// --- declared phases (plan.json) ---------------------------------------------------------------

test('foldPlan: v1 with a phases array; names cleaned, emptied ones dropped, deduped, capped at 50', () => {
  const plan = (value: unknown) => foldPlan(JSON.stringify(value))
  expect(plan({ v: 1, phases: [{ name: 'implement' }, { name: 're\u001b[31mview' }, { name: '' }, { name: 'implement' }, { name: 7 }, null, 'merge', { name: 'x'.repeat(60) }], declaredAt: 'z' }))
    .toEqual(['implement', 'review', 'x'.repeat(40)])
  // An empty plan is malformed (dispatch.mjs refuses one): null, so it costs an error and draws no card.
  expect(plan({ v: 1, phases: [] })).toBeNull()
  expect(plan({ v: 1, phases: [{ name: '\u0007' }, { name: '  ' }, { name: 3 }] })).toBeNull()
  expect(plan({ v: 1, phases: Array.from({ length: 70 }, (_, i) => ({ name: `p${i}` })) })).toHaveLength(50)
  for (const bad of [{ v: 2, phases: [{ name: 'a' }] }, { phases: [{ name: 'a' }] }, { v: '1', phases: [{ name: 'a' }] }, { v: 1, phases: 'a' }, { v: 1 }, [1], null, 'plan']) {
    expect(plan(bad)).toBeNull()
  }
  expect(foldPlan('{"v":1,"phases":[')).toBeNull()
  expect(foldPlan('')).toBeNull()
})

test('phasesOf: declared phases first in declared order (even with no runs), then undeclared in first-seen order', () => {
  const runs = [
    mk('u', { phase: 'hotfix', startedAt: T0 + 1000 }),
    mk('r', { phase: 'review', startedAt: T0 + 2000 }),
    mk('i', { phase: 'implement', startedAt: T0 + 3000 }),
  ]
  const phases = phasesOf(runs, ['implement', 'review', 'merge', 'implement'])
  expect(phases.map(([name, list]) => [name, list.map(run => run.runId)])).toEqual([
    ['implement', ['i']], ['review', ['r']], ['merge', []], ['hotfix', ['u']],
  ])
  expect(phasesOf(runs).map(([name]) => name)).toEqual(['hotfix', 'review', 'implement'])
})

test('a declared phase with no runs draws as a pending row: no dots, "declared", 0/0; the count row says D/M phases', () => {
  const runs = [
    mk('a', { phase: 'implement', status: 'completed', startedAt: T0, endedAt: T0 + 5000 }),
    mk('x', { phase: 'extra', status: 'completed', startedAt: T0 + 6000, endedAt: T0 + 7000 }),
  ]
  const c = card('t', runs, NOW_C, 60, () => false, false, ['implement', 'review', 'merge'])
  const lines = texts(c)
  expect(lines[2]!.trimEnd()).toBe('2 runs · ? tokens · 2/4 phases')
  const rows = c.rows.filter(r => r.kind === 'phase')
  expect(rows.map(r => r.kind === 'phase' && r.prefix.trim())).toEqual(['▸ implement', '▸ review', '▸ merge', '▸ extra'])
  const review = rows[1]!
  if (review.kind !== 'phase') throw new Error('not a phase row')
  expect(review).toMatchObject({ dots: [], right: '0/0', isPending: true })
  expect(review.tail.trim()).toBe('declared')
  expect(rows[0]!.kind === 'phase' && rows[0]!.isPending).toBeFalsy()
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60)
  expect(lines.find(line => line.startsWith('▸ review'))).toMatch(/^▸ review +declared +0\/0$/)
  // The header form counts the declared phases too.
  const header = texts(card('t', runs, NOW_C, 60, () => false, true, ['implement', 'review', 'merge']))
  expect(header[2]!.trimEnd()).toBe('2 runs · ? tokens · 2/4 phases')
  expect(header[3]!.trimEnd()).toBe('4 phases · pane too short to list them')
  // No plan: the count row is as before.
  expect(texts(card('t', runs, NOW_C, 60, () => false))[2]!.trimEnd()).toBe('2 runs · ? tokens')
})

test('done rule: a phase is done only with a run and none running or stale', () => {
  const done = (list: OcliRun[], now = NOW_C) => texts(card('t', list, now, 60, () => false, false, ['p', 'q']))[2]!.trimEnd()
  const completed = mk('a', { phase: 'p', status: 'completed', endedAt: T0 + 1000 })
  expect(done([completed])).toBe('1 run · ? tokens · 1/2 phases')
  expect(done([completed, mk('b', { phase: 'p', status: 'running', lastAt: NOW_C })])).toBe('2 runs · ? tokens · 0/2 phases')
  expect(done([completed, mk('s', { phase: 'p', status: 'running', lastAt: T0 })], T0 + 11 * 60_000)).toBe('2 runs · ? tokens · 0/2 phases')
  expect(done([completed, mk('f', { phase: 'p', status: 'failed', endedAt: T0 + 1000 })])).toBe('2 runs · ? tokens · 1/2 phases')
  expect(done([completed, mk('c', { phase: 'q', status: 'blocked', endedAt: T0 + 1000 })])).toBe('2 runs · ? tokens · 2/2 phases')
})

test('a narrow card keeps the D/M phases figure: it leads the count row when the whole row does not fit', () => {
  const runs = [
    mk('a', { phase: 'implement', status: 'completed', endedAt: T0 + 1000, tokens: { input: 1500, output: 500 } }),
    mk('b', { phase: 'review', status: 'running', lastAt: NOW_C }),
  ]
  const count = (columns: number, isHeader = false) => texts(card('t', runs, NOW_C, columns, () => false, isHeader, ['implement', 'review', 'merge']))[2]!.trimEnd()
  expect(count(40)).toBe('2 runs · 2k tokens · 1/3 phases')
  expect(count(26)).toBe('1/3 phases · 2 runs · 2k …')
  expect(count(16)).toBe('1/3 phases · 2 …')
  expect(count(16, true)).toBe('1/3 phases · 2 …')
  // No plan: the row is cut as before.
  expect(texts(card('t', runs, NOW_C, 16, () => false))[2]!.trimEnd()).toBe('2 runs · 2k tok…')
})

test('the header form is the shortest form of every task card, HEADER_HEIGHT rows', () => {
  const runs = [mk('a', { phase: 'implement', status: 'completed', endedAt: T0 + 1000, title: 'why' }), mk('b', { phase: 'review', lastAt: NOW_C })]
  for (const [list, declared] of [[runs, []], [runs, ['x', 'y']], [[], ['only']], [runs.slice(0, 1), []]] as const) {
    const variants = cardVariants('t', list, NOW_C, 46, ['t/implement'], declared)
    expect(variants.at(-1)!.height).toBe(HEADER_HEIGHT)
    expect(Math.min(...variants.map(v => v.height))).toBe(HEADER_HEIGHT)
  }
})

test('fitCards builds a lazy card only while its shortest form could still fit', () => {
  const box = (key: string, height: number): Card => ({ key, rows: [], height })
  let built = 0
  const lazy = (key: string, ...heights: number[]) => () => {
    built += 1
    return heights.map((height, i) => box(`${key}${i}`, height))
  }
  const cards = Array.from({ length: 500 }, (_, i) => lazy(`t${i}:`, 55, 6))
  const fitted = fitCards([...cards, [box('agents', 3)]], 30, 6)
  // Each built card is drawn in its 6-row form: four fit with a row kept for "more", the rest are cut unbuilt.
  expect(fitted.shown.map(c => c.key)).toEqual(['t0:1', 't1:1', 't2:1', 't3:1', 'agents'])
  expect(fitted.cut.length).toBe(496)
  expect(built).toBe(4)
  // The same cards built eagerly fit the same way.
  built = 0
  const eager = fitCards([...cards.map(c => c()), [box('agents', 3)]], 30)
  expect(eager).toEqual(fitted)
})

test('a plan with no runs yet is a card of pending rows: neutral status, no border colour, 0/M phases', () => {
  const c = card('t', [], NOW_C, 46, () => true, false, ['a', 'b', 'c'])
  const lines = texts(c).map(line => line.trimEnd())
  expect(c.color).toBeUndefined()
  expect(lines.slice(1, 3)).toEqual(['ocli · Declared', '0 runs · ? tokens · 0/3 phases'])
  expect(lines.slice(3)).toEqual(['Phases', expect.stringMatching(/^▾ a +declared +0\/0$/), expect.stringMatching(/^▾ b +declared/), expect.stringMatching(/^▾ c +declared/)])
  const variants = cardVariants('t', [], NOW_C, 46, ['t/a'], ['a', 'b', 'c'])
  expect(variants.slice(0, -1).every(v => v.rows.filter(r => r.kind === 'phase').length === 3)).toBe(true)
  expect(texts(variants.at(-1)!).map(line => line.trimEnd()).slice(2)).toEqual(['0 runs · ? tokens · 0/3 phases', '3 phases · pane too short to list them'])
})

// --- the witness: run.end.witness.findings (codes) from dispatch ---------------------------------
const endWith = (witness: unknown) => fold([ev(0, 'run.start'), ev(1, 'run.end', { status: 'completed', exitCode: 0, ms: 1, score: null, dropped: {}, witness })])[0]!

test('run.end witness codes are parsed: strings only, cleaned to 40, at most 10', () => {
  expect(endWith({ findings: ['claimedTestsButNone', 'staleGreen'] }).witness).toEqual(['claimedTestsButNone', 'staleGreen'])
  const dirty = endWith({ findings: ['\u001b[31mstale\u001b[0mGreen‮', 7, null, { code: 'x' }, 'x'.repeat(60), '\u0007'] }).witness
  expect(dirty).toEqual(['staleGreen', 'x'.repeat(40)])
  expect(endWith({ findings: Array.from({ length: 15 }, (_, i) => `c${i}`) }).witness).toHaveLength(10)
  expect(endWith({ findings: [] }).witness).toEqual([])
})

test('a witness that is not {findings: [...]} is ignored, and a run.end without one leaves none', () => {
  for (const witness of [['claimedTestsButNone'], 'staleGreen', { findings: 'staleGreen' }, null, 3, { error: 'boom' }]) {
    expect(endWith(witness).witness, JSON.stringify(witness)).toBeUndefined()
  }
  expect(fold([ev(0, 'run.start'), ev(1, 'run.end', { status: 'completed' })])[0]!.witness).toBeUndefined()
})

test('an unwitnessed run gets a last line naming its findings, cut to the columns', () => {
  const run = endWith({ findings: ['claimedTestsButNone', 'staleGreen'] })
  const lines = runLines(run, run.lastAt!, 80)
  expect(lines.at(-1)).toBe('  ⚠ unwitnessed: claimedTestsButNone, staleGreen')
  expect(runLines(run, run.lastAt!, 20).at(-1)).toMatch(/^ {2}⚠ unwitnessed: .*…$/)
  for (const clean of [endWith({ findings: [] }), endWith(undefined)]) {
    expect(runLines(clean, clean.lastAt!, 80).some(line => line.includes('unwitnessed'))).toBe(false)
  }
})

test('the card colours the unwitnessed line warning, not dim, and the phase row says ⚠N', () => {
  const flagged = (runId: string) => mk(runId, { phase: 'implement', status: 'completed', endedAt: T0 + 1000, witness: ['staleGreen'] })
  const runs = [flagged('a'), mk('b', { phase: 'implement', status: 'completed', endedAt: T0 + 2000, witness: [] }), flagged('c'), mk('d', { phase: 'review', status: 'completed', endedAt: T0 + 3000 })]
  const c = card('t', runs, NOW_C, 60, key => key === 't/implement')
  const warned = c.rows.filter(row => row.kind === 'text' && row.text.includes('⚠ unwitnessed'))
  expect(warned).toHaveLength(2)
  for (const row of warned) expect(row).toMatchObject({ color: 'warning', isDim: false, text: '    ⚠ unwitnessed: staleGreen' })
  const lines = texts(c)
  expect(lines.find(line => line.startsWith('▾ implement'))).toMatch(/^▾ implement ●●● ⚠2 \S.* 3\/3$/)
  expect(lines.find(line => line.startsWith('▸ review'))).not.toContain('⚠')
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60)
})

// --- checkpoint card -----------------------------------------------------------------------------

// A real lead checkpoint with its names scrubbed (its table, Next action and Resume).
const OVERNIGHT = `# 2026-10-11 overnight — ocli features, then project development

Lead: Claude Opus 5.5 (Claude Code).

## Phases
| # | Phase | Status | Evidence |
|---|---|---|---|
| 0 | Cards merged to main, mod reloaded | done | b0ccaca; 103 files / 2151 tests; plugin test 64/64 |
| 1 | Ideation workflow (creative-ideation, diverge, the-third-answer, becreative) -> ranked ocli feature set | done | wf_00000000-001: 31 ideas, 7 picked; checkpoints/2026-10-11_ocli-roadmap.md |
| 2 | Build ocli features (workflow, sequential per feature on one branch) | running | batch1 (verify-honest-score, declared-phases, witness-claims) wf_00000000-002 in ../myproj-ocli-night (feature/claude-opus5-001-ocli-night); batch2/3 args in tmp/agent-ocli-live/batch{2,3}.json; script ocli-night-features (path in Resume) |
| 3 | Port ocli changes into local public package (no push) | pending | |
| 4 | Project: CONTINUATION next action via Opus-high workflows | pending | |
| 5 | Morning report | pending | |

## Open items carried in
- Package review found \`--verify\` can score 1 on a CLI run that failed/never ran.

## Next action
Phase 1 running (wf_00000000-001); on completion pick the build set and launch phase 2.

## Resume
- Night feature script: /proj/.claude/projects/x/workflows/scripts/ocli-night-features-wf_00000000-003.js
  (args = contents of tmp/agent-ocli-live/batchN.json; resume a cut run with resumeFromRunId).
\`cd /proj/myproj && cat checkpoints/2026-10-11_overnight-ocli-myproj.md && git log --oneline -8\`
`
const CP_NAME = '2026-10-11_overnight-ocli-myproj.md'

test('the real overnight checkpoint parses to its phase table, next action and resume command', () => {
  const cp = parseCheckpoint(CP_NAME, OVERNIGHT)!
  expect(cp.name).toBe(CP_NAME)
  expect(cp.rows.map(r => [r.n, r.status])).toEqual([['0', 'done'], ['1', 'done'], ['2', 'running'], ['3', 'pending'], ['4', 'pending'], ['5', 'pending']])
  expect(cp.rows[0]!.phase).toBe('Cards merged to main, mod reloaded')
  for (const row of cp.rows) expect([...row.phase].length).toBeLessThanOrEqual(80)
  expect(cp.next).toBe('Phase 1 running (wf_00000000-001); on completion pick the build set and launch phase 2.')
  expect(cp.resume).toBe('cd /proj/myproj && cat checkpoints/2026-10-11_overnight-ocli-myproj.md && git log --oneline -8')
})

test('a checkpoint with no table and no next action is null; next alone is enough', () => {
  expect(parseCheckpoint('a.md', '# title\n\nsome prose\n\n## Resume\n`x`\n')).toBeNull()
  expect(parseCheckpoint('a.md', '')).toBeNull()
  expect(parseCheckpoint('a.md', '## next ACTION\n\nship it\nnow\n\nlater')).toMatchObject({ rows: [], next: 'ship it now', resume: '' })
})

test('a table without a Status column is ignored; the first one with Phase and Status is used', () => {
  const md = '| # | Phase | Evidence |\n|---|---|---|\n| 1 | wrong | x |\n\n| # | PHASE | status |\n|:-:|---|---|\n| 7 | right | Done |\n'
  expect(parseCheckpoint('a.md', md)!.rows).toEqual([{ n: '7', phase: 'right', status: 'Done' }])
  expect(parseCheckpoint('a.md', '| # | Phase | Evidence |\n|---|---|---|\n| 1 | wrong | x |\n')).toBeNull()
})

test('pipes inside backticks make ragged rows, never a crash; cells are cleaned', () => {
  const md = '| Phase | Status |\n|---|---|\n| run `a | b` now | done |\n| \u001b[31mred\u001b[0m | running |\n| lone |\n'
  const cp = parseCheckpoint('a.md', md)!
  expect(cp.rows.length).toBe(3)
  expect(cp.rows[1]).toEqual({ n: '2', phase: 'red', status: 'running' })
  expect(cp.rows[2]).toEqual({ n: '3', phase: 'lone', status: '' })
})

test('drift: a running row with no live event for more than 30 minutes', () => {
  const cp = parseCheckpoint(CP_NAME, OVERNIGHT)!
  const now = Date.parse('2026-10-11T10:00:00Z')
  expect(checkpointDrift(cp, now - 29 * 60_000, now)).toBeNull()
  expect(checkpointDrift(cp, now - 31 * 60_000, now)).toBe('checkpoint says running, no live event or checkpoint write for 31m')
  expect(checkpointDrift(cp, null, now)).toBe('checkpoint says running, no live event seen')
  const idle = { ...cp, rows: cp.rows.map(r => ({ ...r, status: 'done' })) }
  expect(checkpointDrift(idle, null, now)).toBeNull()
})

test('the checkpoint card: name and done/total, a coloured dim row per phase, next, resume dim, the drift line and the button', () => {
  const cp = { ...parseCheckpoint(CP_NAME, '| # | Phase | Status |\n|---|---|---|\n| 1 | a | done |\n| 2 | b | Running |\n| 3 | c | blocked |\n| 4 | d | pending |\n\n## Next action\ngo\n\n## Resume\n`cmd`\n')! }
  const c = checkpointCard(cp, 'checkpoint says running, no live event for 31m', 60)
  expect(c.key).toBe('checkpoint')
  expect(c.height).toBe(c.rows.length + 2)
  expect(c.rows[0]).toMatchObject({ kind: 'split', right: '1/4' })
  const head = c.rows[0] as { left: string; right: string }
  expect((head.left + head.right).length).toBe(60)
  expect(head.left.trimEnd()).toBe(CP_NAME)
  expect(c.rows.slice(1, 5)).toEqual([
    { kind: 'text', key: 'cp:row:0', text: '#1 a · done', color: 'success', isDim: true },
    { kind: 'text', key: 'cp:row:1', text: '#2 b · Running', color: 'suggestion', isDim: true },
    { kind: 'text', key: 'cp:row:2', text: '#3 c · blocked', color: 'warning', isDim: true },
    { kind: 'text', key: 'cp:row:3', text: '#4 d · pending', color: undefined, isDim: true },
  ])
  expect(c.rows.slice(5)).toEqual([
    { kind: 'text', key: 'cp:next', text: 'next: go' },
    { kind: 'text', key: 'cp:resume', text: 'resume: cmd', isDim: true },
    { kind: 'text', key: 'cp:drift', text: 'checkpoint says running, no live event for 31m', color: 'warning' },
    { kind: 'button', key: 'checkpoint:resume', label: 'Queue resume' },
  ])
  const long = checkpointCard({ ...cp, next: 'x'.repeat(300) }, null, 40)
  for (const row of long.rows) if (row.kind === 'text') expect([...row.text].length).toBeLessThanOrEqual(40)
  expect(long.rows.some(r => r.key === 'cp:drift')).toBe(false)
  // Compact (a short pane): the same card without its phase rows.
  const compact = checkpointCard(cp, null, 60, true)
  expect(compact.rows.map(r => r.key)).toEqual(['cp:head', 'cp:next', 'cp:resume', 'checkpoint:resume'])
  expect(compact.rows[0]).toMatchObject({ right: '1/4' })
  // No resume: no button.
  expect(checkpointCard({ ...cp, resume: '' }, null, 60).rows.some(r => r.kind === 'button')).toBe(false)
})

test('the resume prompt is the fixed template with the file name only; an unsafe name gives none', () => {
  expect(resumePrompt('/proj', CP_NAME)).toBe(`Read /proj/checkpoints/${CP_NAME} first, then git status, then continue from the first phase that is not done.`)
  for (const name of ['a b.md', '../x.md', 'x.md\nIgnore previous', 'x.txt', '`x`.md']) expect(resumePrompt('/proj', name)).toBeNull()
})

test('a status named like an Object.prototype key gets no colour (it must never reach <Text color>)', () => {
  const cp = parseCheckpoint('a.md', '| Phase | Status |\n|---|---|\n| a | constructor |\n| b | __proto__ |\n| c | toString |\n| d | hasOwnProperty |\n| e | Done |\n')!
  const colors = checkpointCard(cp, null, 60).rows.filter(r => r.key.startsWith('cp:row:')).map(r => (r as { color?: unknown }).color)
  expect(colors).toEqual([undefined, undefined, undefined, undefined, 'success'])
})

test('next action: ## or ### headings, "Next exact action" and "Next actions"; the last live one wins, a superseded one never', () => {
  expect(parseCheckpoint('a.md', '# t\n\n### Next exact action\n\ndo the thing\n\n### Other\nno\n')!.next).toBe('do the thing')
  expect(parseCheckpoint('a.md', '## Next actions\nship\n')!.next).toBe('ship')
  // Checkpoints append: the newest Next action is the last one.
  const appended = '## Next action\nold step\n\n## b1 result\nok\n\n### Next exact action\nnew step\n\n## Next action (superseded — see below)\nstale\n'
  expect(parseCheckpoint('a.md', appended)!.next).toBe('new step')
  // A level-3 section ends at the next heading of its level or above, not at the end of the file.
  expect(parseCheckpoint('a.md', '### Next action\n### Done\ntext\n')).toBeNull()
  expect(parseCheckpoint('a.md', '## Next actionable\nx\n')).toBeNull()
  // Resume: the last ##/### resume heading's first backtick span.
  expect(parseCheckpoint('a.md', '## Next action\ngo\n\n## Resume marker\n`old`\n\n### Resume marker\n`new cmd`\n')!.resume).toBe('new cmd')
})

test('the resume prompt refuses a project root that clean() would change', () => {
  for (const root of ['/a  b', '/a\tb', '/a\nb', '/a ', `/${'x'.repeat(400)}`]) expect(resumePrompt(root, CP_NAME)).toBeNull()
  expect(resumePrompt('/a b', CP_NAME)).toBe(`Read /a b/checkpoints/${CP_NAME} first, then git status, then continue from the first phase that is not done.`)
})
