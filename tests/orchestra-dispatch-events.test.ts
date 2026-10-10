import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), append: vi.fn(), live: vi.fn(), mkdir: vi.fn(), policy: vi.fn(), delta: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async original => ({ ...await original<Record<string, unknown>>(), appendFileSync: mocks.live, mkdirSync: mocks.mkdir }));
vi.mock('node:fs/promises', async original => ({ ...await original<Record<string, unknown>>(), readFile: mocks.policy, appendFile: mocks.append, mkdir: vi.fn() }));
vi.mock('../dispatcher/usage.mjs', () => ({ readCodexUsage: vi.fn(async () => ({status:'unknown'})), readGlmUsage: vi.fn(async () => ({status:'unknown'})), claudeUsageFromLead: vi.fn(), usageDelta: mocks.delta, gateFor: vi.fn() }));
// @ts-expect-error plain ESM tooling
import { main, runPhase, runTitle } from '../dispatcher/dispatch.mjs';
const originalPolicy = JSON.parse(readFileSync(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8'));
let policy: typeof originalPolicy;
let child: EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; pid: number};
const fixture = readFileSync(new URL('./fixtures/orchestra-events/codex.jsonl', import.meta.url), 'utf8');
const dispatch = (...extra: string[]) => main(['--role', 'reason', '--task', 'mock-live', '--prompt', 'literal {unknown} {variant}', ...extra]);
const events = () => mocks.live.mock.calls.filter(([file, body]) => body && !String(file).endsWith('.raw.jsonl')).map(([, body]) => JSON.parse(body));
const raw = () => mocks.live.mock.calls.filter(([file, body]) => body && String(file).endsWith('.raw.jsonl')).map(([, body]) => JSON.parse(body));
beforeEach(() => {
  vi.resetAllMocks();
  policy = structuredClone(originalPolicy);
  mocks.policy.mockImplementation(async () => JSON.stringify(policy));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 123 });
    queueMicrotask(() => { child.stdout.emit('data', fixture.slice(0, 43)); child.stdout.emit('data', fixture.slice(43)); child.stderr.emit('data', 'err\r\ntail'); child.emit('close', 0, null); });
    return child;
  });
});
afterEach(() => { vi.restoreAllMocks(); });
it('writes contiguous events with dispatcher receipt time, raw lines and tree linkage', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-02T03:04:05.000Z'));
  try {
    await dispatch();
    const all = events();
    expect(all[0]).toMatchObject({kind:'run.start', seq:0, pid:123, parentId:null});
    expect(all.at(-1)).toMatchObject({kind:'run.end',status:'completed',exitCode:0,score:null});
    expect(all.map(e => e.seq)).toEqual(all.map((_, i) => i));
    expect(all.every(e => e.at === '2030-01-02T03:04:05.000Z')).toBe(true);
    const node = JSON.parse(mocks.append.mock.calls[0][1]);
    expect(node).toMatchObject({runId:all[0].runId, finalText:'DONE', stdoutTail:fixture.slice(-4000)});
    expect(node.liveFile).toBe(`orchestra/live/mock-live/${node.runId}.jsonl`);
    expect(all.at(-1).nodeId).toBe(node.nodeId);
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(mocks.live.mock.invocationCallOrder.at(-1)!);
    expect(raw().filter(e => e.stream === 'stdout').map(e => e.line)).toEqual(fixture.trimEnd().split('\n'));
    expect(raw().filter(e => e.stream === 'stderr').map(e => e.line)).toEqual(['err\r', 'tail']);
    expect(all.filter(e => e.kind === 'warn')).toHaveLength(3);
    expect(process.stdout.write).toHaveBeenCalledWith('DONE\n');
    expect(process.stderr.write).toHaveBeenCalledWith(`[dispatch] live: ${node.liveFile}\n`);
    expect(all.filter(e => e.kind === 'step').map(e => e.label)).toEqual(['thread.started', 'turn.started', 'cli.exit code=0 signal=null']);
  } finally { vi.useRealTimers(); }
});
it('writes events before child exit and does not share filenames across runs', async () => {
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    return child;
  });
  const pending = dispatch();
  await vi.waitFor(() => expect(events()[0]?.kind).toBe('run.start'));
  child.stdout.emit('data', 'plain\n');
  expect(events().at(-1).kind).toBe('unparsed');
  child.emit('close', 0, null); await pending;
  const first = events()[0].runId;
  const second = dispatch();
  await vi.waitFor(() => expect(events().filter(e => e.kind === 'run.start')).toHaveLength(2));
  expect(events().at(-1).runId).not.toBe(first);
  child.emit('close',0,null); await second;
});
it('finally writes spawn-error even on error followed by close', async () => {
  mocks.spawn.mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter()});
    queueMicrotask(() => {proc.emit('error', new Error('ENOENT')); proc.emit('close', -2, null);});
    return proc;
  });
  await dispatch();
  expect(events()[0]).toMatchObject({kind:'run.start',pid:null});
  expect(events().filter(e => e.kind === 'run.end')).toEqual([expect.objectContaining({status:'spawn-error'})]);
});
it('finally terminates on a post-exit usage calculation throw', async () => {
  mocks.delta.mockImplementation(() => { throw new Error('usage exploded'); });
  await expect(dispatch()).rejects.toThrow('usage exploded');
  expect(events().at(-1)).toMatchObject({kind:'run.end',exitCode:0,status:'dispatch-error',nodeId:null});
});
it('event write errors are counted and do not alter the outcome', async () => {
  mocks.live.mockImplementation(() => {throw new Error('disk full');});
  await expect(dispatch()).resolves.toBeUndefined();
  expect(JSON.parse(mocks.append.mock.calls[0][1])).toMatchObject({exitCode:0,finalText:'DONE'});
  expect(process.stderr.write).toHaveBeenLastCalledWith(expect.stringMatching(/eventWriteErrors=[1-9]\d*/));
});
it('resolves variant and leaves prompt braces intact', async () => {
  await dispatch('--role','implement');
  const argv = mocks.spawn.mock.calls[0][1];
  expect(argv[argv.indexOf('--variant') + 1]).toBe('high');
  // Measured 2026-10-11: without --dir opencode wrote a relative file into $HOME, not the
  // process cwd the dispatcher spawns it in. --dir {root} pins it to the worktree.
  expect(argv[argv.indexOf('--dir') + 1]).toBe(mocks.spawn.mock.calls[0][2].cwd);
  expect(argv.at(-1)).toBe('literal {unknown} {variant}');
});
it('rejects an unknown placeholder before spawn', async () => {
  policy.routes.reason.argv.push('{unknown}');
  await expect(dispatch()).rejects.toThrow(/unknown.*placeholder|placeholder.*unknown/i);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('rejects missing variant before spawn', async () => {
  delete policy.routes.implement.variant;
  await expect(dispatch('--role','implement')).rejects.toThrow(/variant/);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('uses its receipt clock instead of opencode and muse timestamps', async () => {
  for (const [cli, role] of [['opencode','implement'], ['muse','muse']]) {
    mocks.live.mockClear();
    const captured = readFileSync(new URL(`./fixtures/orchestra-events/${cli}.jsonl`, import.meta.url), 'utf8');
    mocks.spawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
      queueMicrotask(() => {proc.stdout.emit('data', captured); proc.emit('close',0,null);});
      return proc;
    });
    const before = Date.now(); await dispatch('--role',role); const after = Date.now();
    expect(events().every(e => Date.parse(e.at) >= before && Date.parse(e.at) <= after)).toBe(true);
  }
});
it('marks cli exit and verify boundaries in the live stream', async () => {
  let call = 0;
  mocks.spawn.mockImplementation((command: string) => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    // With --verify the tree is read (git) before the CLI: that spawn is not counted here.
    const code = command === 'git' ? 0 : call++ === 0 ? 0 : 3;
    queueMicrotask(() => {proc.emit('close', code, null);});
    return proc;
  });
  await dispatch('--verify','false-verifier');
  const all = events();
  const labels = all.filter(e => e.kind === 'step').map(e => e.label);
  expect(labels).toEqual(['cli.exit code=0 signal=null', 'verify.start', 'verify.end code=3']);
  expect(all.at(-1)).toMatchObject({kind:'run.end', status:'completed', score:0});
  expect(all.findIndex(e => e.label === 'cli.exit code=0 signal=null')).toBeLessThan(all.findIndex(e => e.label === 'verify.start'));
});
it('terminates a synchronous spawn throw and preserves null exit', async () => {
  mocks.spawn.mockImplementation(() => {throw new Error('spawn denied');});
  await dispatch();
  expect(events().map(e => e.kind)).toEqual(['run.start','step','run.end']);
  expect(events()[1].label).toBe('cli.exit code=null signal=null');
  expect(events().at(-1)).toMatchObject({status:'spawn-error',exitCode:null});
});
it('ends when the verifier throws, keeps the developer exit and says the dispatch errored', async () => {
  mocks.spawn.mockImplementationOnce(() => { // git: the tree read before the CLI (--verify)
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:122});
    queueMicrotask(() => proc.emit('close',0,null)); return proc;
  }).mockImplementationOnce(() => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => proc.emit('close',0,null)); return proc;
  }).mockImplementationOnce(() => {
    const proc = Object.assign(new EventEmitter(), {stdout:{on() {throw new Error('verifier listener failed');}},stderr:new EventEmitter()});
    return proc;
  });
  await expect(dispatch('--verify','mock verifier')).rejects.toThrow('verifier listener failed');
  expect(events().at(-1)).toMatchObject({kind:'run.end',exitCode:0,status:'dispatch-error',nodeId:null});
});
it('records failed and blocked statuses without rewriting decideBlocked semantics', async () => {
  for (const [stderr, status] of [['ordinary failure','failed'], ['quota exceeded','blocked']]) {
    mocks.live.mockClear();
    mocks.spawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
      queueMicrotask(() => {proc.stderr.emit('data',stderr);proc.emit('close',2,null);});return proc;
    });
    await dispatch('--role','muse');
    expect(events().at(-1)).toMatchObject({kind:'run.end',status,exitCode:2});
  }
});
it('counts directory creation errors without changing the run', async () => {
  mocks.mkdir.mockImplementation(() => {throw new Error('readonly');});
  await dispatch();
  expect(events().at(-1)).toMatchObject({status:'completed'});
  expect(process.stderr.write).toHaveBeenLastCalledWith(expect.stringContaining('eventWriteErrors=1'));
});
it('keeps unicode stdout raw and emits complete lines across byte splits', async () => {
  const line = '{"type":"item.completed","item":{"type":"agent_message","text":"hi ’"}}';
  mocks.spawn.mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => {
      const bytes = Buffer.from(line); const split = bytes.indexOf(Buffer.from('’')) + 1;
      proc.stdout.emit('data',bytes.subarray(0,split));proc.stdout.emit('data',bytes.subarray(split));proc.emit('close',0,null);
    });return proc;
  });
  await dispatch();
  expect(raw().map(e => e.line)).toEqual([line]);
  expect(JSON.parse(mocks.append.mock.calls[0][1])).toMatchObject({stdoutTail:line,finalText:'hi ’'});
});
it('isolates concurrent dispatches of the same task', async () => {
  const children: typeof child[] = [];
  mocks.spawn.mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    children.push(proc);return proc;
  });
  const runs = [dispatch(),dispatch()];
  await vi.waitFor(() => expect(children).toHaveLength(2));
  const starts = events().filter(e => e.kind === 'run.start');
  expect(new Set(starts.map(e => e.runId)).size).toBe(2);
  children[1].stdout.emit('data','second\n');children[0].stdout.emit('data','first\n');
  children[1].emit('close',0,null);children[0].emit('close',0,null);
  await Promise.all(runs);
  for (const start of starts) {
    const own = events().filter(e => e.runId === start.runId);
    expect(own.map(e => e.seq)).toEqual([0,1,2,3]);
    expect(own.map(e => e.kind)).toEqual(['run.start','unparsed','step','run.end']);
    expect(own[2].label).toBe('cli.exit code=0 signal=null');
  }
});
it('has machine-readable flags on every dispatchable policy route', () => {
  for (const [role, flag, value] of [['reason','--json',null],['easy','--json',null],['muse','--json',null],['implement','--format','json'],['breadth','--output-format','stream-json']]) {
    const argv = policy.routes[role!].argv;
    expect(argv).toContain(flag);
    if (value) expect(argv[argv.indexOf(flag) + 1]).toBe(value);
  }
});
it('persists the mocked child stream to real owner-only per-run files under ORCHESTRA_LIVE_DIR', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-live-'));
  vi.stubEnv('ORCHESTRA_LIVE_DIR', directory);
  mocks.mkdir.mockImplementation(fs.mkdirSync);
  mocks.live.mockImplementation(fs.appendFileSync);
  try {
    await dispatch('--task','mock-disk');
    const node = JSON.parse(mocks.append.mock.calls[0][1]);
    expect(node.liveFile).toBe(path.join(directory, 'mock-disk', `${node.runId}.jsonl`));
    const file = node.liveFile;
    for (const f of [file, file.replace(/\.jsonl$/,'.raw.jsonl')]) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const saved = fs.readFileSync(file,'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    expect(saved[0]).toMatchObject({kind:'run.start',seq:0});
    expect(saved.at(-1)).toMatchObject({kind:'run.end',nodeId:node.nodeId,status:'completed'});
    expect(saved.map(e => e.seq)).toEqual(saved.map((_, i) => i));
    const rawFile = file.replace(/\.jsonl$/,'.raw.jsonl');
    expect(fs.readFileSync(rawFile,'utf8').trimEnd().split('\n').map(line => JSON.parse(line)).filter(e => e.stream === 'stdout').map(e => e.line)).toEqual(fixture.trimEnd().split('\n'));
  } finally { vi.unstubAllEnvs(); fs.rmSync(directory, {recursive:true,force:true}); }
});

const opencodeRun = (lines: string[], code: number) => mocks.spawn.mockImplementation((command: string) => {
  const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
  queueMicrotask(() => {
    if (command === 'opencode') proc.stdout.emit('data', lines.map(line => `${line}\n`).join(''));
    proc.emit('close', command === 'opencode' ? code : 0, null);
  });
  return proc;
});
it('marks an opencode quota error event as blocked and unscored on an untouched tree, at any exit code', async () => {
  // Source-derived, NOT captured: opencode 1.18.34 --format json writes this event to stdout only, then exits 1.
  const error = '{"type":"error","timestamp":1,"sessionID":"s","error":{"name":"APIError","data":{"message":"quota exceeded"}}}';
  for (const code of [1, 0]) {
    mocks.live.mockClear(); mocks.append.mockClear();
    opencodeRun([error], code);
    await dispatch('--role','implement','--verify','true');
    expect(events().filter(e => e.kind === 'warn').map(e => e.text)).toEqual(['quota exceeded']);
    expect(events().at(-1)).toMatchObject({kind:'run.end', status:'blocked', exitCode:code, score:null});
    expect(JSON.parse(mocks.append.mock.calls[0][1])).toMatchObject({blocked:true, score:null});
  }
});
it('does not treat model-authored limit wording from opencode as a refusal', async () => {
  opencodeRun(['{"type":"text","part":{"text":"the docs say: quota exceeded"}}'], 1);
  await dispatch('--role','implement');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', exitCode:1});
});
it('rejects a task name that could leave the live and tree directories before touching anything', async () => {
  for (const task of ['../tree', '..', '.', 'a/b', 'a\\b', '', '--share', '--continue', '-c', '.hidden', '_x']) {
    await expect(main(['--role','reason','--task',task,'--prompt','p'])).rejects.toThrow(/task/);
  }
  expect(mocks.policy).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.mkdir).not.toHaveBeenCalled();
  expect(mocks.live).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
});
it('says dispatch-error when the tree write throws after the run', async () => {
  mocks.append.mockRejectedValue(new Error('tree readonly'));
  await expect(dispatch()).rejects.toThrow('tree readonly');
  expect(events().at(-1)).toMatchObject({kind:'run.end', exitCode:0, status:'dispatch-error', nodeId:null});
});
it('advances seq only after a successful write', async () => {
  let failed = false;
  mocks.live.mockImplementation((_file: string, body: string) => {
    if (!failed && body.includes('"kind":"run.start"')) { failed = true; throw new Error('transient'); }
  });
  await dispatch();
  const all = events().filter(e => e.kind !== 'run.start');
  expect(all.map(e => e.seq)).toEqual(all.map((_, i) => i));
});
it('rejects inherited object names as unknown placeholders before spawn', async () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    policy = structuredClone(originalPolicy);
    policy.routes.reason.argv.push(`{${name}}`);
    await expect(dispatch()).rejects.toThrow(`unknown placeholder {${name}}`);
  }
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('run.start says what the run is for: --title, else the first prompt line without markdown or control characters', async () => {
  await main(['--role', 'reason', '--task', 'mock-live', '--prompt', '\n\n# Slice 044 \u001b[2Jround 2 — findings\nbody']);
  expect(events()[0]).toMatchObject({ kind: 'run.start', title: 'Slice 044 round 2 — findings' });
  vi.resetAllMocks();
  mocks.policy.mockImplementation(async () => JSON.stringify(policy));
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 124 });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  await main(['--role', 'reason', '--task', 'mock-live', '--title', 'x'.repeat(300), '--prompt', '# ignored']);
  expect(events()[0].title).toBe('x'.repeat(120));
});
it('a SIGTERM while the CLI runs writes run.end failed with the signal, forwards it to the child and re-raises it', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242 });
    return child;
  });
  const before = process.listeners('SIGTERM').length;
  const pending = dispatch();
  await vi.waitFor(() => expect(events()[0]?.kind).toBe('run.start'));
  process.emit('SIGTERM', 'SIGTERM');
  expect(events().at(-1)).toMatchObject({ kind: 'run.end', status: 'failed', signal: 'SIGTERM' });
  expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
  expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  child.emit('close', null, 'SIGTERM'); await pending.catch(() => undefined);
  // exactly one run.end, and no handler left behind for the next dispatch
  expect(events().filter(e => e.kind === 'run.end')).toHaveLength(1);
  expect(process.listeners('SIGTERM').length).toBe(before);
});
it('runTitle: --title "" falls back to the prompt; OSC and bidi controls removed; never splits a code point', () => {
  expect(runTitle('', '# real title')).toBe('real title');
  expect(runTitle(undefined, '\u001b]8;;https://evil\u0007Slice\u001b]8;;\u0007 9')).toBe('Slice 9');
  expect(runTitle(undefined, 'Slice ‮txt.exe ⁦x⁩')).toBe('Slice txt.exe x');
  const cut = runTitle(undefined, 'a'.repeat(119) + '\u{1F600}x');
  expect([...cut]).toHaveLength(120);
  expect(cut.endsWith('\u{1F600}')).toBe(true);
});
it('a signal during the verifier goes to the verifier, never to the exited CLI pid', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  let verifier: any;
  mocks.spawn.mockImplementation((cmd: string) => {
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: cmd === '/bin/sh' ? 5555 : 4242 });
    if (cmd === '/bin/sh') verifier = c; else queueMicrotask(() => c.emit('close', 0, null));
    return c;
  });
  const pending = dispatch('--verify', 'sleep 100');
  await vi.waitFor(() => expect(events().some(e => e.kind === 'step' && e.label === 'verify.start')).toBe(true));
  process.emit('SIGTERM', 'SIGTERM');
  expect(kill).toHaveBeenCalledWith(5555, 'SIGTERM');
  expect(kill).not.toHaveBeenCalledWith(4242, 'SIGTERM');
  expect(events().at(-1)).toMatchObject({ kind: 'run.end', status: 'failed', signal: 'SIGTERM' });
  verifier.emit('close', null, 'SIGTERM'); await pending.catch(() => undefined);
});
it('closing the terminal (SIGHUP) also ends the run', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4243 });
    return child;
  });
  const before = process.listeners('SIGHUP').length;
  const pending = dispatch();
  await vi.waitFor(() => expect(events()[0]?.kind).toBe('run.start'));
  process.emit('SIGHUP', 'SIGHUP');
  expect(events().at(-1)).toMatchObject({ kind: 'run.end', status: 'failed', signal: 'SIGHUP' });
  child.emit('close', null, 'SIGHUP'); await pending.catch(() => undefined);
  expect(process.listeners('SIGHUP').length).toBe(before);
});
it('run.start carries the phase: --phase sanitized like the title and cut at 40 code points, else the role', async () => {
  await main(['--role', 'reason', '--task', 'mock-live', '--phase', '  review\u001b[31m  \u001b]0;x\u0007round‮ 2  ', '--prompt', 'p']);
  expect(events()[0]).toMatchObject({ kind: 'run.start', phase: 'review round 2' });
  for (const extra of [[], ['--phase', ''], ['--phase', '\u001b[2J\u0007']]) {
    vi.resetAllMocks();
    mocks.policy.mockImplementation(async () => JSON.stringify(policy));
    mocks.spawn.mockImplementation(() => {
      child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 125 });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    await main(['--role', 'reason', '--task', 'mock-live', ...extra, '--prompt', 'p']);
    expect(events()[0].phase).toBe('reason');
  }
});
it('runPhase: code-point cut at 40, never splits a pair; empty after cleaning falls back to the role', () => {
  expect(runPhase('p'.repeat(50), 'implement')).toBe('p'.repeat(40));
  const cut = runPhase('a'.repeat(39) + '\u{1F600}x', 'implement');
  expect([...cut]).toHaveLength(40);
  expect(cut.endsWith('\u{1F600}')).toBe(true);
  expect(runPhase(undefined, 'implement')).toBe('implement');
  expect(runPhase('⁦⁩', 'implement')).toBe('implement');
  // ARABIC LETTER MARK, zero-width space and word joiner are stripped like the other bidi controls.
  expect(runPhase('x\u061cy\u200bz\u2060w', 'dev')).toBe('xyzw');
  expect(runPhase('\u061c\u200b', 'dev')).toBe('dev');
  expect(runTitle('a\u061cb', '')).toBe('ab');
});

// A verifier that passes on a tree the CLI never touched proves the base was green, not that the
// developer did anything: the tree is snapshotted before the CLI and compared after it.
const scoredRun = ({ cli, git }: { cli: (proc: any) => void; git: string[] }) => {
  const calls: string[] = [];
  mocks.spawn.mockImplementation((command: string, args: string[]) => {
    calls.push(command);
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => {
      if (command === 'codex') return cli(proc);
      if (command === 'git') proc.stdout.emit('data', git.shift() ?? '');
      proc.emit('close', 0, null);
    });
    return proc;
  });
  return calls;
};
const node = () => JSON.parse(mocks.append.mock.calls[0][1]);
it('a CLI that could not start is unscored, skips the verifier, says why and exits 2', async () => {
  const calls = scoredRun({ cli: proc => proc.emit('error', Object.assign(new Error('spawn codex ENOENT'), {code:'ENOENT'})), git: [] });
  try {
    await dispatch('--verify','true');
    expect(events().at(-1)).toMatchObject({kind:'run.end', status:'spawn-error', score:null});
    expect(node()).toMatchObject({score:null, verify:null});
    expect(calls).not.toContain('/bin/sh');
    expect(process.exitCode).toBe(2);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('[dispatch] could not start codex: Error: spawn codex ENOENT'));
  } finally { process.exitCode = undefined; }
});
it('a failed CLI that left the tree as it was is unscored even when the verifier passes', async () => {
  scoredRun({ cli: proc => { proc.stderr.emit('data','Model not found'); proc.emit('close',1,null); },
    git: [' M already-dirty.ts\n', ' M already-dirty.ts\n?? orchestra/live/t/r.jsonl\n?? orchestra/tree/t.jsonl\n?? .orchestra-last.md\n?? node_modules/.cache/x.js\n'] });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', exitCode:1, score:null});
  expect(node()).toMatchObject({score:null, verify:{command:'true', code:0}});
  expect(process.stderr.write).toHaveBeenCalledWith('[dispatch] codex exited 1: Model not found\n');
});
it('a failed CLI that did change the tree keeps the verifier score', async () => {
  scoredRun({ cli: proc => proc.emit('close',1,null), git: ['', ' M src/parser.ts\n'] });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', score:1});
});
it('a completed CLI keeps the verifier score without reading the tree', async () => {
  const calls = scoredRun({ cli: proc => proc.emit('close',0,null), git: ['', ''] });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'completed', score:1});
  expect(calls.filter(c => c === 'git').length).toBeLessThanOrEqual(1);
});
it('a failed CLI in a workspace git cannot read is unscored', async () => {
  mocks.spawn.mockImplementation((command: string) => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => proc.emit('close', command === 'git' ? 128 : command === 'codex' ? 1 : 0, null));
    return proc;
  });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', score:null});
});
