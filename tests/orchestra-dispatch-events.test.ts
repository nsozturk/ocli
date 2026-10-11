import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), append: vi.fn(), live: vi.fn(), mkdir: vi.fn(), policy: vi.fn(), delta: vi.fn(), witness: vi.fn(), lstat: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async original => ({ ...await original<Record<string, unknown>>(), appendFileSync: mocks.live, mkdirSync: mocks.mkdir }));
vi.mock('node:fs/promises', async original => ({ ...await original<Record<string, unknown>>(), readFile: mocks.policy, appendFile: mocks.append, mkdir: vi.fn(), lstat: mocks.lstat }));
// The real witness by default (beforeEach); one test makes it throw.
vi.mock('../dispatcher/witness.mjs', async original => ({ ...await original<Record<string, unknown>>(), witness: mocks.witness }));
vi.mock('../dispatcher/usage.mjs', async original => ({ ...await original<Record<string, unknown>>(), readCodexUsage: vi.fn(async () => ({status:'unknown'})), readGlmUsage: vi.fn(async () => ({status:'unknown'})), claudeUsageFromLead: vi.fn(), usageDelta: mocks.delta, gateFor: vi.fn() }));
// @ts-expect-error plain ESM tooling
import { main, runBrief, runPhase, runTitle } from '../dispatcher/dispatch.mjs';
const realWitness = (await vi.importActual<{ witness: (...args: unknown[]) => unknown }>('../dispatcher/witness.mjs')).witness;
const originalPolicy = JSON.parse(readFileSync(new URL('../dispatcher/policy.example.json', import.meta.url), 'utf8'));
let policy: typeof originalPolicy;
let child: EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; pid: number};
const fixture = readFileSync(new URL('./fixtures/orchestra-events/codex.jsonl', import.meta.url), 'utf8');
const dispatch = (...extra: string[]) => main(['--role', 'reason', '--task', 'mock-live', '--prompt', 'literal {unknown} {variant}', ...extra]);
const events = () => mocks.live.mock.calls.filter(([file, body]) => body && !String(file).endsWith('.raw.jsonl')).map(([, body]) => JSON.parse(body));
const raw = () => mocks.live.mock.calls.filter(([file, body]) => body && String(file).endsWith('.raw.jsonl')).map(([, body]) => JSON.parse(body));
let treeDir: string;
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  fs.mkdirSync(path.resolve('tmp'), { recursive: true });
  treeDir = fs.mkdtempSync(path.resolve('tmp', 'rs1-events-tree-'));
  vi.stubEnv('ORCHESTRA_TREE_DIR', treeDir);
  vi.resetAllMocks();
  policy = structuredClone(originalPolicy);
  mocks.witness.mockImplementation(realWitness);
  // Every tree entry a regular file, so the readFile mock decides its content; the FIFO test uses the real lstat.
  mocks.lstat.mockImplementation(async () => ({ isFile: () => true, isSymbolicLink: () => false }));
  mocks.policy.mockImplementation(async () => JSON.stringify(policy));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 123 });
    queueMicrotask(() => { child.stdout.emit('data', fixture.slice(0, 43)); child.stdout.emit('data', fixture.slice(43)); child.stderr.emit('data', 'err\r\ntail'); child.emit('close', 0, null); });
    return child;
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  fs.rmSync(treeDir, { recursive: true, force: true });
});
it('writes contiguous events with dispatcher receipt time, raw lines and tree linkage', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-02T03:04:05.000Z'));
  try {
    await dispatch();
    const all = events();
    expect(all[0]).toMatchObject({kind:'run.start', seq:0, pid:123, parentId:null});
    expect(all.at(-1)).toMatchObject({kind:'run.end',status:'completed',exitCode:0,score:null});
    expect(all.map(e => e.seq)).toEqual(all.map((_, i) => i));
    expect(all.every(e => e.at === '2030-01-02T03:04:05.000Z')).toBe(true);
    expect(path.dirname(mocks.append.mock.calls[0][0])).toBe(treeDir);
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
    // With --verify the tree is read (git) before and after the CLI: those spawns are not counted here.
    const code = command === 'git' ? 0 : call++ === 0 ? 0 : 3;
    queueMicrotask(() => {if (command === 'git' && call > 0) proc.stdout.emit('data', '? new.ts\n'); proc.emit('close', code, null);});
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
  }).mockImplementationOnce(() => { // git: the tree read after the CLI, before the verifier
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:124});
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
it('a completed CLI that left the tree untouched is unscored: the verifier only proved the base green', async () => {
  scoredRun({ cli: proc => proc.emit('close',0,null), git: ['# branch.oid aaa\n', '# branch.oid aaa\n'] });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'completed', score:null});
  expect(node()).toMatchObject({score:null, verify:{command:'true', code:0}});
});
it('a completed CLI that changed the tree keeps the verifier score', async () => {
  scoredRun({ cli: proc => proc.emit('close',0,null), git: ['', '? src/parser.ts\n'] });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'completed', score:1});
});
it('a CLI that committed its work (clean tree before and after, HEAD moved) keeps the verifier score', async () => {
  scoredRun({ cli: proc => proc.emit('close',0,null), git: ['# branch.oid aaa\n# branch.head main\n', '# branch.oid bbb\n# branch.head main\n'] });
  await dispatch('--verify','true');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'completed', score:1});
});
// Review finding: the after-read used to run AFTER the verifier, so a report the verifier wrote
// looked like the CLI's work and a CLI that crashed before writing a byte scored 1.
it('a file the verifier writes is not the CLI\'s work: a failed CLI that wrote nothing stays unscored', async () => {
  let verifierRan = false;
  mocks.spawn.mockImplementation((command: string) => {
    if (command === '/bin/sh') verifierRan = true;
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => {
      if (command === 'git') proc.stdout.emit('data', verifierRan ? '? test-report.xml\n' : '');
      proc.emit('close', command === 'codex' ? 1 : 0, null);
    });
    return proc;
  });
  await dispatch('--verify','echo x > test-report.xml');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', score:null});
});
// Review finding: porcelain lines carry no content, so more work in an already-dirty file was invisible.
it('a failed CLI that did real work in an already-dirty file keeps the verifier score', async () => {
  let cliRan = false;
  const dirty = '1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 a.txt\n';
  scoredRun({ cli: proc => { cliRan = true; proc.emit('close',1,null); }, git: [dirty, dirty] });
  mocks.policy.mockImplementation(async (file: string) => String(file).endsWith('a.txt')
    ? (cliRan ? 'dirty\nreal-work\n' : 'dirty\n') : JSON.stringify(policy));
  await dispatch('--verify','grep -q real-work a.txt');
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', score:1});
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
// Mutant (c) survived the ported set: no test had an unreadable tree BEFORE and a readable one after.
it('a failed CLI whose tree git could not read before the run is unscored, whatever it reads after', async () => {
  let gitCalls = 0;
  mocks.spawn.mockImplementation((command: string) => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => {
      if (command === 'git' && gitCalls++ > 0) proc.stdout.emit('data', ' M src/parser.ts\n');
      proc.emit('close', command === 'git' ? (gitCalls === 1 ? 128 : 0) : command === 'codex' ? 1 : 0, null);
    });
    return proc;
  });
  await dispatch('--verify','true');
  expect(gitCalls).toBe(2);
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', score:null});
});
// Review finding: mutant `treeAfter === null ||` removed survived all 74 dispatch tests.
it('a failed CLI whose tree git cannot read after the run is unscored, whatever it read before', async () => {
  let gitCalls = 0;
  mocks.spawn.mockImplementation((command: string) => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => {
      const code = command === 'git' ? (gitCalls++ === 0 ? 0 : 128) : command === 'codex' ? 1 : 0;
      proc.emit('close', code, null);
    });
    return proc;
  });
  await dispatch('--verify','true');
  expect(gitCalls).toBe(2);
  expect(events().at(-1)).toMatchObject({kind:'run.end', status:'failed', score:null});
});
it('the tree node records the run title and its phase: --phase, else the role', async () => {
  await main(['--role', 'reason', '--task', 'mock-live', '--phase', 'review round 2', '--title', 'Slice 047', '--prompt', 'p']);
  expect(node()).toMatchObject({ role: 'reason', phase: 'review round 2', title: 'Slice 047' });
  mocks.append.mockClear();
  await main(['--role', 'reason', '--task', 'mock-live', '--prompt', '# first line\nsecond']);
  expect(node()).toMatchObject({ role: 'reason', phase: 'reason', title: 'first line' });
});

// --- the witness: closing claims checked against the run's own trace --------------------------
const claiming = (text: string) => fixture.replace('"text":"DONE"', `"text":${JSON.stringify(text)}`);
/** A run whose CLI says `text`; git answers from `git` (by subcommand) and the verifier exits `verifyCode`. */
/** `out` as a list answers successive calls in order (the tree before, then after). */
const witnessedRun = ({ text, git = {}, verifyCode = 0, cliOut }: { text: string; git?: Record<string, { out?: string | string[]; err?: string; code?: number }>; verifyCode?: number; cliOut?: string }) => {
  const calls: { command: string; args: string[] }[] = [];
  mocks.spawn.mockImplementation((command: string, args: string[]) => {
    calls.push({ command, args });
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
    queueMicrotask(() => {
      if (command === 'codex') { proc.stdout.emit('data', cliOut ?? claiming(text)); return proc.emit('close', 0, null); }
      if (command === '/bin/sh') return proc.emit('close', verifyCode, null);
      const answer = git[sub(args)] ?? {};
      const out = Array.isArray(answer.out) ? answer.out.shift() : answer.out;
      if (out) proc.stdout.emit('data', out);
      if (answer.err) proc.stderr.emit('data', answer.err);
      proc.emit('close', answer.code ?? 0, null);
    });
    return proc;
  });
  return calls;
};
const runEnd = () => events().at(-1);
/** git's subcommand, after any -c key=value pairs. */
const sub = (args: string[]) => args[args.findIndex((a, i) => a !== '-c' && args[i - 1] !== '-c')]!;
const gitCalls = (calls: { command: string; args: string[] }[]) => calls.filter(c => c.command === 'git').map(c => sub(c.args));
it('a run that says all tests pass and ran no test gets claimedTestsButNone on the tree node and on run.end', async () => {
  witnessedRun({ text: 'All tests pass.' });
  await dispatch();
  expect(node().witness).toEqual({ v: 1, claims: ['testsPass'], findings: [{ code: 'claimedTestsButNone', text: expect.any(String) }] });
  expect(runEnd()).toMatchObject({ kind: 'run.end', status: 'completed', witness: { findings: ['claimedTestsButNone'] } });
});
it('run.end carries the finding codes only, never their text; a clean witness is an empty list', async () => {
  witnessedRun({ text: 'I looked around.' });
  await dispatch();
  expect(node().witness).toEqual({ v: 1, claims: [], findings: [] });
  expect(runEnd().witness).toEqual({ findings: [] });
});
const codexLine = (item: unknown) => `${JSON.stringify({ type: 'item.completed', item })}\n`;
const emitting = (out: string) => mocks.spawn.mockImplementation(() => {
  const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter(),pid:123});
  queueMicrotask(() => { proc.stdout.emit('data', out); proc.emit('close', 0, null); });
  return proc;
});
it('the witness reads the tool.end records dispatch emitted, capped at the newest 5000', async () => {
  emitting(codexLine({ type: 'command_execution', command: 'ls', exit_code: 0 }).repeat(5100));
  // A copy at call time: dispatch keeps appending to the live array (run.end) after the witness ran.
  let seen: { seq: number; runId: string; kind: string }[] = [];
  mocks.witness.mockImplementation((list: typeof seen, ...rest: unknown[]) => { seen = [...list]; return realWitness(list, ...rest); });
  await dispatch();
  expect(seen).toHaveLength(5000);
  // run.start (0), 5100 tool.end (1..5100), the cli.exit step (5101, not a tool.end): the oldest 100 dropped.
  expect(seen[0]!.seq).toBe(101);
  expect(seen.at(-1)).toMatchObject({ kind: 'tool.end', seq: 5100, runId: events()[0].runId });
  expect(seen.every(e => e.kind === 'tool.end')).toBe(true);
});
it('streamed message deltas never evict the tool events the witness reads', async () => {
  witnessedRun({ text: '', git: { status: { out: '# branch.oid aaa\n' } },
    cliOut: codexLine({ type: 'file_change', status: 'completed', changes: [{ kind: 'add', path: 'a.ts' }] })
      + codexLine({ type: 'agent_message', text: 'Implemented.' }).repeat(5100) });
  await dispatch();
  expect(mocks.witness.mock.calls[0]![0]).toEqual([expect.objectContaining({ kind: 'tool.end', tool: 'file_change', seq: 1 })]);
  expect(runEnd().witness).toEqual({ findings: ['doneNoChange'] });
});
it('a record whose write failed never reaches the witness', async () => {
  mocks.live.mockImplementation(() => { throw new Error('disk full'); });
  witnessedRun({ text: 'All tests pass.' });
  await dispatch();
  expect(mocks.witness.mock.calls[0]![0]).toEqual([]);
});
it('a throwing witness is recorded on the node and the run still ends completed, with no witness on run.end', async () => {
  mocks.witness.mockImplementation(() => { throw new Error('witness exploded'); });
  witnessedRun({ text: 'All tests pass.' });
  await expect(dispatch()).resolves.toBeUndefined();
  expect(runEnd()).toMatchObject({ kind: 'run.end', status: 'completed', exitCode: 0 });
  expect(runEnd()).not.toHaveProperty('witness');
  expect(node().witness).toEqual({ v: 1, error: 'Error: witness exploded' });
});
it('score, status, exit code and the CLI argv are the same with the witness and without it (it throwing)', async () => {
  const outcome = async (throws: boolean, verifyCode: number) => {
    mocks.live.mockClear(); mocks.append.mockClear(); process.exitCode = undefined;
    if (throws) mocks.witness.mockImplementation(() => { throw new Error('off'); });
    else mocks.witness.mockImplementation(realWitness);
    const calls = witnessedRun({ text: 'All tests pass. Done.', verifyCode, git: { status: { out: ['', '? src/a.ts\n'] } } });
    await dispatch('--verify', 'npm test');
    // Timings and ids differ run to run; everything else must not.
    const { witness: _w, runId: _r, nodeId: _n, liveFile: _l, recordedAt: _t, ms: _m, verify: { ms: _vm, ...verify }, ...others } = node();
    const rest = { ...others, verify };
    const { witness: _ew, runId: _er, nodeId: _en, seq: _es, at: _ea, ms: _em, ...end } = runEnd();
    return { end, rest, exitCode: process.exitCode, cli: calls.filter(c => c.command === 'codex') };
  };
  try {
    for (const verifyCode of [0, 1]) {
      const witnessed = await outcome(false, verifyCode);
      // The real witness did have something to say on the failing verifier: not a no-op standing in for itself.
      expect(node().witness.findings.map((f: { code: string }) => f.code)).toEqual(verifyCode ? ['verifyContradicts'] : []);
      expect(await outcome(true, verifyCode)).toEqual(witnessed);
    }
    expect((await outcome(false, 1)).end).toMatchObject({ status: 'completed', score: 0 });
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = undefined; }
});
it('with --verify the witness reuses the tree reads: no extra git call, and an unchanged tree after "Fixed." is doneNoChange', async () => {
  const calls = witnessedRun({ text: 'Fixed.', git: { status: { out: '# branch.oid aaa\n' } } });
  await dispatch('--verify', 'true');
  expect(calls.filter(c => c.command === 'git')).toHaveLength(2);
  expect(runEnd()).toMatchObject({ status: 'completed', score: null, witness: { findings: ['doneNoChange'] } });
});
it('without --verify a done claim reads the tree once after the CLI; the branch header is not a change', async () => {
  for (const [out, findings] of [['# branch.oid aaa\n# branch.head main\n', ['doneNoChange']], ['# branch.oid aaa\n? src/a.ts\n', []]] as const) {
    mocks.live.mockClear();
    const calls = witnessedRun({ text: 'Fixed.', git: { status: { out } } });
    await dispatch();
    expect(gitCalls(calls)).toEqual(['status', 'rev-list']);
    expect(runEnd().witness).toEqual({ findings });
  }
});
it('the tree read hashes regular files only: a FIFO or a symlink is never opened (a FIFO would hang the dispatcher)', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const ws = fileURLToPath(new URL('../tmp/agent-witness-claims/tree-ws', import.meta.url));
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  try {
    execFileSync('mkfifo', [path.join(ws, 'fifo')]);
    fs.symlinkSync('/etc/hosts', path.join(ws, 'link'));
    fs.writeFileSync(path.join(ws, 'real.txt'), 'x');
    mocks.lstat.mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat);
    // A read of the FIFO never settles, as a real open() of one with no writer would not.
    mocks.policy.mockImplementation(async (file: string) => String(file).startsWith(ws)
      ? (String(file).endsWith('real.txt') ? 'x' : new Promise(() => undefined)) : JSON.stringify(policy));
    witnessedRun({ text: 'Fixed.', git: { status: { out: '# branch.oid aaa\n? fifo\n? link\n? real.txt\n' } } });
    await dispatch('--root', ws);
    expect(mocks.policy.mock.calls.map(([file]) => String(file)).filter(file => file.startsWith(ws))).toEqual([path.join(ws, 'real.txt')]);
    expect(runEnd()).toMatchObject({ kind: 'run.end', status: 'completed', witness: { findings: [] } });
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
it('git status runs with the repo fsmonitor hook switched off', async () => {
  const calls = witnessedRun({ text: 'Fixed.', git: { status: { out: '# branch.oid aaa\n' } } });
  await dispatch();
  const status = calls.filter(c => c.command === 'git' && sub(c.args) === 'status');
  expect(status).toHaveLength(1);
  expect(status[0]!.args.slice(0, 3)).toEqual(['-c', 'core.fsmonitor=false', 'status']);
});
it('no done claim, no tree read; an unreadable tree is unknown, never "no change"', async () => {
  let calls = witnessedRun({ text: 'I looked around.' });
  await dispatch();
  expect(calls.filter(c => c.command === 'git')).toEqual([]);
  mocks.live.mockClear();
  calls = witnessedRun({ text: 'DONE', git: { status: { code: 128, err: 'fatal: not a git repository' } } });
  await dispatch();
  expect(runEnd().witness).toEqual({ findings: [] });
});
it('a claimed sha must be a commit made during the run: one rev-list of HEAD since the CLI started', async () => {
  const full = `3f2a1bc${'0'.repeat(33)}`;
  for (const [answer, findings] of [
    // An old commit (main's HEAD, any object in the store) is not in the list: git cat-file -e would pass it.
    [{ out: `${'9'.repeat(40)}\n` }, ['commitNotFound']],
    [{ out: '' }, ['commitNotFound']],
    [{ out: `${'9'.repeat(40)}\n${full}\n` }, []],
    [{ code: 128, err: 'fatal: not a git repository (or any of the parent directories): .git\n' }, []],
  ] as const) {
    mocks.live.mockClear(); mocks.append.mockClear();
    const before = Math.floor(Date.now() / 1000);
    const calls = witnessedRun({ text: 'Committed 3f2a1bc.', git: { 'rev-list': answer, 'cat-file': { code: 0 } } });
    await dispatch();
    const git = calls.filter(c => c.command === 'git');
    expect(git).toHaveLength(1);
    const [subcommand, maxAge, ...rest] = git[0]!.args;
    expect([subcommand, ...rest]).toEqual(['rev-list', '--max-count=1000', 'HEAD']);
    expect(Number(maxAge!.replace('--max-age=', ''))).toBeGreaterThanOrEqual(before);
    expect(runEnd().witness).toEqual({ findings });
  }
});
it('one rev-list answers every claimed sha', async () => {
  const calls = witnessedRun({ text: 'commit aaaaaa1, commit aaaaaa2, commit aaaaaa3, commit aaaaaa4', git: { 'rev-list': { out: `aaaaaa2${'0'.repeat(33)}\n` } } });
  await dispatch();
  expect(gitCalls(calls)).toEqual(['rev-list']);
  expect(node().witness.findings[0].text).toContain('aaaaaa1, aaaaaa3, aaaaaa4');
});
it('policy.json testCommandPattern reaches the witness', async () => {
  policy.testCommandPattern = 'printf hi';
  witnessedRun({ text: 'All tests pass.' });
  await dispatch();
  expect(runEnd().witness).toEqual({ findings: [] });
});
it('the signal-path run.end carries no witness', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4244 });
    return child;
  });
  const pending = dispatch();
  await vi.waitFor(() => expect(events()[0]?.kind).toBe('run.start'));
  process.emit('SIGTERM', 'SIGTERM');
  expect(runEnd()).toMatchObject({ kind: 'run.end', signal: 'SIGTERM' });
  expect(runEnd()).not.toHaveProperty('witness');
  child.emit('close', null, 'SIGTERM'); await pending.catch(() => undefined);
});
// Mutant D9 (a moved HEAD not counted) survived the first table: no test committed under --verify.
it('with --verify a CLI that committed its work (clean tree, HEAD moved) is a change, not doneNoChange', async () => {
  witnessedRun({ text: 'Fixed.', git: { status: { out: ['# branch.oid aaa\n', '# branch.oid bbb\n'] } } });
  await dispatch('--verify', 'true');
  expect(runEnd()).toMatchObject({ status: 'completed', score: 1, witness: { findings: [] } });
});
it('without --verify a clean tree whose commits git cannot list is unknown, never "no change"', async () => {
  witnessedRun({ text: 'Fixed.', git: { status: { out: '# branch.oid bbb\n' }, 'rev-list': { code: 128, err: "fatal: ambiguous argument 'HEAD'" } } });
  await dispatch();
  expect(runEnd().witness).toEqual({ findings: [] });
});
it('without --verify a clean tree with a commit made since the CLI started is a change; none is not', async () => {
  for (const [made, findings] of [[`${'b'.repeat(40)}\n`, []], ['', ['doneNoChange']]] as const) {
    mocks.live.mockClear();
    witnessedRun({ text: 'Done and committed.', git: { status: { out: '# branch.oid bbb\n' }, 'rev-list': { out: made } } });
    await dispatch();
    expect(runEnd().witness).toEqual({ findings });
  }
});
// Feature 7 (prefix-hash): a 12-hex sha of --prompt alone, the byte-stable cache prefix. The
// per-dispatch --suffix must not move it, and the hash must never reach the CLI.
const prefixRun = async (prompt: string, ...extra: string[]) => {
  mocks.live.mockClear(); mocks.append.mockClear(); mocks.spawn.mockClear();
  await main(['--role', 'reason', '--task', 'mock-live', '--prompt', prompt, ...extra]);
  return { start: events()[0], node: JSON.parse(mocks.append.mock.calls[0][1]), argv: mocks.spawn.mock.calls[0][1] as string[] };
};
it('prefixSha is the sha256 of --prompt alone: a different --suffix keeps it, a different --prompt moves it', async () => {
  const { createHash } = await import('node:crypto');
  const a = await prefixRun('shared spec', '--suffix', 'workdir A');
  const b = await prefixRun('shared spec', '--suffix', 'workdir B');
  const c = await prefixRun('other spec', '--suffix', 'workdir A');
  expect(a.start.prefixSha).toBe(createHash('sha256').update('shared spec', 'utf8').digest('hex').slice(0, 12));
  expect(a.start.prefixSha).toMatch(/^[0-9a-f]{12}$/);
  expect(b.start.prefixSha).toBe(a.start.prefixSha);
  expect(c.start.prefixSha).not.toBe(a.start.prefixSha);
  for (const run of [a, b, c]) expect(run.node.prefixSha).toBe(run.start.prefixSha);
});
it('the prefix hash never alters the prompt or argv the CLI is spawned with', async () => {
  const withSuffix = await prefixRun('shared spec', '--suffix', 'workdir A');
  const bare = await prefixRun('shared spec');
  expect(withSuffix.argv.at(-1)).toBe('shared spec\n\nworkdir A');
  expect(bare.argv.at(-1)).toBe('shared spec');
  expect(withSuffix.argv.slice(0, -1)).toEqual(bare.argv.slice(0, -1));
  expect(withSuffix.argv.some(arg => arg.includes(withSuffix.start.prefixSha))).toBe(false);
  expect(withSuffix.node.prompt).toBe('shared spec');
  expect(withSuffix.node.promptBytes).toBe(Buffer.byteLength('shared spec', 'utf8'));
});

// run.start.brief: what the person reads in the pane's expanded card, never the whole prompt.
const SPEC = '\n# Slice RK1 — catalogue adapter\n\nWrite the catalogue adapter for\nthe GLM route.\n\n## Details\nSECRET-LATER-PARAGRAPH\n';
const WORKTREE = 'Your worktree (work ONLY here): /x/senatus-rk1-fix';
it('runBrief: the first heading, the first task paragraph, then the --suffix, folded, joined with " · "', () => {
  expect(runBrief(undefined, SPEC, `slice RK1\n${WORKTREE}`)).toBe('Slice RK1 — catalogue adapter · Write the catalogue adapter for the GLM route. · slice RK1');
  // No suffix, no heading: the first paragraph alone; it never reaches past the first blank line.
  expect(runBrief(undefined, 'line one\nline two\n\nlater', undefined)).toBe('line one line two');
  // A paragraph ends at a heading too, and a prompt of headings only gives the first heading.
  expect(runBrief(undefined, 'intro\n# H\nbody', '')).toBe('H · intro');
  expect(runBrief(undefined, '## Only\n### Headings', '')).toBe('Only');
  expect(runBrief(undefined, SPEC, undefined)).not.toContain('SECRET-LATER-PARAGRAPH');
});
it('runBrief: a paragraph that opens in emphasis is a constraint, not the task; markdown markers are stripped', () => {
  expect(runBrief(undefined, '# T\n\n**RUN ONLY your tests.** Never the suite:\n`npx vitest run x`\n\n__Also loud__\n\n- Port the `adapter` and **keep** it small.\n', '')).toBe('T · Port the adapter and keep it small.');
  // All paragraphs emphatic: the first one, markers stripped.
  expect(runBrief(undefined, '**Only this.**\n\n__And this.__', '')).toBe('Only this.');
  // From the suffix only the worktree clause goes (the pane draws the root on its own row).
  expect(runBrief(undefined, 'p', `SLICE: RK1 only (catalogue)\n${WORKTREE}`)).toBe('p · SLICE: RK1 only (catalogue)');
  expect(runBrief(undefined, 'p', `SLICE: RK1. ${WORKTREE}`)).toBe('p · SLICE: RK1.');
  expect(runBrief(undefined, 'p', WORKTREE)).toBe('p');
});
it('runBrief on a realistic prompt (a constraint paragraph first) with a worktree suffix: it opens with the task, and no path', () => {
  const prompt = [
    '# RK1 fix round — apply the lead review to the catalogue adapter',
    '',
    '**RUN ONLY THE TEST FILES YOU TOUCH. NEVER the full suite, never anything in the background.** The only test command you may run is:',
    '`npx vitest run tests/catalogue.test.ts`',
    '',
    'You are a developer on this repo. Fix the two review findings in the catalogue adapter: the cache key',
    'ignores the locale, and an empty page throws instead of returning no rows.',
    '',
    '### RK1-B1 (blocker)',
    'Details that never reach the brief.',
  ].join('\n');
  const brief = runBrief(undefined, prompt, WORKTREE);
  const head = [...brief].slice(0, 72).join('');
  expect(head).toBe('RK1 fix round — apply the lead review to the catalogue adapter · You are');
  expect(head).not.toMatch(/\//);
  expect(brief).not.toContain('/x/');
  expect(brief).not.toMatch(/RUN ONLY|npx vitest|Details/);
  expect(brief).toContain('Fix the two review findings in the catalogue adapter');
});
it('runBrief: --brief wins (an empty one falls back); escapes, controls and bidi stripped; at most 600 code points, never a split pair', () => {
  expect(runBrief('  Port the\n adapter  ', SPEC, 'suffix')).toBe('Port the adapter');
  expect(runBrief('', 'p', 's')).toBe('p · s');
  expect(runBrief(undefined, 'a\u001b[31mb\u001b]8;;https://x\u0007c\u0007d ‮е⁦x⁩ ​y', undefined)).toBe('abcd еx y');
  const long = runBrief(undefined, 'a'.repeat(599) + '\u{1F600}' + 'z'.repeat(5000), undefined);
  expect([...long]).toHaveLength(600);
  expect(long.endsWith('\u{1F600}')).toBe(true);
  expect([...runBrief('b'.repeat(900), '', '')]).toHaveLength(600);
});
it('run.start carries the brief: derived from the prompt and --suffix, or --brief as given', async () => {
  await main(['--role', 'reason', '--task', 'mock-live', '--prompt', SPEC, '--suffix', `slice RK1\n${WORKTREE}`]);
  expect(events()[0]).toMatchObject({ kind: 'run.start', brief: 'Slice RK1 — catalogue adapter · Write the catalogue adapter for the GLM route. · slice RK1' });
  vi.resetAllMocks();
  mocks.policy.mockImplementation(async () => JSON.stringify(policy));
  mocks.spawn.mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 126 });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  await main(['--role', 'reason', '--task', 'mock-live', '--brief', 'Own words', '--prompt', SPEC]);
  expect(events()[0].brief).toBe('Own words');
});
