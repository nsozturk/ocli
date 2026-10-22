import { test, expect, describe } from 'claude-code/testing'

import { AGY, CODEX, GLM_LIVE, MUSE, OPENCODE } from './fixtures'
import { addHistory, card, cardVariants, cells, checkpointCard, checkpointDrift, clean, colorOf, displayStatus, fitCards, foldHistory, foldPlan, HEADER_HEIGHT, historyEntry, historyVariants, isDismissed, isDismissible, isLooping, latestAt, parseCheckpoint, parseLines, resumePrompt, phasesOf, reduce, runDetail, runLine, sparkline, taskSpan, taskStatus, tokensOf, wrap } from './reduce'
import { foldQuota, quotaLine, quotaVariants } from './reduce'
import type { Card } from './reduce'
import { SNAPSHOT } from './quota-fixtures'
import type { OcliQuota, OcliRun } from '../types'

const file = (lines: readonly string[]) => lines.join('\n') + '\n'
const fold = (lines: readonly string[]) => reduce([], parseLines(file(lines)))
const ev = (seq: number, kind: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, runId: 'r1', seq, at: new Date(Date.UTC(2026, 9, 10, 12, 0, seq)).toISOString(),
    task: 't', role: 'implement', cli: 'codex', kind, ...fields })

describe('reduce over the four CLI fixtures (normalized by the real normalize at generation time)', () => {
  const cases = [
    { name: 'codex', lines: CODEX, model: 'gpt-5.6-luna', tools: 1, warns: 3, input: 115922, output: 59, cached: 64768 },
    { name: 'opencode', lines: OPENCODE, model: 'zai-coding-plan/glm-5.3', tools: 1, warns: 0, input: 59747, output: 24, cached: 59840 },
    // events.mjs no longer emits agy's result.usage when step usage was seen (it repeats their sum).
    { name: 'agy', lines: AGY, model: 'gemini-3.8-flash-medium', tools: 2, warns: 0, input: 43768, output: 645, cached: 74142 },
    { name: 'muse', lines: MUSE, model: 'muse', tools: 2, warns: 0, input: null, output: null, cached: undefined },
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
      // muse reports no usage: its tokens carry no cached key at all.
      expect(run.tokens).toEqual({ input: c.input, output: c.output, cached: c.cached })
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
  expect(runs[0]!.tokens).toEqual({ input: 12, output: null, cached: null })
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
  const [head, what, where, , last] = runDetail(run, run.lastAt!, 80).map(line => line.text)
  expect(head).toContain('glm-5.3 (opencode)')
  expect(head).toContain('implement')
  // No brief from this dispatcher: the title says what the run is for.
  expect(what).toBe('  Slice 045 pane')
  expect(where).toBe('  in /w/repo-ocli-pane')
  // Running: the sparkline leads the live line, both events in its newest cell.
  expect(last).toBe(`  ${' '.repeat(9)}█ ↳ tool.end bash: npm test`)
  for (const line of runDetail(run, run.lastAt!, 20)) expect([...line.text].length).toBeLessThanOrEqual(20)
})

test('a run folded before titles existed still draws (old $.state)', () => {
  const run = { ...fold([ev(0, 'run.start')])[0]! } as Record<string, unknown>
  delete run.title; delete run.where
  expect(() => runDetail(run as never, Date.UTC(2026, 9, 10, 12), 60)).not.toThrow()
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

const rowText = (row: Card['rows'][number]): string =>
  row.kind === 'head' ? row.label + row.pad + row.right + (row.dismiss ? ' ×' : '')
    : row.kind === 'press' ? row.label + row.text
      : row.kind === 'text' ? row.text : row.kind === 'split' ? row.left + row.right : row.kind === 'button' ? row.label
        : row.kind === 'segs' ? row.segs.map(seg => seg.text).join('') : row.prefix + row.dots.map(() => '●').join('') + row.tail + row.right
const texts = (c: Card) => c.rows.map(rowText)

test('a card: header, status, runs and tokens, description, phases with dots, done/total and LLMs', () => {
  const runs = [
    mk('a', { phase: 'implement', model: 'openai/gpt-6-astra', cli: 'codex', status: 'completed', startedAt: T0, endedAt: T0 + 5000, tokens: { input: 1000, output: 500 }, title: 'old title' }),
    mk('b', { phase: 'implement', model: 'zai-coding-plan/glm-5.3', cli: 'opencode', status: 'running', startedAt: T0 + 2000, lastAt: NOW_C, lastSummary: 'tool.end bash: npm test', title: 'Slice 046 cards' }),
    mk('c', { phase: 'review', model: 'zai-coding-plan/glm-5.3', status: 'blocked', startedAt: T0 + 1000, endedAt: T0 + 3000 }),
    mk('d', { phase: 'implement', model: 'openai/gpt-6-astra', status: 'failed', startedAt: T0 + 3000, endedAt: T0 + 4000 }),
  ]
  const c = card('t', runs, NOW_C, 60, false)
  expect(c.color).toBe('suggestion')
  expect(c.height).toBe(c.rows.length + 2)
  const lines = texts(c)
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60)
  expect(lines[0]).toMatch(/^▸ t +1m00s$/)
  expect(lines[1]!.trimEnd()).toBe('ocli · Running')
  expect(lines[2]!.trimEnd()).toBe('4 runs · 2k tokens')
  expect(lines[3]!.trimEnd()).toBe('Slice 046 cards')
  expect(lines[4]!.trimEnd()).toBe('Phases')
  expect(lines[5]).toBe('  implement  ●●●  gpt-6-astra, glm-5.3 · 2/3 done')
  const impl = c.rows[5]!
  if (impl.kind !== 'phase') throw new Error('not a phase row')
  expect(impl.dots).toEqual(['success', 'suggestion', 'error'])
  // The running run's glanceable line (BASE's run.start at T0, 60 s before NOW_C, is in the third-newest cell).
  expect(lines[6]!.trimEnd()).toBe(`    ${' '.repeat(7)}█   ↳ tool.end bash: npm test`)
  expect(lines[7]).toBe('  review  ●  glm-5.3 · 1/1 done')
  expect(lines.length).toBe(8)
})

test('an open card lists each run as its runDetail block under its phase row, one live line each', () => {
  const runs = [mk('a', { phase: 'implement', status: 'running', lastAt: NOW_C, lastSummary: 'step: x', title: 'S', where: 'wt' })]
  const open = texts(card('t', runs, NOW_C, 60, 'full'))
  expect(open[0]).toMatch(/^▾ t/)
  expect(open[5]).toMatch(/^ {2}implement/)
  const rest = open.slice(6).map(line => line.trimEnd())
  expect(rest).toEqual(runDetail(runs[0]!, NOW_C, 58).map(line => `  ${line.text}`.trimEnd()))
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
  expect(texts(header).map(t => t.trimEnd()))
    .toEqual([expect.stringMatching(/^▸ noisy +\d/), 'ocli · Running', '25 runs · ? tokens', '25 phases · pane too short to list them'])
  const agents: Card = { key: 'agents', rows: [], height: 3 }
  const fitted = fitCards([noisy, cardVariants('legit', legit, NOW_C, 46, []), [agents]], 23)
  expect(fitted.shown.map(c => c.key)).toEqual(['task:noisy', 'task:legit', 'agents'])
  expect(fitted.shown[0]).toBe(header)
  expect(fitted.shown[1]).toEqual(card('legit', legit, NOW_C, 46, false))
  expect(fitted.cut).toEqual([])
})

/** An independent count of terminal cells: emoji and Han characters take two. */
const cellsOf = (text: string) => [...text].reduce((n, ch) => n + (/\p{Extended_Pictographic}|\p{Script=Han}/u.test(ch) ? 2 : 1), 0)

test('wide glyphs count two cells: no card row is wider than its columns', () => {
  const runs = [
    mk('a', { task: '漢字'.repeat(40), phase: '\u{1F680}'.repeat(30), title: '漢'.repeat(80), status: 'running', lastAt: NOW_C, lastSummary: '\u{1F600}'.repeat(80) }),
    mk('b', { phase: '漢字のフェーズ'.repeat(6), model: 'm/' + '\u{1F916}'.repeat(40), status: 'completed', endedAt: T0 + 1000 }),
  ]
  for (const columns of [20, 46, 60]) {
    const c = card('漢字'.repeat(40), runs, NOW_C, columns, 'full')
    for (const line of texts(c)) expect(cellsOf(line)).toBeLessThanOrEqual(columns)
  }
})

test('a long phase name gives way to the dots and the LLM names; dropped dots are counted', () => {
  const long = 'implement the very long phase label'
  const of = (n: number) => {
    const runs = Array.from({ length: n }, (_, i) => mk(`l${i}`, { phase: long, model: 'openai/gpt', status: 'completed', endedAt: T0 + 1000 }))
    const row = card('t', runs, NOW_C, 46, false).rows.find(r => r.kind === 'phase')!
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
  expect(sixty.right).toBe('60/60 done')
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
  const c = card('t', [run as OcliRun], NOW_C, 40, 'full')
  expect(texts(c).some(line => line.startsWith('  implement'))).toBe(true)
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
  const c = card('t', runs, NOW_C, 60, false, false, ['implement', 'review', 'merge'])
  const lines = texts(c)
  expect(lines[2]!.trimEnd()).toBe('2 runs · ? tokens · 2/4 phases')
  const rows = c.rows.filter(r => r.kind === 'phase')
  expect(rows.map(r => r.kind === 'phase' && r.prefix.trim())).toEqual(['implement', 'review', 'merge', 'extra'])
  const review = rows[1]!
  if (review.kind !== 'phase') throw new Error('not a phase row')
  expect(review).toMatchObject({ dots: [], right: '0/0 done', isPending: true })
  expect(review.tail.trim()).toBe('declared ·')
  expect(rows[0]!.kind === 'phase' && rows[0]!.isPending).toBeFalsy()
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60)
  expect(lines.find(line => line.startsWith('  review'))).toBe('  review  declared · 0/0 done')
  // The header form counts the declared phases too.
  const header = texts(card('t', runs, NOW_C, 60, false, true, ['implement', 'review', 'merge']))
  expect(header[2]!.trimEnd()).toBe('2 runs · ? tokens · 2/4 phases')
  expect(header[3]!.trimEnd()).toBe('4 phases · pane too short to list them')
  // No plan: the count row is as before.
  expect(texts(card('t', runs, NOW_C, 60, false))[2]!.trimEnd()).toBe('2 runs · ? tokens')
})

test('done rule: a phase is done only with a run and none running or stale', () => {
  const done = (list: OcliRun[], now = NOW_C) => texts(card('t', list, now, 60, false, false, ['p', 'q']))[2]!.trimEnd()
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
  const count = (columns: number, isHeader = false) => texts(card('t', runs, NOW_C, columns, false, isHeader, ['implement', 'review', 'merge']))[2]!.trimEnd()
  expect(count(40)).toBe('2 runs · 2k tokens · 1/3 phases')
  expect(count(26)).toBe('1/3 phases · 2 runs · 2k …')
  expect(count(16)).toBe('1/3 phases · 2 …')
  expect(count(16, true)).toBe('1/3 phases · 2 …')
  // No plan: the row is cut as before.
  expect(texts(card('t', runs, NOW_C, 16, false))[2]!.trimEnd()).toBe('2 runs · 2k tok…')
})

test('the header form is the shortest form of every task card, HEADER_HEIGHT rows', () => {
  const runs = [mk('a', { phase: 'implement', status: 'completed', endedAt: T0 + 1000, title: 'why' }), mk('b', { phase: 'review', lastAt: NOW_C })]
  for (const [list, declared] of [[runs, []], [runs, ['x', 'y']], [[], ['only']], [runs.slice(0, 1), []]] as const) {
    const variants = cardVariants('t', list, NOW_C, 46, ['t'], declared)
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
  const c = card('t', [], NOW_C, 46, 'full', false, ['a', 'b', 'c'])
  const lines = texts(c).map(line => line.trimEnd())
  expect(c.color).toBeUndefined()
  expect(lines.slice(1, 3)).toEqual(['ocli · Declared', '0 runs · ? tokens · 0/3 phases'])
  expect(lines.slice(3)).toEqual(['Phases', '  a  declared · 0/0 done', '  b  declared · 0/0 done', '  c  declared · 0/0 done'])
  const variants = cardVariants('t', [], NOW_C, 46, ['t'], ['a', 'b', 'c'])
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
  const lines = runDetail(run, run.lastAt!, 80).map(line => line.text)
  // Just above the end line.
  expect(lines.at(-2)).toBe('  ⚠ unwitnessed: claimedTestsButNone, staleGreen')
  expect(runDetail(run, run.lastAt!, 20).at(-2)!.text).toMatch(/^ {2}⚠ unwitnessed: .*…$/)
  expect(runDetail(run, run.lastAt!, 80, true).some(line => line.text.includes('unwitnessed'))).toBe(true)
  for (const clean of [endWith({ findings: [] }), endWith(undefined)]) {
    expect(runDetail(clean, clean.lastAt!, 80).some(line => line.text.includes('unwitnessed'))).toBe(false)
  }
})

test('the card colours the unwitnessed line warning, not dim, and the phase row says ⚠N', () => {
  const flagged = (runId: string) => mk(runId, { phase: 'implement', status: 'completed', endedAt: T0 + 1000, witness: ['staleGreen'] })
  const runs = [flagged('a'), mk('b', { phase: 'implement', status: 'completed', endedAt: T0 + 2000, witness: [] }), flagged('c'), mk('d', { phase: 'review', status: 'completed', endedAt: T0 + 3000 })]
  const c = card('t', runs, NOW_C, 60, 'full')
  const warned = c.rows.filter(row => row.kind === 'text' && row.text.includes('⚠ unwitnessed'))
  expect(warned).toHaveLength(2)
  for (const row of warned) expect(row).toMatchObject({ color: 'warning', isDim: false, text: '    ⚠ unwitnessed: staleGreen' })
  const lines = texts(c)
  expect(lines.find(line => line.startsWith('  implement'))).toBe('  implement  ●●●  ⚠2 · ? · 3/3 done')
  expect(lines.find(line => line.startsWith('  review'))).not.toContain('⚠')
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

// --- heartbeat sparkline and loop detector ----------------------------------------------------
const NOW_H = T0 + 600_000

test('sparkline: ten 30 s cells, oldest left; an event on a bin edge belongs to the older cell', () => {
  expect(sparkline([NOW_H], NOW_H)).toBe(`${' '.repeat(9)}█`)
  expect(sparkline([NOW_H - 29_999], NOW_H)).toBe(`${' '.repeat(9)}█`)
  expect(sparkline([NOW_H - 30_000], NOW_H)).toBe(`${' '.repeat(8)}█ `)
  expect(sparkline([NOW_H - 270_000], NOW_H)).toBe(`█${' '.repeat(9)}`)
  expect(sparkline([NOW_H - 299_999], NOW_H)).toBe(`█${' '.repeat(9)}`)
  // Each cell relative to the busiest; a non-empty cell is at least ▁, an empty one a space.
  const beats = [...Array(8).fill(NOW_H), NOW_H - 30_000, ...Array(4).fill(NOW_H - 60_000)]
  expect(sparkline(beats, NOW_H)).toBe(`${' '.repeat(7)}▄▁█`)
  expect(sparkline([NOW_H - 1000], NOW_H, 3, 1000)).toBe(' █ ')
})

test('sparkline: events older than the window, or dated after now, are not counted; none is a flat line', () => {
  expect(sparkline([], NOW_H)).toBe('▁'.repeat(10))
  expect(sparkline([NOW_H - 300_000, NOW_H - 400_000, NOW_H + 1], NOW_H)).toBe('▁'.repeat(10))
  expect(sparkline([NOW_H - 300_000, NOW_H - 1], NOW_H)).toBe(`${' '.repeat(9)}█`)
  expect(sparkline([NOW_H, NOW_H + 1, NOW_H + 40_000], NOW_H)).toBe(`${' '.repeat(9)}█`)
})

const tstart = (seq: number, detail = 'npm test', tool = 'bash') => ev(seq, 'tool.start', { tool, detail })
const tend = (seq: number, ok: boolean | null, detail = 'npm test', tool = 'bash') => ev(seq, 'tool.end', { tool, detail, ok })
const EIGHT = [ev(0, 'run.start'), ...Array.from({ length: 8 }, (_, i) => tstart(i + 1))]

test('streak: an identical tool.start counts up, a different one starts over', () => {
  expect(fold(EIGHT.slice(0, 4))[0]!.streak).toEqual({ sig: 'bash: npm test', n: 3, okSince: false, open: true })
  expect(fold([...EIGHT.slice(0, 4), tstart(4, 'npm run build')])[0]!.streak).toEqual({ sig: 'bash: npm run build', n: 1, okSince: false, open: true })
  expect(fold([...EIGHT.slice(0, 4), tstart(4, 'npm test', 'shell')])[0]!.streak).toEqual({ sig: 'shell: npm test', n: 1, okSince: false, open: true })
  // Other events between the starts do not break it: a loop prints and fails in between.
  expect(fold([...EIGHT.slice(0, 3), tend(3, false), ev(4, 'message', { text: 'retrying' }), tstart(5)])[0]!.streak!.n).toBe(3)
  // The whole detail counts, not a prefix: agy's details are JSON under a deep worktree path, so three
  // different commands (a real trace, names scrubbed) share their first 80 code points.
  const root = '/home/user/workspaces/code/projects/myapp-obstruction-native-opencode'
  const agy = [`${root}/modules/myapp-obstruction`, `${root}/modules/myapp-obstruction/ios`, `${root}/scripts/models/fetch-face-parsing.sh`]
    .map((path, i) => tstart(i + 1, JSON.stringify({ CommandLine: `ls -la ${path}` }), 'run_command'))
  expect(fold([ev(0, 'run.start'), ...agy])[0]!.streak).toEqual({ sig: `run_command: {"CommandLine":"ls -la ${root}/scripts/models/fetch-face-parsing.sh"}`, n: 1, okSince: false, open: true })
  const long = 'x'.repeat(80)
  expect(fold([ev(0, 'run.start'), tstart(1, `${long}a`), tstart(2, `${long}b`)])[0]!.streak!.n).toBe(1)
})

test('isLooping: eight identical tool.starts with no ok end, not seven; an ok matching end clears it until a new streak', () => {
  expect(isLooping(fold(EIGHT)[0]!)).toBe(true)
  expect(isLooping(fold(EIGHT.slice(0, 8))[0]!)).toBe(false)
  // A failed end, an ok:null end and an ok end of another command do not clear it.
  expect(isLooping(fold([...EIGHT, tend(9, false)])[0]!)).toBe(true)
  expect(isLooping(fold([...EIGHT, tend(9, null)])[0]!)).toBe(true)
  expect(isLooping(fold([...EIGHT, tend(9, true, 'npm run x')])[0]!)).toBe(true)
  const ok = fold([...EIGHT, tend(9, true)])[0]!
  expect(ok.streak).toEqual({ sig: 'bash: npm test', n: 8, okSince: true, open: false })
  expect(isLooping(ok)).toBe(false)
  // After a success the same command starts a new streak: it can warn again only after eight more.
  const again = [...EIGHT, tend(9, true), ...Array.from({ length: 8 }, (_, i) => tstart(10 + i))]
  expect(fold(again.slice(0, 11))[0]!.streak).toEqual({ sig: 'bash: npm test', n: 1, okSince: false, open: true })
  expect(isLooping(fold(again.slice(0, 17))[0]!)).toBe(false)
  expect(isLooping(fold(again)[0]!)).toBe(true)
  expect(isLooping(mk('old'))).toBe(false)
})

test('beats: every timed event, newest last, at most 200; never mutating the runs passed in; dropped at run.end', () => {
  const lines = [ev(0, 'run.start'), ...Array.from({ length: 250 }, (_, i) => ev(i + 1, 'step', { label: 'x' }))]
  const run = fold(lines)[0]!
  expect(run.beats!.length).toBe(200)
  expect(run.beats![0]).toBe(Date.UTC(2026, 9, 10, 12, 0, 51))
  expect(run.beats!.at(-1)).toBe(Date.UTC(2026, 9, 10, 12, 0, 250))
  const untimed = JSON.stringify({ v: 1, runId: 'r1', seq: 1, at: 'never', task: 't', role: 'implement', cli: 'codex', kind: 'step', label: 'y' })
  expect(fold([ev(0, 'run.start'), untimed])[0]!.beats).toEqual([Date.UTC(2026, 9, 10, 12, 0, 0)])
  const before = fold(EIGHT.slice(0, 3))
  const kept = structuredClone(before)
  reduce(before, parseLines(file(EIGHT.slice(3))))
  expect(before).toEqual(kept)
  const ended = fold([...EIGHT, ev(9, 'run.end', { status: 'completed', exitCode: 0 })])[0]!
  expect(ended.beats).toBeUndefined()
  expect(ended.streak).toBeUndefined()
})

/** The live line of a run's block in the open card (closed cards draw none since 0.4). */
const liveRow = (run: OcliRun) => runDetail(run, NOW_H, 60).find(line => line.text.includes('↳'))
const looping = (n: number, okSince = false, over: Partial<OcliRun> = {}) =>
  mk('r', { phase: 'implement', status: 'running', lastAt: NOW_H - 1000, beats: [NOW_H - 1000], streak: { sig: 'bash: npm test', n, okSince }, lastSummary: 'tool.start bash: npm test', ...over })

test('the live row: sparkline, summary, ×n from three repeats, warning colour only while looping; ended runs draw no sparkline', () => {
  const at = liveRow
  const spark = `${' '.repeat(9)}█`
  expect(at(looping(2))).toEqual({ text: `  ${spark} ↳ tool.start bash: npm test`, isDim: false })
  expect(at(looping(3))).toEqual({ text: `  ${spark} ↳ tool.start bash: npm test ×3`, isDim: false })
  expect(at(looping(8))).toEqual({ text: `  ${spark} ↳ tool.start bash: npm test ×8`, isDim: false, color: 'warning' })
  expect(at(looping(8, true))!).not.toHaveProperty('color')
  // A long summary is cut, never the repeat count.
  const long = at(looping(12, false, { lastSummary: `tool.start bash: ${'y'.repeat(200)}`, streak: { sig: `bash: ${'y'.repeat(200)}`, n: 12, okSince: false } })) as { text: string }
  expect(cells(long.text)).toBe(60)
  expect(long.text.endsWith('… ×12')).toBe(true)
  // Expanded: the ↳ line carries the same, in warning colour; an ended run's carries no sparkline.
  const open = card('t', [looping(8, false, { title: 'S', where: 'wt' })], NOW_H, 60, 'full')
  const live = open.rows.find(row => row.kind === 'text' && row.text.includes('↳'))!
  expect(live).toMatchObject({ text: `    ${spark} ↳ tool.start bash: npm test ×8`, color: 'warning', isDim: false })
  const ended = runDetail(looping(8, false, { status: 'failed', endedAt: NOW_H, lastSummary: 'end failed exit 1' }), NOW_H, 60)
  expect(ended.some(line => line.text.includes('↳'))).toBe(false)
  expect(ended.at(-1)!.text).toBe('  end: failed · exit ? · score ?')
  expect(texts(open).every(line => cells(line) <= 60)).toBe(true)
})

test('a run kept in $.state by an older version (no beats, no streak) still draws, with a flat sparkline', () => {
  const old = { ...looping(0) } as Record<string, unknown>
  delete old.beats; delete old.streak
  expect(liveRow(old as OcliRun)).toEqual({ text: `  ${'▁'.repeat(10)} ↳ tool.start bash: npm test`, isDim: false })
})

test('streak on CLIs with no tool.start (opencode, muse): a tool.end no start opened counts as the call', () => {
  const ends = (oks: (boolean | null)[]) => [ev(0, 'run.start'), ...oks.map((ok, i) => tend(i + 1, ok))]
  expect(fold(ends(Array(7).fill(false)))[0]!.streak).toEqual({ sig: 'bash: npm test', n: 7, okSince: false, open: false })
  expect(isLooping(fold(ends(Array(7).fill(false)))[0]!)).toBe(false)
  expect(isLooping(fold(ends(Array(8).fill(false)))[0]!)).toBe(true)
  // An ok end is a success: not looping, and the next failure starts over.
  expect(isLooping(fold(ends([...Array(7).fill(false), true]))[0]!)).toBe(false)
  expect(fold(ends([...Array(8).fill(false), true, false]))[0]!.streak!.n).toBe(1)
  // A different command starts over.
  expect(fold([...ends(Array(5).fill(false)), tend(6, false, 'npm run build')])[0]!.streak!.n).toBe(1)
  // A start/end pair is one call, not two: codex, eight failing pairs.
  const pairs = [ev(0, 'run.start'), ...Array.from({ length: 8 }, (_, i) => [tstart(2 * i + 1), tend(2 * i + 2, false)]).flat()]
  expect(fold(pairs.slice(0, 9))[0]!.streak!.n).toBe(4)
  expect(isLooping(fold(pairs.slice(0, 15))[0]!)).toBe(false)
  expect(isLooping(fold(pairs)[0]!)).toBe(true)
  // A healthy run of the real fixtures, still running: no loop.
  for (const lines of [OPENCODE, MUSE]) expect(isLooping(fold(lines.filter(l => !l.includes('"run.end"')))[0]!)).toBe(false)
})

test('×n stands only on the repeated call itself, and not once it succeeded', () => {
  const live = (lines: string[]) => runDetail(fold(lines)[0]!, NOW_H, 120).map(l => l.text).find(l => l.includes('↳'))!
  const five = [ev(0, 'run.start'), ...Array.from({ length: 5 }, (_, i) => tstart(i + 1))]
  expect(live(five)).toMatch(/↳ tool\.start bash: npm test ×5$/)
  expect(live([...five, tend(6, false)])).toMatch(/↳ tool\.end bash: npm test \(failed\) ×5$/)
  expect(live([...five, ev(6, 'message', { text: 'thinking about something else' })])).toMatch(/↳ message: thinking about something else$/)
  expect(live([...five, tend(6, true)])).toMatch(/↳ tool\.end bash: npm test$/)
  // A different command whose detail starts with the repeated one's.
  expect(live([...five, tend(6, false, 'npm test --watch')])).not.toMatch(/×/)
})

// --- feature 7: prefix-hash (run.start.prefixSha) and per-phase cache ratio (usage.cached) ---------
const SHA_A = '0123456789ab'
const SHA_B = 'ba9876543210'

test('run.start prefixSha is kept only when it is exactly 12 lowercase hex characters', () => {
  const sha = (prefixSha: unknown) => fold([ev(0, 'run.start', { prefixSha })])[0]!.prefixSha
  expect(sha(SHA_A)).toBe(SHA_A)
  for (const bad of ['0123456789AB', `${SHA_A}c`, SHA_A.slice(1), ` ${SHA_A}`, '0123456789ag', 123456789012, null, undefined]) {
    expect(sha(bad)).toBeUndefined()
  }
})

test('usage cached is summed null-aware, and absent cached stays unknown', () => {
  const runs = fold([
    ev(0, 'run.start'),
    ev(1, 'usage', { input: 10, output: 1, cached: null }),
    ev(2, 'usage', { input: 10, output: 1, cached: 4 }),
    ev(3, 'usage', { input: 10, output: 1, cached: 3 }),
    ev(4, 'usage', { input: 10, output: 1 }),
  ])
  expect(runs[0]!.tokens).toEqual({ input: 40, output: 4, cached: 7 })
  expect(fold([ev(0, 'run.start'), ev(1, 'usage', { input: 5, output: 1 })])[0]!.tokens.cached ?? null).toBeNull()
})

const phaseText = (runs: OcliRun[], columns = 80) => card('t', runs, NOW_C, columns, false).rows.filter(row => row.kind === 'phase').map(rowText)
const tok = (input: number | null, cached: number | null | undefined) =>
  ({ input, output: 1, ...(cached === undefined ? {} : { cached }) }) as OcliRun['tokens']

test('a phase row shows cache N%: codex cached is part of input, opencode and agy cached is on top of it', () => {
  // codex: 600 of 1000 input tokens were cache reads.
  expect(phaseText([mk('a', { cli: 'codex', status: 'completed', tokens: tok(1000, 600) })])[0]).toMatch(/ cache 60% /)
  // opencode: 100 fresh input plus 300 cache reads -> 75% of the input it read.
  expect(phaseText([mk('a', { cli: 'opencode', status: 'completed', tokens: tok(100, 300) })])[0]).toMatch(/ cache 75% /)
  // Summed over the phase: (600 + 300) / (1000 + 400).
  expect(phaseText([
    mk('a', { cli: 'codex', status: 'completed', tokens: tok(1000, 600) }),
    mk('b', { cli: 'agy', status: 'completed', tokens: tok(100, 300) }),
  ])[0]).toMatch(/ cache 64% /)
  // A known zero is an observation, printed as such.
  expect(phaseText([mk('a', { cli: 'codex', status: 'completed', tokens: tok(1000, 0) })])[0]).toMatch(/ cache 0% /)
})

test('no cache counts, no cache text: never a 0% for unknown, and an old $.state run still draws', () => {
  for (const tokens of [tok(1000, null), tok(1000, undefined), tok(null, 50), tok(0, 0)]) {
    expect(phaseText([mk('a', { cli: 'codex', status: 'completed', tokens })])[0]).not.toMatch(/cache/)
  }
  // A run that reports cached counts next to one that does not: only the reporting run is the ratio.
  expect(phaseText([
    mk('a', { cli: 'codex', status: 'completed', tokens: tok(1000, 500) }),
    mk('b', { cli: 'muse', status: 'completed', tokens: tok(9000, null) }),
  ])[0]).toMatch(/ cache 50% /)
  // A run folded before this feature: no prefixSha, no tokens.cached.
  const old = { ...mk('o', { status: 'completed', tokens: { input: 10, output: 1 } }) } as Record<string, unknown>
  delete old.prefixSha
  const lines = phaseText([old as OcliRun])
  expect(lines).toHaveLength(1)
  expect(lines[0]).not.toMatch(/cache|prefix/)
})

test('⚠prefix×K: the phase runs on one cli carry K > 1 distinct prefixes; another cli or an unknown one is not a change', () => {
  const run = (id: string, cli: string, prefixSha?: string) => mk(id, { cli, status: 'completed', ...(prefixSha ? { prefixSha } : {}) })
  expect(phaseText([run('a', 'codex', SHA_A), run('b', 'codex', SHA_B)])[0]).toMatch(/ ⚠prefix×2/)
  expect(phaseText([run('a', 'codex', SHA_A), run('b', 'codex', SHA_B), run('c', 'codex', '0000000000ff')])[0]).toMatch(/ ⚠prefix×3/)
  expect(phaseText([run('a', 'codex', SHA_A), run('b', 'codex', SHA_A)])[0]).not.toMatch(/prefix/)
  expect(phaseText([run('a', 'codex', SHA_A), run('b', 'opencode', SHA_B)])[0]).not.toMatch(/prefix/)
  expect(phaseText([run('a', 'codex', SHA_A), run('b', 'codex')])[0]).not.toMatch(/prefix/)
})

test('a run folded before cached counts existed keeps cached unknown: a partial sum is never a ratio', () => {
  // Folded by the old mod: input summed, no tokens.cached key.
  const [old] = fold([ev(0, 'run.start'), ev(1, 'usage', { input: 1000, output: 1, cached: 900 })])
  delete (old!.tokens as Record<string, unknown>).cached
  // The new mod folds the rest: cached would cover one event while input covers both.
  const [run] = reduce([old!], parseLines(file([ev(2, 'usage', { input: 1000, output: 1, cached: 900 }), ev(3, 'run.end', { status: 'completed' })])))
  expect(run!.tokens.input).toBe(2000)
  expect(run!.tokens.cached ?? null).toBeNull()
  expect(phaseText([run!])[0]).not.toMatch(/cache/)
  // A run with no usage folded yet starts its cached sum with the new mod.
  const [fresh] = reduce(fold([ev(0, 'run.start')]), parseLines(file([ev(1, 'usage', { input: 1000, output: 1, cached: 900 })])))
  expect(fresh!.tokens.cached).toBe(900)
})

test('a cache ratio is drawn whole or not at all, at every width', () => {
  const runs = [mk('a', { cli: 'codex', status: 'completed', tokens: tok(1000, 600) })]
  for (let columns = 12; columns <= 80; columns++) {
    // The names after the ratio may be cut to `…`; the ratio itself never is (` cache 60…`).
    for (const line of phaseText(runs, columns)) if (/cach/.test(line)) expect(line).toMatch(/ cache \d+%[ …]/)
  }
})

test('cache and prefix text never widen a phase row past its columns', () => {
  const runs = [
    mk('a', { cli: 'codex', status: 'completed', prefixSha: SHA_A, tokens: tok(1000, 600) }),
    mk('b', { cli: 'codex', status: 'completed', prefixSha: SHA_B, tokens: tok(1000, 600) }),
  ]
  for (const columns of [20, 24, 28, 32, 36, 40, 46, 60]) {
    for (const line of texts(card('t', runs, NOW_C, columns, false))) expect(cellsOf(line)).toBeLessThanOrEqual(columns)
  }
})

// --- 0.4: the card is the toggle; its expanded form says what each run is doing; History ---------
const NOW_D = T0 + 90_000
test('ingest: brief, root and parentId from run.start; recent tool calls, last message, last warnings and the verify exit are kept, capped', () => {
  const run = fold([
    ev(0, 'run.start', { model: 'zai/glm-5.3', root: '/w/wt-rk1', parentId: 'node-7', title: 'RK1', brief: `slice RK1 \u001b[31m· write the\n adapter ${'b'.repeat(700)}` }),
    ...Array.from({ length: 7 }, (_, i) => ev(i + 1, 'tool.end', { tool: 'bash', detail: `cmd ${i}`, ok: i === 6 ? false : i === 5 ? null : true })),
    ev(8, 'message', { text: 'first' }),
    ev(9, 'message', { text: 'Now writing \u0007the adapter' }),
    ...['w1', 'w2', 'w3', 'w4'].map((text, i) => ev(10 + i, 'warn', { text })),
    ev(14, 'step', { label: 'verify.start' }),
    ev(15, 'step', { label: 'verify.end code=1' }),
  ])[0]!
  expect(run.brief!.startsWith('slice RK1 · write the adapter b')).toBe(true)
  expect([...run.brief!]).toHaveLength(600)
  expect(run).toMatchObject({ root: '/w/wt-rk1', where: 'wt-rk1', parentId: 'node-7', lastMessage: 'Now writing the adapter', warnings: ['w2', 'w3', 'w4'], verifyCode: 1, warnCount: 4 })
  expect(run.recent).toEqual([
    { text: 'bash: cmd 2', ok: true }, { text: 'bash: cmd 3', ok: true }, { text: 'bash: cmd 4', ok: true }, { text: 'bash: cmd 5', ok: null }, { text: 'bash: cmd 6', ok: false },
  ])
  // A run.start without the new fields leaves them absent; a parentId that is not a string is none.
  const bare = fold([ev(0, 'run.start', { parentId: null }), ev(1, 'step', { label: 'verify.end code=null' })])[0]!
  for (const key of ['brief', 'parentId', 'recent', 'lastMessage', 'warnings'] as const) expect(bare[key]).toBeUndefined()
  expect(bare.verifyCode).toBeNull()
})

test('wrap: whole words to the columns, at most N lines, a cut marked on the last', () => {
  expect(wrap('one two three four', 9, 3)).toEqual(['one two', 'three', 'four'])
  expect(wrap('one two three four', 9, 2)).toEqual(['one two', 'three fo…'])
  expect(wrap('x'.repeat(20) + ' y', 8, 3)).toEqual(['xxxxxxx…', 'y'])
  expect(wrap('', 10, 3)).toEqual([])
  for (const line of wrap('漢字 '.repeat(30), 7, 5)) expect(cells(line)).toBeLessThanOrEqual(7)
})

const RK1 = mk('rk1', {
  phase: 'build', cli: 'opencode', model: 'zai-coding-plan/glm-5.3', status: 'running', startedAt: T0, lastAt: NOW_D - 1000,
  beats: [NOW_D - 1000], title: 'RK1 catalogue adapter', where: 'wt-rk1', root: '/w/wt-rk1', parentId: 'node-7',
  brief: 'slice RK1 · worktree wt-rk1 · Catalogue adapter · Write the catalogue adapter for the GLM route and its tests.',
  toolCount: 3, warnCount: 1, tokens: { input: 12000, output: 800, cached: 9000 }, lastSummary: 'tool.start bash: npm test',
  recent: [{ text: 'read: src/catalogue.ts', ok: true }, { text: 'edit: src/adapter.ts', ok: false }], lastMessage: 'Writing the adapter now.', warnings: ['rate limit soon'],
})
const MUSE_DONE = mk('m1', { phase: 'build', cli: 'muse', model: 'muse-spark', status: 'completed', startedAt: T0, endedAt: T0 + 30_000, ms: 30_000, exitCode: 0, score: 1, verifyCode: 0, title: 'RK2', where: 'wt-rk2' })

test('collapsed card: the head is the ▸ toggle, one row per phase (parts joined with " · ", done counted), and a running run keeps its live line under it', () => {
  const c = card('t', [RK1, MUSE_DONE, mk('r', { phase: 'review', status: 'completed', endedAt: T0 + 5000 })], NOW_D, 60, false)
  const head = c.rows[0]!
  expect(head).toMatchObject({ kind: 'head', key: 'head:t', press: 'card:t', isOpen: false, label: '▸ t', right: '1m30s' })
  expect(head.kind === 'head' && head.dismiss).toBeFalsy()
  const lines = c.rows.map(rowText)
  expect(lines.map(line => line.trimEnd())).toEqual([
    expect.stringMatching(/^▸ t +1m30s$/), 'ocli · Running', '3 runs · 13k tokens', 'RK1 catalogue adapter', 'Phases',
    '  build  ●●  glm-5.3, muse-spark · cache 43% · 1/2 done',
    // The running run's one glanceable line, as in 0.3; the ended one has none.
    `    ${' '.repeat(9)}█ ↳ tool.start bash: npm test`,
    '  review  ●  ? · 1/1 done',
  ])
  expect(c.rows.find(r => r.key === 'live:t/rk1')).toMatchObject({ kind: 'text' })
  for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(60)
  // A looping run marks its phase row ⟳ and turns its live line warning.
  const loops = card('t', [{ ...RK1, streak: { sig: 'bash: npm test', n: 9, okSince: false } }], NOW_D, 60, false)
  const row = loops.rows.find(r => r.kind === 'phase')!
  expect(row).toMatchObject({ isWarn: true })
  expect(rowText(row)).toBe('  build  ●  ⟳1 · glm-5.3 · cache 43% · 0/1 done')
  expect(loops.rows.find(r => r.key === 'live:t/rk1')).toMatchObject({ color: 'warning' })
  // Open, the live line is in the run's block, not doubled under the phase row.
  expect(card('t', [RK1], NOW_D, 60, 'full').rows.some(r => r.key.startsWith('live:'))).toBe(false)
})

test('expanded card: grouped by phase, one block per run saying what it was asked, where, how far, and how it ended', () => {
  const c = card('t', [RK1, MUSE_DONE], NOW_D, 70, 'full')
  expect(c.rows[0]).toMatchObject({ kind: 'head', isOpen: true, label: '▾ t' })
  const rows = c.rows.filter(r => r.key.startsWith('run:t/rk1:'))
  const text = rows.map(rowText)
  expect(text).toEqual([
    '  ● running · glm-5.3 (opencode) · implement · 1m30s',
    '    slice RK1 · worktree wt-rk1 · Catalogue adapter · Write the',
    '    catalogue adapter for the GLM route and its tests.',
    '    in /w/wt-rk1 · parent node-7',
    '    3 tools · 1 warning · tokens in 12k · out 800 · cached 9k',
    `    ${' '.repeat(9)}█ ↳ tool.start bash: npm test`,
    '    ✓ read: src/catalogue.ts',
    '    ✗ edit: src/adapter.ts',
    '    says: Writing the adapter now.',
    '    ⚠ rate limit soon',
  ])
  expect(rows[0]).toMatchObject({ color: 'suggestion' })
  expect(rows[1]).not.toHaveProperty('isDim', true)
  expect(rows[7]).toMatchObject({ color: 'error', isDim: false })
  expect(rows[9]).toMatchObject({ color: 'warning', isDim: false })
  const done = c.rows.filter(r => r.key.startsWith('run:t/m1:')).map(rowText)
  expect(done[0]).toBe('  ✓ completed · muse-spark (muse) · implement · 30s')
  // No brief (an older dispatcher): the title stands in for it.
  expect(done[1]).toBe('    RK2')
  expect(done.at(-1)).toBe('    end: completed · exit 0 · score 1 · verify passed')
  // The phase row stays above its runs; every row fits.
  expect(c.rows.findIndex(r => r.kind === 'phase')).toBeLessThan(c.rows.findIndex(r => r.key.startsWith('run:')))
  for (const row of c.rows) expect(cells(rowText(row))).toBeLessThanOrEqual(70)
})

test('the end line names a failed verify and an unknown score; the compact form drops steps and warnings, keeps one brief line', () => {
  const failed = mk('f', { status: 'failed', endedAt: T0 + 1000, exitCode: 2, score: 0, verifyCode: 1, recent: [{ text: 'bash: x', ok: true }], warnings: ['w'], brief: 'a '.repeat(80) })
  const full = runDetail(failed, NOW_D, 60).map(l => l.text)
  expect(full.at(-1)).toBe('  end: failed · exit 2 · score 0 · verify failed (exit 1)')
  expect(full.filter(l => /^ {2}a a/.test(l))).toHaveLength(3)
  const compact = runDetail(failed, NOW_D, 60, true).map(l => l.text)
  expect(compact.filter(l => /^ {2}a a/.test(l))).toHaveLength(1)
  expect(compact.some(l => l.includes('bash: x') || l.includes('⚠ w'))).toBe(false)
  expect(runDetail(mk('n', { status: 'completed', endedAt: T0 + 1000 }), NOW_D, 60).at(-1)!.text).toBe('  end: completed · exit ? · score ?')
  // A run folded by 0.3 ($.state outlives a reload): no new fields, still a block.
  const old = { ...mk('o') } as Record<string, unknown>
  for (const key of ['brief', 'root', 'parentId', 'recent', 'lastMessage', 'warnings', 'verifyCode', 'title', 'where', 'phase', 'beats', 'streak']) delete old[key]
  expect(runDetail(old as OcliRun, NOW_D, 40).length).toBeGreaterThan(1)
})

test('the × sits on Completed, Failed and Blocked cards only: never Running, Stale, a mix with a running or stale run, or a plan-only card', () => {
  const dismissOf = (runs: OcliRun[], now = NOW_D, declared: string[] = []) => {
    const head = card('t', runs, now, 50, false, false, declared).rows[0]!
    return head.kind === 'head' ? head.dismiss : 'not a head'
  }
  expect(dismissOf([MUSE_DONE])).toBe('dismiss:t')
  expect(dismissOf([mk('f', { status: 'failed', endedAt: T0 })])).toBe('dismiss:t')
  expect(dismissOf([mk('b', { status: 'blocked', endedAt: T0 })])).toBe('dismiss:t')
  expect(dismissOf([RK1, MUSE_DONE])).toBeUndefined()
  const STALE = T0 + 11 * 60_000
  expect(dismissOf([mk('s', { status: 'running', lastAt: T0 })], STALE)).toBeUndefined()
  // Completed beside a stale run: the card reads Completed, yet a run may still be alive.
  const mixed = [{ ...MUSE_DONE, lastAt: STALE }, mk('s', { status: 'running', lastAt: T0 })]
  expect(taskStatus(mixed, STALE)).toBe('Completed')
  expect(dismissOf(mixed, STALE)).toBeUndefined()
  expect(isDismissible(mixed, STALE)).toBe(false)
  expect(dismissOf([], NOW_D, ['a'])).toBeUndefined()
  expect(isDismissible([MUSE_DONE], NOW_D)).toBe(true)
  expect(isDismissible([], NOW_D)).toBe(false)
  // The head never outgrows its columns, × included.
  const head = card('漢'.repeat(60), [MUSE_DONE], NOW_D, 30, false).rows[0]!
  expect(cells(rowText(head))).toBe(30)
})

test('cardVariants: an open card is drawn full, then compact, then closed, then as its header; a closed one closed, then header', () => {
  const open = cardVariants('t', [RK1, MUSE_DONE], NOW_D, 60, ['other', 't'])
  expect(open.map(c => c.rows[0]!.kind === 'head' && c.rows[0]!.isOpen)).toEqual([true, true, false, false])
  expect(open.map(c => c.height)).toEqual([...open.map(c => c.height)].sort((a, b) => b - a))
  expect(open[0]!.height).toBeGreaterThan(open[1]!.height)
  expect(cardVariants('t', [RK1], NOW_D, 60, ['other', 't/build'])).toHaveLength(2)
  expect(open.at(-1)!.height).toBe(HEADER_HEIGHT)
})

test('history: a snapshot per project and task; the card hides until a newer event; one entry per (scope, task), capped', () => {
  const entry = historyEntry('/live', 't', [MUSE_DONE], NOW_D)
  expect(entry).toEqual({ scope: '/live', task: 't', status: 'Completed', runs: 1, tokens: null, span: 30_000, lastAt: T0, dismissedAt: NOW_D })
  expect(isDismissed(entry, [MUSE_DONE])).toBe(true)
  expect(isDismissed(entry, [MUSE_DONE, mk('new', { lastAt: T0 + 1 })])).toBe(false)
  expect(isDismissed(undefined, [MUSE_DONE])).toBe(false)
  const later = { ...entry, dismissedAt: NOW_D + 1 }
  const elsewhere = { ...entry, scope: '/other' }
  expect(addHistory([entry, { ...entry, task: 'u' }, elsewhere], [later])).toEqual([{ ...entry, task: 'u' }, elsewhere, later])
  expect(addHistory([], Array.from({ length: 150 }, (_, i) => ({ ...entry, task: `t${i}` })))).toHaveLength(100)
})

test('foldHistory: checked, cleaned, legacy (no scope) dropped, times within Date range, runs a count, deduped by (scope, task) keeping the last, capped at 100', () => {
  const entry = historyEntry('/live', 't', [MUSE_DONE], NOW_D)
  const { scope: _, ...legacy } = entry
  expect(foldHistory([entry, { ...entry, task: '\u001b[2Jx\u0007' }, { ...entry, status: 'Running' }, { task: 'y' }, 'z', null, { ...entry, task: '' }, legacy, { ...entry, scope: '' }]))
    .toEqual([entry, { ...entry, task: 'x' }])
  for (const bad of [{ dismissedAt: 1e20 }, { lastAt: -8.64e15 - 1 }, { dismissedAt: Infinity }, { runs: 1.5 }, { runs: -1 }, { tokens: 'x' }, { span: undefined }]) {
    expect(foldHistory([{ ...entry, ...bad }]), JSON.stringify(bad)).toEqual([])
  }
  expect(foldHistory([{ ...entry, dismissedAt: 8.64e15, lastAt: -8.64e15 }])).toHaveLength(1)
  // A duplicate keeps the last; 101 distinct entries keep the newest 100.
  const many = [...Array.from({ length: 101 }, (_, i) => ({ ...entry, task: `t${i}` })), { ...entry, task: 't100', dismissedAt: NOW_D + 5 }]
  const folded = foldHistory(many)
  expect(folded).toHaveLength(100)
  expect(folded[0]!.task).toBe('t1')
  expect(folded.filter(e => e.task === 't100')).toEqual([{ ...entry, task: 't100', dismissedAt: NOW_D + 5 }])
  expect(foldHistory([entry, { ...entry, scope: '/other' }])).toHaveLength(2)
  expect(foldHistory({ not: 'a list' })).toEqual([])
  expect(foldHistory(undefined)).toEqual([])
})

test('the History card: closed is one ▸ row with the count; open lists newest first, a restore button on each, older ones counted', () => {
  const at = (task: string, dismissedAt: number, status: 'Completed' | 'Failed' | 'Blocked' = 'Completed') =>
    ({ scope: '/live', task, status, runs: 2, tokens: 3000, span: 65_000, lastAt: T0, dismissedAt })
  // Local time, as the person's clock reads it: computed here, so the test holds in every timezone.
  const hhmm = (ms: number) => [new Date(ms).getHours(), new Date(ms).getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
  const list = [at('a', T0), at('b', T0 + 60_000, 'Failed'), at('c', T0 + 120_000, 'Blocked')]
  const [closed] = historyVariants(list, false, 60)
  expect(historyVariants(list, false, 60)).toHaveLength(1)
  expect(closed!.rows.map(rowText)).toEqual([expect.stringMatching(/^▸ History +3$/)])
  expect(cells(rowText(closed!.rows[0]!))).toBe(60)
  expect(closed!.rows[0]).toMatchObject({ kind: 'head', press: 'history:toggle', isOpen: false })
  const [open, fallback] = historyVariants(list, true, 70)
  expect(fallback).toEqual(historyVariants(list, false, 70)[0])
  expect(open!.rows.slice(1)).toEqual([
    { kind: 'press', key: 'entry:c', press: 'restore:c', label: 'restore', text: ` c · Blocked · 2 runs · 3k tokens · 1m05s · dismissed ${hhmm(T0 + 120_000)}`, color: 'warning' },
    { kind: 'press', key: 'entry:b', press: 'restore:b', label: 'restore', text: ` b · Failed · 2 runs · 3k tokens · 1m05s · dismissed ${hhmm(T0 + 60_000)}`, color: 'error' },
    { kind: 'press', key: 'entry:a', press: 'restore:a', label: 'restore', text: ` a · Completed · 2 runs · 3k tokens · 1m05s · dismissed ${hhmm(T0)}`, color: 'success' },
  ])
  // Task names that look like the card's own rows never share a key with them.
  const keys = historyVariants([at('head', T0), at('more', T0 + 1), at('toggle', T0 + 2)], true, 70)[0]!.rows.flatMap(r => r.kind === 'head' || r.kind === 'press' ? [r.key, r.press] : [r.key])
  expect(new Set(keys).size).toBe(keys.length)
  const many = historyVariants(Array.from({ length: 25 }, (_, i) => at(`t${i}`, T0 + i)), true, 60)[0]!
  expect(many.rows.filter(r => r.kind === 'press')).toHaveLength(20)
  expect(rowText(many.rows.at(-1)!)).toBe('+5 older')
  expect(many.height).toBe(many.rows.length + 2)
  for (const row of many.rows) expect(cells(rowText(row))).toBeLessThanOrEqual(60)
})

describe('foldQuota: the usage snapshot, checked and cleaned', () => {
  test('known providers only, in the fixed order, every string cleaned, unknown fields never kept', () => {
    const hostile = structuredClone(SNAPSHOT) as Record<string, any>
    hostile.providers = {
      gemini: hostile.providers.gemini, codex: { ...hostile.providers.codex, email: 'someone@example.com', token: 'sk-SECRET', reason: '\u001b[31mred\u001b[0m‮' },
      unknownco: hostile.providers.codex, ['__proto__']: hostile.providers.codex, constructor: hostile.providers.codex,
    }
    const q = foldQuota(JSON.stringify(hostile))!
    expect(q.providers.map(p => p.name)).toEqual(['codex', 'gemini'])
    expect(q.providers[0]!.reason).toBe('red')
    expect(JSON.stringify(q)).not.toMatch(/example\.com|SECRET|unknownco/)
    expect(q.providers[1]!.routes.map(r => [r.model, r.gate])).toEqual([['gemini-4-argon-high', 'stop'], ['gemini-4-argon-medium', 'stop'], ['gemini-3.8-flash-high', 'ok']])
    expect(q.providers[0]!.windows[0]).toEqual({ limitId: 'primary', usedPercent: 42, mins: 300, resetsAt: Date.parse(SNAPSHOT.providers.codex.windows[0]!.resetsAt) })
  })

  test('anything that is not schema v1 with a providers object, or names no known provider, is null', () => {
    for (const text of ['', 'null', '[]', '{', '{"v":2,"providers":{"codex":{}}}', '{"v":1}', '{"v":1,"providers":[]}', '{"v":1,"providers":{"x":{}}}', '{"v":1,"providers":{"codex":7}}']) {
      expect(foldQuota(text), text).toBe(null)
    }
  })

  test('odd values fall back to unknown, never to ok', () => {
    const q = foldQuota(JSON.stringify({ v: 1, providers: { codex: { status: 'great', gate: { state: 'fine' }, windows: [{ usedPercent: 'x' }], routes: 'no', stop: 5 } } }))!
    expect(q.providers[0]).toMatchObject({ status: 'unknown', gate: 'unknown', routes: [], stop: null, windows: [{ usedPercent: null, mins: null, resetsAt: null }] })
  })

  test('quotaLine: no snapshot or no run, no line', () => {
    expect(quotaLine([], foldQuota(JSON.stringify(SNAPSHOT)), 0)).toBe(null)
  })
})

// Reviewer pins (u4 review): each kills one single-clause mutant the suite above let survive.
describe('quota card pins (u4 review)', () => {
  const T = Date.parse('2026-10-23T12:00:00Z')
  const at = (ms: number) => new Date(ms).toISOString()
  const one = (codex: Record<string, unknown>) => foldQuota(JSON.stringify({ v: 1, providers: { codex: {
    readAt: at(T), status: 'ok', gate: { state: 'ok' }, stop: null,
    windows: [{ limitId: 'codex', usedPercent: 50, windowDurationMins: 300, resetsAt: null }, { limitId: 'codex', usedPercent: 50, windowDurationMins: 10080, resetsAt: null }],
    ...codex,
  } } }))!
  const row = (q: OcliQuota, now = T) => quotaVariants(q, now, 100, true)[0]!.rows.slice(1)
  const segsOf = (r: Card['rows'][number]) => (r.kind === 'segs' ? r.segs : [])

  test('an active stop with no end is STOP (fail closed) and names no until', () => {
    const r = rowText(row(one({ stop: { until: null, reason: 'quota exhausted' } }))[0]!)
    expect(r).toMatch(/^codex  STOP /)
    expect(r).not.toContain('until')
  })

  test('a stop whose until has passed no longer counts: the gate decides, no until drawn', () => {
    const r = rowText(row(one({ stop: { until: at(T - 60_000), reason: 'old' } }))[0]!)
    expect(r).toMatch(/^codex  OK /)
    expect(r).not.toContain('until')
  })

  test('on a tie the shorter window binds (bold)', () => {
    expect(segsOf(row(one({}))[0]!).filter(s => s.isBold).map(s => s.text)).toEqual(['5h 50%'])
  })

  test('stale starts strictly after 30 minutes', () => {
    const exact = row(one({ readAt: at(T - 30 * 60_000) }))[0]!
    expect(rowText(exact)).not.toContain('stale')
    const past = row(one({ readAt: at(T - 30 * 60_000 - 1000) }))[0]!
    expect(rowText(past)).toContain('stale 30m')
  })

  test('the setup line is drawn under an unavailable provider only', () => {
    expect(row(one({ setup: 'usage.codex is not set' })).map(rowText).join('\n')).not.toContain('setup:')
    expect(row(one({ status: 'unavailable', setup: 'usage.codex is not set' })).map(rowText)).toContain('       setup: usage.codex is not set')
  })
})

// Fix round B (u4 review D1, D2, C1, V1): the pane draws the window the dispatcher's gate bound on.
describe('quota card: gate.window, the binding window (fix B)', () => {
  const T = Date.parse('2026-10-23T12:00:00Z')
  const H = 3_600_000
  const at = (ms: number) => new Date(ms).toISOString()
  const hm = (ms: number) => [new Date(ms).getHours(), new Date(ms).getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
  const runOf = (cli: string, model: string) => ({ runId: 'r', task: 't', role: 'x', cli, model, lastAt: T, startedAt: T } as unknown as OcliRun)
  const rowsOf = (q: OcliQuota) => quotaVariants(q, T, 100, true)[0]!.rows.slice(1)
  const segsOf = (r: Card['rows'][number]) => (r.kind === 'segs' ? r.segs : [])
  const boldOf = (r: Card['rows'][number]) => segsOf(r).filter(s => s.isBold).map(s => s.text)
  const w = (limitId: string, usedPercent: number, windowDurationMins: number, resetsAt: number | null = null) =>
    ({ limitId, usedPercent, windowDurationMins, resetsAt: resetsAt === null ? null : at(resetsAt) })
  const W5 = w('antigravity-quota-summary-gemini-5h', 10, 300, T + H)
  const WK = w('antigravity-quota-summary-gemini-weekly', 39, 10080, T + 48 * H)
  const ARGON = w('antigravity-quota-summary-gemini-argon-wtu-weekly', 90, 10080, T + 48 * H)
  const gemini = (extra: Record<string, unknown> = {}) => foldQuota(JSON.stringify({ v: 1, providers: { gemini: {
    readAt: at(T), status: 'ok', windows: [W5, WK, ARGON],
    gate: { state: 'stop', window: ARGON },
    routes: [
      { role: 'breadth', model: 'gemini-4-argon-high', gate: { state: 'stop', window: ARGON } },
      { role: 'breadth-flash', model: 'gemini-3.8-flash-high', gate: { state: 'ok', window: WK } },
    ],
    stop: null, ...extra,
  } } }))!

  test('P1 a flash run names the window its route gate bound (wk 39%), not the fullest (argon 90%)', () => {
    expect(quotaLine([runOf('agy', 'gemini-3.8-flash-high')], gemini(), T)?.text).toBe('quota: gemini flash OK · wk 39%')
  })

  test('C1 the provider row bolds the provider gate.window; each route group bolds its own', () => {
    const [row, sub] = rowsOf(gemini())
    expect(boldOf(row!)).toEqual(['wk 90%'])
    expect(boldOf(sub!)).toEqual(['wk 90%', 'wk 39%'])
  })

  test('P2 codex: a pool the gate does not bind is never the bold window or the line', () => {
    const q = foldQuota(JSON.stringify({ v: 1, providers: { codex: { readAt: at(T), status: 'ok', windows: [
      w('codex', 20, 300), w('codex', 30, 10080), w('codex_other', 95, 300),
    ], gate: { state: 'ok', headroomPercent: 70, window: w('codex', 30, 10080) }, stop: null } } }))!
    expect(quotaLine([runOf('codex', 'gpt-6.1-sol')], q, T)?.text).toBe('quota: codex OK · wk 30%')
    expect(boldOf(rowsOf(q)[0]!)).toEqual(['wk 30%'])
  })

  test('no gate.window: the old pick (fullest, shorter on a tie) still binds', () => {
    const q = foldQuota(JSON.stringify({ v: 1, providers: { codex: { readAt: at(T), status: 'ok', windows: [w('codex', 20, 300), w('codex', 30, 10080)], gate: { state: 'ok' }, stop: null } } }))!
    expect(quotaLine([runOf('codex', 'm')], q, T)?.text).toBe('quota: codex OK · wk 30%')
  })

  test('P3/D1 an active provider stop with no until overrides an ok route on the task line, as on the card', () => {
    const q = gemini({ gate: { state: 'ok', window: WK }, stop: { until: null, reason: 'quota exhausted' } })
    expect(rowText(rowsOf(q)[0]!)).toMatch(/^gemini STOP/)
    expect(quotaLine([runOf('agy', 'gemini-3.8-flash-high')], q, T)?.text).toMatch(/^quota: gemini flash STOP/)
    // A stop whose until has passed does not.
    const old = gemini({ gate: { state: 'ok', window: WK }, stop: { until: at(T - 60_000), reason: 'old' } })
    expect(quotaLine([runOf('agy', 'gemini-3.8-flash-high')], old, T)?.text).toBe('quota: gemini flash OK · wk 39%')
  })

  test('P4/V1 a gate STOP with no stop record shows until gate.window.resetsAt, relative and HH:MM', () => {
    expect(rowText(rowsOf(gemini())[0]!)).toContain(`STOP until ${hm(T + 48 * H)} (2d0h)`)
    expect(quotaLine([runOf('agy', 'gemini-4-argon-high')], gemini(), T)?.text).toBe(`quota: gemini argon STOP until ${hm(T + 48 * H)} (2d0h)`)
    const unknown = gemini({ gate: { state: 'stop', window: { ...ARGON, resetsAt: null } }, routes: [] })
    expect(rowText(rowsOf(unknown)[0]!)).toContain('STOP until reset unknown')
    expect(quotaLine([runOf('agy', 'gemini-4-argon-high')], unknown, T)?.text).toBe('quota: gemini STOP until reset unknown')
  })

  test('P6/D2 more windows than the row draws: the binding one is chosen first and always drawn', () => {
    const ws = [1, 2, 3, 4].map(i => w(`p${i}`, i, 300))
    ws.push(w('codex', 80, 10080))
    const pick = foldQuota(JSON.stringify({ v: 1, providers: { codex: { readAt: at(T), status: 'ok', windows: ws, gate: { state: 'ok' }, stop: null } } }))!
    expect(quotaLine([runOf('codex', 'm')], pick, T)?.text).toBe('quota: codex OK · wk 80%')
    expect(boldOf(rowsOf(pick)[0]!)).toEqual(['wk 80%'])
    expect(segsOf(rowsOf(pick)[0]!).filter(s => /^(\d+h|wk) \d+%$/.test(s.text))).toHaveLength(4)
    const gated = foldQuota(JSON.stringify({ v: 1, providers: { codex: { readAt: at(T), status: 'ok', windows: ws, gate: { state: 'ok', window: w('codex', 80, 10080) }, stop: null } } }))!
    expect(boldOf(rowsOf(gated)[0]!)).toEqual(['wk 80%'])
  })
})

// Reviewer pins (u5 review): each kills one single-clause mutant the suites above let survive.
describe('quota card pins (u5 review)', () => {
  const T = Date.parse('2026-10-23T12:00:00Z')
  const H = 3_600_000
  const at = (ms: number) => new Date(ms).toISOString()
  const hm = (ms: number) => [new Date(ms).getHours(), new Date(ms).getMinutes()].map(n => String(n).padStart(2, '0')).join(':')
  const w = (limitId: string, usedPercent: number, windowDurationMins: number, resetsAt: number | null = T + 48 * H) =>
    ({ limitId, usedPercent, windowDurationMins, resetsAt: resetsAt === null ? null : at(resetsAt) })
  const runOf = (cli: string, model: string) => ({ runId: 'r', task: 't', role: 'x', cli, model, lastAt: T, startedAt: T } as unknown as OcliRun)
  const snap = (providers: Record<string, unknown>) => foldQuota(JSON.stringify({ v: 1, providers }))!
  const rows = (q: OcliQuota, columns = 100) => quotaVariants(q, T, columns, true)[0]!.rows.slice(1)
  const boldOf = (r: Card['rows'][number]) => (r.kind === 'segs' ? r.segs.filter(s => s.isBold).map(s => s.text) : [])
  const ARGON = w('antigravity-quota-summary-gemini-argon-wtu-weekly', 100, 10080, T + 5 * H)
  const WK = w('antigravity-quota-summary-gemini-weekly', 39, 10080)
  const gemini = (extra: Record<string, unknown> = {}) => snap({ gemini: { readAt: at(T), status: 'ok', windows: [WK, ARGON],
    gate: { state: 'stop', window: ARGON }, stop: null,
    routes: [{ role: 'breadth', model: 'gemini-4-argon-high', gate: { state: 'stop', window: ARGON } }], ...extra } })

  test('an unavailable provider is ? even when its gate says ok (until-stop)', () => {
    const q = snap({ glm: { readAt: at(T), status: 'unavailable', windows: [], gate: { state: 'ok', window: null }, stop: null } })
    expect(rowText(rows(q)[0]!)).toMatch(/^glm {4}\? /)
  })

  test('a route with no model is dropped', () => {
    const q = gemini({ routes: [{ role: 'x', model: '', gate: { state: 'ok', window: WK } }] })
    expect(q.providers[0]!.routes).toEqual([])
  })

  test('a STOP route sub-row names when its bound window resets', () => {
    expect(rowText(rows(gemini())[1]!)).toContain(`argon STOP wk 100% until ${hm(T + 5 * H)} (5h00m)`)
  })

  test('a gate.window missing from the windows list is still the bold window and the task line', () => {
    const q = snap({ codex: { readAt: at(T), status: 'ok', windows: [w('codex', 20, 300)], gate: { state: 'ok', window: w('codex', 30, 10080) }, stop: null } })
    expect(boldOf(rows(q)[0]!)).toEqual(['wk 30%'])
    expect(quotaLine([runOf('codex', 'm')], q, T)?.text).toBe('quota: codex OK · wk 30%')
  })

  test('below 32 columns the open card drops the route sub-rows', () => {
    expect(rows(gemini(), 31).map(r => r.key)).toEqual(['quota:row:gemini'])
    expect(rows(gemini(), 32).map(r => r.key)).toEqual(['quota:row:gemini', 'quota:routes:gemini'])
  })

  test('a reset already past is not drawn as `resets`', () => {
    const q = snap({ codex: { readAt: at(T), status: 'ok', windows: [w('codex', 20, 300, T - H)], gate: { state: 'ok', window: w('codex', 20, 300, T - H) }, stop: null } })
    expect(rowText(rows(q)[0]!)).not.toContain('resets')
  })
})
