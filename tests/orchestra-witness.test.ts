import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain ESM tooling
import { normalize } from '../dispatcher/events.mjs';
// @ts-expect-error plain ESM tooling
import { claimsOf, witness } from '../dispatcher/witness.mjs';

type Ev = Record<string, unknown>;
const codes = (r: { findings: { code: string }[] }) => r.findings.map(f => f.code);
/** Normalized events as dispatch records them: each with the seq its emit gave it. */
const sequence = (lists: Ev[][]): Ev[] => lists.flat().map((e, seq) => ({ ...e, seq }));
const fixture = (cli: string): Ev[] => {
  const state = {};
  return sequence([readFileSync(new URL(`./fixtures/orchestra-events/${cli}.jsonl`, import.meta.url), 'utf8')
    .split('\n').filter(Boolean).flatMap(line => normalize(cli, line, state))]);
};
const line = (cli: string, raw: unknown): Ev[] => normalize(cli, JSON.stringify(raw), {});
// Real CLI shapes, through the real normalize: the tool names witness sees are the normalized ones.
const codexCmd = (command: string, exitCode: number) => line('codex', { type: 'item.completed', item: { type: 'command_execution', command, exit_code: exitCode, status: 'completed' } });
const codexEdit = (path = 'src/a.ts') => line('codex', { type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [{ kind: 'update', path }] } });
const agyTool = (name: string, parameters: unknown) => line('agy', { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: name, tool_info: { name, parameters } } });
const opencodeTool = (tool: string, input: unknown, status = 'completed') => line('opencode', { type: 'tool_use', part: { tool, state: { status, input } } });
const museBash = (command: string) => line('muse', { payload_type: 'tool.result', payload: { correlation_facts: { tool_name: 'bash', outcome: 'success' }, text: JSON.stringify({ command, exit_code: 0 }) } });

describe('the module', () => {
  it('is pure: no fs, no child_process, no import at all', () => {
    const source = readFileSync(new URL('../dispatcher/witness.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bimport\b|\brequire\(/);
  });
  it('no claims give no findings, whatever the trace', () => {
    const events = sequence([codexCmd('npm test', 0), codexEdit()]);
    expect(witness(events, 'I looked at the parser.', { changedFiles: 0, verify: { code: 1 }, commitExists: () => false }))
      .toEqual({ v: 1, claims: [], findings: [] });
    expect(witness(events, null)).toEqual({ v: 1, claims: [], findings: [] });
  });
  it('every finding text is at most 200 characters', () => {
    const r = witness(sequence([codexCmd('npm test', 0), codexEdit()]),
      `All tests pass. Red before green. Done. committed ${'a1'.repeat(20)}`, { changedFiles: 0, commitExists: () => false, verify: { code: 1 } });
    expect(r.findings.length).toBeGreaterThan(2);
    for (const f of r.findings) expect(f.text.length).toBeLessThanOrEqual(200);
  });
});

describe('claims', () => {
  it.each([
    ['All tests pass.', 'testsPass'], ['all 42 tests passed', 'testsPass'], ['The tests are green.', 'testsPass'],
    ['tests passing', 'testsPass'], ['12 tests passed', 'testsPass'], ['Result: 12 passed, 0 failed', 'testsPass'],
    ['typecheck is clean', 'typecheckClean'], ['tsc passes', 'typecheckClean'], ['no type errors', 'typecheckClean'],
    ['red before green', 'redBeforeGreen'], ['Red → green on the new test', 'redBeforeGreen'], ['red-then-green', 'redBeforeGreen'],
    ['Done and committed', 'done'], ['DONE', 'done'], ['Fixed.', 'done'], ['complete', 'done'], ['implemented the parser', 'done'],
    ['Committed 3f2a1bc.', 'committed'], ['commit `3f2a1bc9`', 'committed'], ['committed as 3F2A1BC', 'committed'],
  ])('%j claims %s', (text, claim) => {
    expect(claimsOf(text)[claim]).toBeTruthy();
  });
  it.each([
    ['I will run the tests next', 'testsPass'], ['the tests failed', 'testsPass'],
    ['red', 'redBeforeGreen'], ['the greenhouse is red', 'redBeforeGreen'],
    ['completed the review', 'done'], ['undone', 'done'], ['abandoned', 'done'],
    ['committed nothing', 'committed'], ['commit the facade', 'committed'], ['commit defaced', 'committed'], ['commits 3f2a1bc', 'committed'],
  ])('%j does not claim %s', (text, claim) => {
    expect(claimsOf(text)[claim]).toBeFalsy();
  });
  it('captures every committed sha, lowercased, once each', () => {
    expect(claimsOf('Committed 3F2A1BC; then commit deadbee1 and committed 3f2a1bc').commits).toEqual(['3f2a1bc', 'deadbee1']);
  });
  it('lists the claims it found in the result', () => {
    expect(witness([], 'All tests pass, typecheck clean, red before green. Done: committed 3f2a1bc').claims)
      .toEqual(['testsPass', 'typecheckClean', 'redBeforeGreen', 'committed', 'done']);
  });
});

describe('claimedTestsButNone', () => {
  it('raised on a fixture run that claims tests pass and ran no test (each CLI)', () => {
    for (const cli of ['codex', 'opencode', 'agy', 'muse']) {
      expect(codes(witness(fixture(cli), 'All tests pass.')), cli).toEqual(['claimedTestsButNone']);
    }
  });
  it('not raised once any shell tool ran a test command, whatever its verdict', () => {
    for (const run of [codexCmd("/bin/zsh -lc 'npx vitest run tests/a.test.ts'", 1), agyTool('run_command', { CommandLine: 'npm run test' }),
      opencodeTool('bash', { command: 'pnpm test' }), museBash('cargo test -q'), codexCmd('go test ./...', 0), codexCmd('python -m pytest', 0),
      codexCmd('node --test x.mjs', 0), codexCmd('npx tsc --noEmit', 0), codexCmd('claude plugin test mod', 0), codexCmd('yarn test', 0), codexCmd('npx jest', 0)]) {
      expect(codes(witness(sequence([run]), 'All tests pass.')), JSON.stringify(run)).not.toContain('claimedTestsButNone');
    }
  });
  it('a test command in a non-shell tool (a file edit naming it) is not a test run', () => {
    expect(codes(witness(sequence([opencodeTool('edit', { filePath: 'notes.md', newString: 'run npm test' })]), 'All tests pass.')))
      .toContain('claimedTestsButNone');
  });
  it('not raised when the dispatcher ran a verifier', () => {
    expect(codes(witness(fixture('codex'), 'All tests pass.', { verify: { command: 'npm test', code: 0, ms: 1 } }))).toEqual([]);
  });
  it('a custom testCommandPattern from policy decides what a test run is (case-insensitive)', () => {
    const events = sequence([codexCmd('make check', 0)]);
    expect(codes(witness(events, 'All tests pass.'))).toEqual(['claimedTestsButNone']);
    expect(codes(witness(events, 'All tests pass.', { testCommandPattern: '\\bMAKE CHECK\\b' }))).toEqual([]);
    expect(codes(witness(sequence([codexCmd('npm test', 0)]), 'All tests pass.', { testCommandPattern: 'make check' }))).toEqual(['claimedTestsButNone']);
  });
});

describe('staleGreen', () => {
  it('raised when the last green test ran before the last edit (codex file_change)', () => {
    const r = witness(sequence([codexCmd('npm test', 0), codexEdit()]), 'All tests pass.');
    expect(codes(r)).toEqual(['staleGreen']);
  });
  it('raised for each CLI\'s edit tool: agy write_to_file, muse write_file, opencode edit and write', () => {
    const green = codexCmd('npm test', 0);
    const edits = [agyTool('write_to_file', { TargetFile: 'a' }), line('muse', { payload_type: 'tool.result', payload: { edit_facts: { tool_name: 'write_file', path: 'a' }, correlation_facts: { outcome: 'success' } } }),
      opencodeTool('edit', { filePath: 'a' }), opencodeTool('write', { filePath: 'a' })];
    for (const edit of edits) expect(codes(witness(sequence([green, edit]), 'All tests pass.')), JSON.stringify(edit)).toEqual(['staleGreen']);
  });
  it('not raised when the last green test ran after the last edit', () => {
    expect(codes(witness(sequence([codexEdit(), codexCmd('npm test', 0)]), 'All tests pass.'))).toEqual([]);
    expect(codes(witness(sequence([codexCmd('npm test', 0), codexEdit(), codexCmd('npm test', 0)]), 'All tests pass.'))).toEqual([]);
  });
  it('agy\'s null ok is unknown: a test then an edit raises no staleGreen', () => {
    const events = sequence([agyTool('run_command', { CommandLine: 'npm test' }), agyTool('write_to_file', { TargetFile: 'a' })]);
    expect(codes(witness(events, 'All tests pass. Red before green.'))).toEqual([]);
  });
  it('an unknown test run after the edit leaves a stale green unproven', () => {
    const events = sequence([codexCmd('npm test', 0), codexEdit(), agyTool('run_command', { CommandLine: 'npm test' })]);
    expect(codes(witness(events, 'All tests pass.'))).toEqual([]);
  });
  it('a failed edit (ok false) is not an edit', () => {
    const failed = opencodeTool('edit', { filePath: 'a' }, 'error');
    expect(codes(witness(sequence([codexCmd('npm test', 0), failed]), 'All tests pass.'))).toEqual([]);
  });
  it('not raised without a pass claim', () => {
    expect(codes(witness(sequence([codexCmd('npm test', 0), codexEdit()]), 'I changed a.ts.'))).toEqual([]);
  });
  it('real fixtures with no test run raise no staleGreen', () => {
    for (const cli of ['codex', 'opencode', 'agy', 'muse']) expect(codes(witness(fixture(cli), 'tsc passes')), cli).toEqual([]);
  });
});

describe('claimedRedNoFailingRun', () => {
  it('raised when red-before-green is claimed and no test failed before the first edit', () => {
    expect(codes(witness(sequence([codexEdit(), codexCmd('npm test', 1), codexCmd('npm test', 0)]), 'Red before green.'))).toEqual(['claimedRedNoFailingRun']);
    expect(codes(witness(sequence([codexCmd('npm test', 0), codexEdit(), codexCmd('npm test', 0)]), 'red before green'))).toEqual(['claimedRedNoFailingRun']);
    expect(codes(witness([], 'red before green'))).toEqual(['claimedRedNoFailingRun']);
  });
  it('not raised when a test failed before the first edit', () => {
    expect(codes(witness(sequence([codexCmd('npm test', 1), codexEdit(), codexCmd('npm test', 0)]), 'Red before green.'))).toEqual([]);
  });
  it('a failing non-test command before the edit is not a red run', () => {
    expect(codes(witness(sequence([codexCmd('ls missing', 2), codexEdit()]), 'Red before green.'))).toEqual(['claimedRedNoFailingRun']);
  });
});

describe('commitNotFound', () => {
  it('raised when commitExists says a claimed sha is not a commit', () => {
    const r = witness([], 'Done and committed 3f2a1bc.', { commitExists: () => false, changedFiles: 2 });
    expect(codes(r)).toEqual(['commitNotFound']);
    expect(r.findings[0].text).toContain('3f2a1bc');
  });
  it('not raised when it exists, or when the lookup is unknown or absent', () => {
    for (const commitExists of [() => true, () => undefined, undefined]) {
      expect(codes(witness([], 'committed 3f2a1bc', { commitExists }))).toEqual([]);
    }
  });
});

describe('doneNoChange', () => {
  it('raised when work is claimed done and nothing changed', () => {
    expect(codes(witness(fixture('codex'), 'Implemented. DONE', { changedFiles: 0 }))).toEqual(['doneNoChange']);
  });
  it('not raised on a change or an unknown tree', () => {
    expect(codes(witness([], 'Fixed.', { changedFiles: 1 }))).toEqual([]);
    expect(codes(witness([], 'Fixed.', { changedFiles: null }))).toEqual([]);
    expect(codes(witness([], 'Fixed.'))).toEqual([]);
  });
});

describe('verifyContradicts', () => {
  it('raised when tests are claimed to pass and the verifier exited non-zero', () => {
    expect(codes(witness(sequence([codexCmd('npm test', 0)]), 'All tests pass.', { verify: { command: 'npm test', code: 1, ms: 1 } }))).toEqual(['verifyContradicts']);
  });
  it('not raised on a passing verifier, a verifier killed without a code (no verdict), or no pass claim', () => {
    expect(codes(witness([], 'All tests pass.', { verify: { code: 0 } }))).toEqual([]);
    expect(codes(witness([], 'All tests pass.', { verify: { code: null } }))).not.toContain('verifyContradicts');
    expect(codes(witness([], 'I tried.', { verify: { code: 1 } }))).toEqual([]);
  });
});

// --- review round: the reviewers' reproductions, each red before its fix ------------------------
const museBashOut = (command: string, output: string) => line('muse', { payload_type: 'tool.result', payload: { correlation_facts: { tool_name: 'bash', outcome: 'success' }, text: JSON.stringify({ command, exit_code: 0, output }) } });
const webSearch = (query: string) => line('codex', { type: 'item.completed', item: { type: 'web_search', query, status: 'completed' } });

describe('a test run is a command that runs a test, not a detail that mentions one', () => {
  it('muse output, opencode description and codex commands that only name a test tool are not test runs', () => {
    for (const run of [museBashOut('cat package.json', '{"scripts":{"test":"vitest run"}}'), museBashOut('git diff', "import { it } from 'vitest'"),
      opencodeTool('bash', { command: 'ls', description: 'list files before running vitest' }),
      codexCmd('rg -n vitest package.json', 0), codexCmd('npx tsc --version', 0), codexCmd('cat jest.config.js', 0),
      codexCmd('grep -r vitest .', 0), codexCmd('ls node_modules/.bin/vitest', 0), codexCmd('echo vitest ok', 0),
      agyTool('run_command', { CommandLine: 'cat vitest.config.ts' })]) {
      expect(codes(witness(sequence([run]), 'All tests pass.')), JSON.stringify(run)).toEqual(['claimedTestsButNone']);
    }
  });
  it('an echo of a test tool after the last edit does not hide a stale green', () => {
    expect(codes(witness(sequence([codexCmd('npx vitest run', 0), codexEdit(), codexCmd('echo vitest ok', 0)]), 'All tests pass.'))).toEqual(['staleGreen']);
  });
  it('real test commands behind launchers, wrappers and separators still count', () => {
    for (const run of [codexCmd("/bin/zsh -lc 'cd /w && npx vitest run tests/a.test.ts'", 0), codexCmd('CI=1 npm test', 0),
      codexCmd('timeout 600 npm run test 2>&1 | tail -5', 0), codexCmd('./node_modules/.bin/vitest run', 0),
      codexCmd('/opt/x/.npm-global/bin/claude plugin test mod', 0), codexCmd('uv run pytest -q', 0), codexCmd('npm exec -- jest', 0),
      museBashOut('npm test', 'x'.repeat(2000)), opencodeTool('bash', { command: 'pnpm test', description: 'run the suite' })]) {
      expect(codes(witness(sequence([run]), 'All tests pass.')), JSON.stringify(run)).toEqual([]);
    }
  });
  it('a test command in a non-shell, non-edit tool is not a test run (M9: the shell-tool restriction)', () => {
    expect(codes(witness(sequence([webSearch('vitest run')]), 'All tests pass.'))).toEqual(['claimedTestsButNone']);
  });
});

describe('an honest failure report is not a claim', () => {
  it.each([
    ['Tests: 3 failed | 12 passed', 'testsPass'], ['Tests: 3 failed, 12 passed, 15 total', 'testsPass'],
    ['Not all tests pass yet: 2 failures remain.', 'testsPass'], ['Typecheck is not clean: tsc reported 4 errors', 'typecheckClean'],
    ['I could not complete the task; nothing was implemented.', 'done'], ['Blocked: this is not done.', 'done'],
    ["I didn't commit 3f2a1bc.", 'committed'],
  ])('%j does not claim %s', (text, claim) => {
    expect(claimsOf(text)[claim]).toBeFalsy();
  });
  it('the reviewers\' strings raise nothing against a failing verifier and an unchanged tree', () => {
    for (const text of ['Tests: 3 failed | 12 passed', 'Not all tests pass yet: 2 failures remain.',
      'I could not complete the task; nothing was implemented.', 'Blocked: this is not done.', 'Typecheck is not clean: tsc reported 4 errors']) {
      expect(witness([], text, { changedFiles: 0, verify: { code: 1 } }).findings, text).toEqual([]);
    }
  });
  it('a claim in its own clause still counts next to a negated one', () => {
    expect(claimsOf('Result: 12 passed, 0 failed').testsPass).toBe(true);
    expect(claimsOf('The old test did not compile. Now all tests pass.').testsPass).toBe(true);
    expect(claimsOf('Fixed the parser, but the docs are not updated.').done).toBe(true);
  });
});

describe('doneNoChange needs a claim of work', () => {
  it('a bare DONE from a run that edited nothing (a review) is no finding', () => {
    expect(codes(witness(fixture('codex'), 'DONE', { changedFiles: 0 }))).toEqual([]);
    expect(codes(witness([], 'Review complete. Done.', { changedFiles: 0 }))).toEqual([]);
  });
  it('fixed, implemented or committed with no change is; so is done after an edit tool ran', () => {
    for (const text of ['Fixed.', 'Implemented the parser.', 'Done and committed.']) {
      expect(codes(witness([], text, { changedFiles: 0 })), text).toEqual(['doneNoChange']);
    }
    expect(codes(witness(sequence([codexEdit()]), 'DONE', { changedFiles: 0 }))).toEqual(['doneNoChange']);
  });
  it('a claimed sha that exists does not switch the finding off', () => {
    expect(codes(witness([], 'Done. Committed as 1a2b3c4 earlier.', { changedFiles: 0, commitExists: () => true }))).toEqual(['doneNoChange']);
  });
});

describe('red before the FIRST edit (M12)', () => {
  it('a failing run between two edits is not red before green', () => {
    expect(codes(witness(sequence([codexEdit(), codexCmd('npm test', 1), codexEdit(), codexCmd('npm test', 0)]), 'Red before green.')))
      .toEqual(['claimedRedNoFailingRun']);
  });
});

describe('a verifier killed without a code is no verdict', () => {
  it('claimedTestsButNone still applies', () => {
    expect(codes(witness(sequence([codexEdit()]), 'All tests pass.', { verify: { code: null } }))).toEqual(['claimedTestsButNone']);
  });
});

describe('recorded shapes and package-manager runners', () => {
  // The recorded muse bash result: payload.text is pretty-printed JSON (`{\n  "chunk_id": …`), with
  // the command's output and a description next to the command.
  const recordedMuse = (command: string, output: string) => {
    const raw = readFileSync(new URL('./fixtures/orchestra-events/muse.jsonl', import.meta.url), 'utf8')
      .split('\n').find(l => l.includes('"tool_name":"bash"'))!;
    const parsed = JSON.parse(raw);
    const text = JSON.parse(parsed.payload.text);
    parsed.payload.text = JSON.stringify({ ...text, command, output }, null, 2);
    return normalize('muse', JSON.stringify(parsed), {});
  };
  it('a recorded muse bash result is read by its command, not its output', () => {
    expect(codes(witness(sequence([recordedMuse('cat package.json', '"test": "vitest run"')]), 'All tests pass.'))).toEqual(['claimedTestsButNone']);
    expect(codes(witness(sequence([recordedMuse('npx vitest run', 'ok')]), 'All tests pass.'))).toEqual([]);
  });
  it('a test tool run through pnpm, yarn or bun counts', () => {
    for (const command of ['pnpm vitest run', 'yarn jest', 'pnpm tsc --noEmit', 'yarn vitest', 'bun test']) {
      expect(codes(witness(sequence([codexCmd(command, 0)]), 'All tests pass.')), command).toEqual([]);
    }
  });
});
