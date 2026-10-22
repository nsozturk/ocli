import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// PS1: a provider's own window-limit message becomes a dated stop the router honours.
// Fixtures are faithful to the 2026-10-12 night runs (main's r2-tabularium / r5-viewer nodes):
// cline writes {"type":"error","message":...} JSON lines to STDERR; opencode writes
// {type:"error",error:{...}} to stdout. Through main() with spawn mocked (never a real
// provider); the tree is REAL via ORCHESTRA_TREE_DIR.
const mocks = vi.hoisted(() => ({
  codex: vi.fn(), glm: vi.fn(), claude: vi.fn(), counter: vi.fn(), appendFile: vi.fn(), spawn: vi.fn(),
}));
vi.mock('../dispatcher/usage.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  }));
// Spread, not bare: this file also uses execFileSync (TZ child run) from node:child_process.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  spawn: mocks.spawn,
}));
// Slice D: dispatch reads every counter through usage-readers/index.mjs; the stub routes by provider.
vi.mock('../dispatcher/usage-readers/index.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readProviderUsage: (provider: string) => {
    const reader = ({ codex: mocks.codex, glm: mocks.glm, claude: mocks.claude } as Record<string, (() => unknown) | undefined>)[provider];
    return reader ? reader() : mocks.counter(provider);
  },
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  appendFileSync: vi.fn(), mkdirSync: vi.fn(),
}));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  mkdir: vi.fn(), appendFile: mocks.appendFile,
}));
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { main, decideProviderStop, parseProviderReset } from '../dispatcher/dispatch.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { stopProviderForNode, latestProviderStop } from '../dispatcher/tree-read.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { normalize, stderrCliErrors } from '../dispatcher/events.mjs';

// Measured 2026-10-11T23:00:27Z, cline exit 1 (r2-tabularium): the message as it arrived inside
// the stderr JSON line, real newlines and all.
const CLINE_LIMIT_MESSAGE =
  'ClinePass limit reached\nYou have reached your 5-hour Clinepass limit. The limit resets in 1h 6m, please try again later.\nSwitch to Cline usage-based billing and retry with the Cline provider.';
const clineErrLine = (message: string) =>
  JSON.stringify({ ts: '2026-10-11T23:00:27.169Z', type: 'error', message });
const CLINE_HOOK_LINE = clineErrLine('hook dispatch failed: session.hook requires a valid hook event payload');

// Measured 2026-10-11T23:51:20Z, opencode exit 1 (r5-viewer): the stdout JSON error event.
const OPENCODE_LIMIT_MESSAGE = 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-12 09:23:37';
const opencodeErrLine = (message: string) =>
  JSON.stringify({ type: 'error', timestamp: 1791762679000, sessionID: 'ses_test',
    error: { name: 'APIError', data: { message, statusCode: 429, isRetryable: true } } });

// Q14m: 2026-10-17 S7 failure, verbatim from the spec (including its request_id marker).
const MUSE_LIMIT_MESSAGE = 'API error 429 [request_id=…]: Subscription quota exhausted. Your usage window resets at 2026-10-17T22:16:44Z. (rate_limit_error)';
const museErrLine = (reason: string) =>
  JSON.stringify({ payload_type: 'run.terminal.failed', payload: { reason } });

// Q14z: 2026-10-17 22:17 local (+03) GLM stop message, verbatim from the spec (Asia/Shanghai UTC+8).
const GLM_Q14Z_LIMIT_MESSAGE = 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-18 06:16:53';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe('PS1 provider-declared window stops', () => {
  let treeDir: string;
  let exitCode: typeof process.exitCode;
  const plansDirs: string[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    treeDir = mkdtempSync(path.join(tmpdir(), 'orchestra-ps1-'));
    vi.stubEnv('ORCHESTRA_TREE_DIR', treeDir);
    // Hermetic plans: a temp copy of the shipped example, so ~/.config/agent-rules is never read.
    const plansDir = mkdtempSync(path.join(tmpdir(), 'orchestra-ps1-plans-'));
    plansDirs.push(plansDir);
    const plansFile = path.join(plansDir, 'plans.json');
    writeFileSync(plansFile, readFileSync(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url), 'utf8'));
    vi.stubEnv('ORCHESTRA_PLANS', plansFile);
    vi.stubEnv('ORCHESTRA_LIVE_DIR', path.join(treeDir, 'live'));
    // The suites run on the full roster; an unconfigured install would load the two-route starter.
    vi.stubEnv('ORCHESTRA_POLICY', fileURLToPath(new URL('../dispatcher/policy.full-roster.json', import.meta.url)));
    rankingWith([]); // hermetic: no route ranked unless the test says so
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.codex.mockResolvedValue({ status: 'unknown', reason: 'no reading', windows: [] });
    mocks.glm.mockResolvedValue({ status: 'unknown', reason: 'no verified source', windows: [] });
    mocks.counter.mockResolvedValue({ status: 'unavailable', reason: 'reader:unavailable' });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        child.stdout.emit('data', 'work delivered');
        child.emit('close', 0, null);
      });
      return child;
    });
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(treeDir, { recursive: true, force: true });
    for (const d of plansDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const rankingWith = (entries: unknown[]) => {
    const file = path.join(treeDir, 'ranking.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, source: 'test', observedAt: '2026-10-11', entries }));
    vi.stubEnv('ORCHESTRA_RANKING_FILE', file);
  };
  const entry = (cli: string, modelArg: string, effortArg: string | null, aa: number) =>
    ({ model: modelArg, effort: effortArg, aa, access: [{ cli, modelArg, effortArg }] });
  const seedTree = (...nodes: Record<string, unknown>[]) =>
    writeFileSync(path.join(treeDir, 'hist.jsonl'), `${nodes.map(n => JSON.stringify(n)).join('\n')}\n`);
  // parseArgs pairs flags, so --list-routes --json needs a value after each (a bare
  // `--list-routes --json` swallows --json as the value and prints text).
  const listJson = () => main(['--list-routes', 'x', '--json', 'x']) as Promise<Array<Record<string, unknown>>>;
  const stdoutText = () => vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('');
  const stderrText = () => vi.mocked(process.stderr.write).mock.calls.map(c => String(c[0])).join('');
  const node = () => JSON.parse(mocks.appendFile.mock.calls[0][1]);
  const failWith = (stdoutLines: string[], stderrLines: string[], code: number) =>
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        for (const l of stdoutLines) child.stdout.emit('data', `${l}\n`);
        for (const l of stderrLines) child.stderr.emit('data', `${l}\n`);
        child.emit('close', code, null);
      });
      return child;
    });
  const stopNode = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, role: 'cline-qwen', cli: 'cline', model: 'cline-pass/qwen3.8-max',
    exitCode: 1, recordedAt: '2026-10-11T23:00:27.355Z',
    providerStop: { provider: 'cline', resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      evidence: 'ClinePass limit reached' },
    ...over,
  });
  const runNode = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, role: 'cline-qwen', cli: 'cline', model: 'cline-pass/qwen3.8-max',
    exitCode: 0, recordedAt: '2026-10-12T00:10:00.000Z',
    ...over,
  });

  it('cline stderr error event on a failed run records a stop at runEnd + 1h06m', async () => {
    const T_START = Date.parse('2026-10-11T23:00:27.169Z');
    const T_END = T_START + 120_000;
    let now = T_START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        for (const l of [CLINE_HOOK_LINE, clineErrLine(CLINE_LIMIT_MESSAGE)]) child.stderr.emit('data', `${l}\n`);
        now = T_END; // the clock advances between spawn start and close: runEnd, not runStart
        child.emit('close', 1, null);
      });
      return child;
    });
    await main(['--role', 'cline-qwen', '--task', 'ps1-cline', '--prompt', 'stable']);
    expect(node().providerStop).toEqual({
      provider: 'cline',
      resetsAt: new Date(T_END + 66 * 60_000).toISOString(),
      evidence: expect.any(String),
    });
    const evidence: string = node().providerStop.evidence;
    expect([...evidence]).toHaveLength(200); // the whole JSON line, capped (code points)
    expect(evidence).toMatch(/^\{"ts":/); // whole error object, like opencode's cliErrors
    expect(evidence).toContain('ClinePass limit reached');
    expect(evidence).not.toMatch(CONTROL);
    // The stop is independent of the blocked flag, whose rules PS1 does not touch.
    expect(node()).toMatchObject({ blocked: false, blockedCheck: 'no usage-limit text in the transcript' });
  });

  it('opencode stdout error event on a failed run records a zai stop in UTC+8 (Beijing time)', async () => {
    failWith([opencodeErrLine(OPENCODE_LIMIT_MESSAGE)], [], 1);
    await main(['--role', 'implement', '--task', 'ps1-zai', '--prompt', 'stable']);
    expect(node().providerStop).toEqual({
      provider: 'zai',
      resetsAt: '2026-10-12T01:23:37.000Z', // 2026-10-12 09:23:37 at UTC+08:00
      evidence: expect.any(String),
    });
    expect(node().providerStop.evidence).toContain('Usage limit reached');
    expect(node()).toMatchObject({ blocked: true }); // ocli has no blockedBasis (Senatus R0 #4 not ported)
  });

  it('Q14z: captured GLM line verbatim on a zai route records resetsAt 2026-10-17T22:16:53.000Z in any TZ', async () => {
    failWith([opencodeErrLine(GLM_Q14Z_LIMIT_MESSAGE)], [], 1);
    await main(['--role', 'implement', '--task', 'q14z-glm', '--prompt', 'stable']);
    expect(node().providerStop).toEqual({
      provider: 'zai',
      resetsAt: '2026-10-17T22:16:53.000Z',
      evidence: expect.any(String),
    });
    expect(node().providerStop.evidence).toContain(GLM_Q14Z_LIMIT_MESSAGE);
    const { execFileSync } = await import('node:child_process');
    const href = new URL('../dispatcher/dispatch.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(href)}).then(m => {`
      + `const stop = m.decideProviderStop({ result: { code: 1 }, cliErrorText: ${JSON.stringify(GLM_Q14Z_LIMIT_MESSAGE)}, cli: 'opencode', model: 'zai-coding-plan/glm-5.3', runEndMs: 0 });`
      + `console.log(stop?.resetsAt ?? 'null');`
      + `});`;
    for (const tz of ['Europe/Istanbul', 'UTC', 'America/New_York']) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
        { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
      expect(out, `TZ=${tz}`).toBe('2026-10-17T22:16:53.000Z');
    }
  });

  it('Q14z: the same local-wall wording on a non-zai route keeps the machine local-wall reading', async () => {
    const expectedLocal = new Date(2026, 9, 18, 6, 16, 53).toISOString();
    failWith([], [clineErrLine(GLM_Q14Z_LIMIT_MESSAGE)], 1);
    await main(['--role', 'cline-qwen', '--task', 'q14z-cline', '--prompt', 'stable']);
    expect(node().providerStop).toEqual({
      provider: 'cline',
      resetsAt: expectedLocal,
      evidence: expect.any(String),
    });
    expect(decideProviderStop({
      result: { code: 1 }, cliErrorText: GLM_Q14Z_LIMIT_MESSAGE,
      cli: 'muse', model: 'muse-wonder-1.0', runEndMs: 0,
    })).toMatchObject({ provider: 'meta', resetsAt: expectedLocal });
    expect(decideProviderStop({
      result: { code: 1 }, cliErrorText: GLM_Q14Z_LIMIT_MESSAGE,
      cli: 'agy', model: 'gemini-4-argon-high', runEndMs: 0,
    })).toMatchObject({ provider: 'google', resetsAt: expectedLocal });
  });

  it('Q14z: zai/glm zone is fixed UTC+08:00 (DST-free across winter and summer) while ISO-UTC and relative forms stay unchanged', async () => {
    for (const provider of ['zai', 'glm']) {
      expect(parseProviderReset('will reset at 2026-01-15 06:16:53', 0, undefined, provider)).toBe('2026-01-14T22:16:53.000Z');
      expect(parseProviderReset('will reset at 2026-07-15 06:16:53', 0, undefined, provider)).toBe('2026-07-14T22:16:53.000Z');
      expect(parseProviderReset(GLM_Q14Z_LIMIT_MESSAGE, 0, undefined, provider)).toBe('2026-10-17T22:16:53.000Z');
      expect(parseProviderReset('resets at 2026-10-17T22:16:44Z', 0, undefined, provider)).toBe('2026-10-17T22:16:44.000Z');
      expect(parseProviderReset('resets in 1h 6m', Date.parse('2026-10-11T23:00:00.000Z'), undefined, provider))
        .toBe('2026-10-12T00:06:00.000Z');
    }
    const { execFileSync } = await import('node:child_process');
    const href = new URL('../dispatcher/dispatch.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(href)}).then(m => {`
      + `console.log([`
      + `m.parseProviderReset('will reset at 2026-01-15 06:16:53', 0, undefined, 'zai'),`
      + `m.parseProviderReset('will reset at 2026-07-15 06:16:53', 0, undefined, 'zai')`
      + `].join(','));`
      + `});`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }).trim();
    expect(out).toBe('2026-01-14T22:16:53.000Z,2026-07-14T22:16:53.000Z');
  });

  it('a transient rate limit / 429 never creates a stop (blocked only)', async () => {
    failWith([opencodeErrLine('Rate limit exceeded (429). Retry after 30 seconds.')], [], 1);
    await main(['--role', 'implement', '--task', 'ps1-429', '--prompt', 'stable']);
    expect(node()).toMatchObject({ blocked: true, providerStop: null });
    expect(decideProviderStop({ result: { code: 1 },
      cliErrorText: 'Rate limit exceeded (429). Retry after 30 seconds.',
      cli: 'cline', model: 'cline-pass/qwen3.8-max', runEndMs: 0 })).toBeNull();
  });

  it('Muse terminal quota exhaustion records a meta stop at the ISO UTC reset', async () => {
    failWith([museErrLine(MUSE_LIMIT_MESSAGE)], [], 1);
    await main(['--role', 'muse', '--task', 'q14m-muse', '--prompt', 'stable']);
    expect(node().providerStop).toEqual({
      provider: 'meta', resetsAt: '2026-10-17T22:16:44.000Z',
      evidence: `run.terminal.failed: ${MUSE_LIMIT_MESSAGE}`,
    });
  });

  it('Muse model output quoting the quota error does not create a stop', async () => {
    failWith([JSON.stringify({ payload_type: 'run.output.delta', payload: { text: MUSE_LIMIT_MESSAGE } })], [], 1);
    await main(['--role', 'muse', '--task', 'q14m-quoted', '--prompt', 'stable']);
    expect(node().providerStop).toBeNull();
  });

  it.each(['rate limit', 'request rejected'])('Muse 429 with %s but no quota wording does not create a stop', async wording => {
    failWith([museErrLine(MUSE_LIMIT_MESSAGE.replace('Subscription quota exhausted', wording))], [], 1);
    await main(['--role', 'muse', '--task', 'q14m-transient', '--prompt', 'stable']);
    expect(node().providerStop).toBeNull();
    if (wording === 'rate limit') expect(node()).toMatchObject({ blocked: true, blockedBasis: 'cli-error-event' });
  });

  it('Muse quota error on an exit-zero run does not create a stop', async () => {
    failWith([museErrLine(MUSE_LIMIT_MESSAGE)], [], 0);
    await main(['--role', 'muse', '--task', 'q14m-success', '--prompt', 'stable']);
    expect(node()).toMatchObject({ exitCode: 0, providerStop: null });
  });

  it('the absolute reset is interpreted in the machine local zone (Kiritimati child run)', async () => {
    const { execFileSync } = await import('node:child_process');
    const href = new URL('../dispatcher/dispatch.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(href)}).then(m => console.log(m.parseProviderReset('will reset at 2026-10-12 09:23:37', 0)));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, TZ: 'Pacific/Kiritimati' }, encoding: 'utf8' }).trim();
    expect(out).toBe('2026-10-11T19:23:37.000Z'); // 09:23:37 at +14, no DST ever
  });

  it('the absolute reset uses the target-date offset, not the current one (New York DST child run)', async () => {
    const { execFileSync } = await import('node:child_process');
    const href = new URL('../dispatcher/dispatch.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(href)}).then(m => console.log(m.parseProviderReset('will reset at 2026-12-01 09:00:00', 0)));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }).trim();
    expect(out).toBe('2026-12-01T14:00:00.000Z'); // 09:00 EST (UTC-5); October EDT (UTC-4) would say 13:00Z
  });

  it('no stop when limit wording is only model text, pretty stderr, or the run exits 0', async () => {
    // Model text quoting the words on stdout (not an error event), failed run.
    failWith(['Note: "Usage limit reached for 5 hour" is quoted from the docs.'], [], 1);
    await main(['--role', 'implement', '--task', 'ps1-text', '--prompt', 'stable']);
    expect(node().providerStop).toBeNull();
    mocks.appendFile.mockClear();
    // September-style pretty stderr is the CLI's own words but not an EVENT: model text also
    // renders there, so it cannot carry a verdict. blocked still fires; the stop does not.
    failWith([], ['\u001b[91mError: \u001b[0mUsage limit reached for 5 hour. Your limit will reset at 2026-10-12 09:23:37'], 1);
    await main(['--role', 'implement', '--task', 'ps1-text', '--prompt', 'stable']);
    expect(node()).toMatchObject({ blocked: true, providerStop: null });
    mocks.appendFile.mockClear();
    // A real error event on a SUCCESSFUL run: refused, but not a stop (P1: failed runs only).
    failWith([opencodeErrLine(OPENCODE_LIMIT_MESSAGE)], [], 0);
    await main(['--role', 'implement', '--task', 'ps1-text', '--prompt', 'stable']);
    expect(node()).toMatchObject({ blocked: true, providerStop: null });
    mocks.appendFile.mockClear();
    failWith([], [clineErrLine(CLINE_LIMIT_MESSAGE)], 0);
    await main(['--role', 'cline-qwen', '--task', 'ps1-text', '--prompt', 'stable']);
    expect(node().providerStop).toBeNull();
  });

  it('decideProviderStop needs a numeric nonzero exit and a stop provider', () => {
    const base = { cliErrorText: clineErrLine(CLINE_LIMIT_MESSAGE), cli: 'cline', model: 'cline-pass/qwen3.8-max', runEndMs: 0 };
    expect(decideProviderStop({ ...base, result: { code: null, spawnError: true } })).toBeNull(); // never started
    expect(decideProviderStop({ ...base, result: { code: null, signal: 'SIGTERM' } })).toBeNull(); // killed, not refused
    expect(decideProviderStop({ ...base, result: { code: 0 } })).toBeNull();
    expect(decideProviderStop({ ...base, result: { code: 1 }, cli: 'codex', model: 'gpt-6-astra' })).toBeNull(); // no stop provider
    expect(decideProviderStop({ ...base, result: { code: 1 }, cliErrorText: 'plain model text' })).toBeNull();
  });

  it('evidence strips C0/C1 and bidi/isolate controls', () => {
    const raw = 'usage limit\u001b[31m\u0007\u202e reached';
    const stop = decideProviderStop({ result: { code: 1 }, cliErrorText: raw,
      cli: 'cline', model: 'cline-pass/qwen3.8-max', runEndMs: 0 });
    expect(stop).not.toBeNull();
    expect(stop!.evidence).toBe('usage limit[31m reached');
    expect(stop!.evidence).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  });

  it('an unparseable reset is an unknown stop: resetsAt null, still excluded', async () => {
    failWith([], [clineErrLine('ClinePass limit reached. Try again later.')], 1);
    await main(['--role', 'cline-qwen', '--task', 'ps1-unknown', '--prompt', 'stable']);
    expect(node().providerStop).toEqual({ provider: 'cline', resetsAt: null, evidence: expect.any(String) });
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt: null, evidence: 'ClinePass limit reached' } }));
    const routes = await listJson();
    const mimo = routes.find(r => r.role === 'cline-mimo')!;
    expect(mimo).toMatchObject({ gate: 'stop', gateSource: 'provider-declared', excludedBy: 'budget-stop', resetsAt: null });
    await main(['--list-routes']);
    expect(stdoutText()).toContain('cline-mimo');
    expect(stdoutText()).toMatch(/cline-mimo\s+cline\s+.*excluded:budget-stop \(reset unknown\)/);
  });

  it('a corrupt resetsAt fails closed: "garbage" stays excluded', async () => {
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt: 'garbage', evidence: 'x' } }));
    const routes = await listJson();
    expect(routes.find(r => r.role === 'cline-mimo')).toMatchObject(
      { gate: 'stop', gateSource: 'provider-declared', excludedBy: 'budget-stop', eligible: false });
  });

  it('a stopped route whose status is not ok reports excludedBy status', async () => {
    const fs = await import('node:fs/promises');
    const realRead = fs.readFile.bind(fs);
    const policy = JSON.parse(String(await realRead(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8')));
    policy.routes['cline-mimo'].status = 'dead';
    vi.spyOn(fs, 'readFile').mockImplementation((async (file: any, ...rest: any[]) =>
      /policy(\.example|\.full-roster)?\.json$/.test(String(file)) ? JSON.stringify(policy) : realRead(file, ...rest)) as any);
    const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt, evidence: 'x' } }));
    const routes = await listJson();
    expect(routes.find(r => r.role === 'cline-mimo')).toMatchObject(
      { gate: 'stop', gateSource: 'provider-declared', excludedBy: 'status', eligible: false });
  });

  it('a future cline stop excludes every cline route in --list-routes --json, and nothing else', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt, evidence: 'ClinePass limit reached' } }));
    const routes = await listJson();
    const cline = routes.filter(r => String(r.role).startsWith('cline-'));
    expect(cline).toHaveLength(Object.values(JSON.parse(String(await (await import('node:fs/promises')).readFile(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8'))).routes).filter((r: any) => r.cli === 'cline').length); // one billing pool, every cline route in the shipped policy
    for (const r of cline) {
      expect(r).toMatchObject({ gate: 'stop', gateSource: 'provider-declared', excludedBy: 'budget-stop', resetsAt, eligible: false });
    }
    const byRole = Object.fromEntries(routes.map(r => [r.role, r]));
    // Q17: glm/muse are until-stop CodexBar counters; with no reading they run, untouched by cline's stop.
    expect(byRole.implement).toMatchObject({ gate: 'ok', gateSource: 'until-stop', eligible: true });
    expect(byRole.muse).toMatchObject({ gate: 'ok', gateSource: 'until-stop', eligible: true });
    expect(byRole.reason).toMatchObject({ excludedBy: 'budget-unknown' }); // refuse cap, no reading: as before
  });

  it('--list-routes text names the reset as until HH:MMZ', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt, evidence: 'ClinePass limit reached' } }));
    await main(['--list-routes']);
    expect(stdoutText()).toContain(`excluded:budget-stop until ${resetsAt.slice(11, 16)}Z`);
  });

  it('a zai stop excludes implement while cline stays eligible', async () => {
    seedTree(stopNode({ role: 'implement', cli: 'opencode', model: 'zai-coding-plan/glm-5.3',
      providerStop: { provider: 'zai', resetsAt: new Date(Date.now() + 3600_000).toISOString(), evidence: 'Usage limit reached' } }));
    const routes = await listJson();
    const byRole = Object.fromEntries(routes.map(r => [r.role, r]));
    expect(byRole.implement).toMatchObject({ gate: 'stop', gateSource: 'provider-declared', excludedBy: 'budget-stop' });
    expect(byRole['cline-mimo']).toMatchObject({ gate: 'ok', eligible: true });
  });

  it('after resetsAt the provider is eligible again; the boundary is strict (== now is eligible)', async () => {
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt: '2020-01-01T00:00:00.000Z', evidence: 'old' } }));
    const routes = await listJson();
    // Q17: cline is an until-stop counter now (was no-budget); an expired stop leaves it running.
    expect(routes.find(r => r.role === 'cline-mimo')).toMatchObject({ gate: 'ok', gateSource: 'until-stop', eligible: true });
    expect(routes.find(r => r.role === 'cline-mimo')).not.toHaveProperty('resetsAt');
    const T = Date.parse('2026-10-11T23:00:27.355Z');
    vi.spyOn(Date, 'now').mockReturnValue(T);
    for (const [at, eligible] of [[T - 1000, true], [T, true], [T + 1, false]] as const) {
      seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt: new Date(at).toISOString(), evidence: 'x' } }));
      const found = (await listJson()).find(r => r.role === 'cline-mimo')!;
      expect(found.eligible).toBe(eligible);
      expect(found.gateSource).toBe(eligible ? 'until-stop' : 'provider-declared');
    }
  });

  it('a later successful run clears the stop; anything else leaves it', async () => {
    const T1 = '2026-10-11T23:00:27.355Z';
    const T2 = '2026-10-12T00:10:00.000Z';
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const cases: Array<[string, Record<string, unknown>[], boolean]> = [
      ['unknown stop + later success clears', [stopNode({ recordedAt: T1, providerStop: { provider: 'cline', resetsAt: null, evidence: 'x' } }), runNode({ recordedAt: T2 })], true],
      ['dated stop + later success clears', [stopNode({ recordedAt: T1, providerStop: { provider: 'cline', resetsAt: future, evidence: 'x' } }), runNode({ recordedAt: T2 })], true],
      ['success BEFORE the stop does not clear', [runNode({ recordedAt: T1 }), stopNode({ recordedAt: T2, providerStop: { provider: 'cline', resetsAt: future, evidence: 'x' } })], false],
      ['a later FAILED run without a stop does not clear', [stopNode({ recordedAt: T1, providerStop: { provider: 'cline', resetsAt: future, evidence: 'x' } }), runNode({ recordedAt: T2, exitCode: 1 })], false],
      ['equal recordedAt: later line wins (stop last -> stopped)', [runNode({ recordedAt: T1 }), stopNode({ recordedAt: T1, providerStop: { provider: 'cline', resetsAt: future, evidence: 'x' } })], false],
      ['equal recordedAt: later line wins (success last -> cleared)', [stopNode({ recordedAt: T1, providerStop: { provider: 'cline', resetsAt: future, evidence: 'x' } }), runNode({ recordedAt: T1 })], true],
      ['an exit-0 node refused by the CLI error event does NOT clear', [stopNode({ recordedAt: T1, providerStop: { provider: 'cline', resetsAt: future, evidence: 'x' } }), runNode({ recordedAt: T2, blocked: true, blockedBasis: 'cli-error-event' })], false],
    ];
    for (const [name, nodes, eligible] of cases) {
      seedTree(...nodes);
      const found = (await listJson()).find(r => r.role === 'cline-mimo')!;
      expect(found.eligible, name).toBe(eligible);
    }
  });

  it('--role auto skips a stopped provider for the next ranked eligible route', async () => {
    // The muse route's model comes from the shipped policy, never a literal (a switch must not unrank it).
    const museModel: string = JSON.parse(readFileSync(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8')).routes.muse.model;
    rankingWith([entry('cline', 'cline-pass/mimo-v2.6-pro', null, 46), entry('muse', museModel, 'max', 44)]);
    await main(['--role', 'auto', '--task', 'ps1-auto', '--prompt', 'stable']);
    expect(JSON.parse(mocks.appendFile.mock.calls[0][1]).candidates.chosen).toBe('cline-mimo'); // control: no stop
    mocks.appendFile.mockClear();
    mocks.spawn.mockClear();
    seedTree(stopNode());
    await main(['--role', 'auto', '--task', 'ps1-auto', '--prompt', 'stable']);
    expect(JSON.parse(mocks.appendFile.mock.calls[0][1]).candidates.chosen).toBe('muse');
    expect(mocks.spawn.mock.calls[0][0]).toBe('muse');
  });

  it('an explicit --role to a stopped route warns once, names the reset, and still runs', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt, evidence: 'ClinePass limit reached' } }));
    await main(['--role', 'cline-mimo', '--task', 'ps1-explicit', '--prompt', 'stable']);
    expect(mocks.spawn.mock.calls[0][0]).toBe('cline'); // the lead may knowingly retry
    const warnings = stderrText().split('\n').filter(l => l.includes('warning:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cline');
    expect(warnings[0]).toContain(resetsAt);
    // The run itself succeeded, so it carries no stop; its candidates show the route as stopped.
    expect(node()).toMatchObject({ exitCode: 0, providerStop: null });
    const chosen = node().candidates.routes.find((r: { role: string }) => r.role === 'cline-mimo');
    expect(chosen).toMatchObject({ gate: 'stop', gateSource: 'provider-declared', excludedBy: 'budget-stop' });
    mocks.appendFile.mockClear();
    vi.mocked(process.stderr.write).mockClear();
    seedTree(stopNode({ providerStop: { provider: 'cline', resetsAt: null, evidence: 'x' } }));
    await main(['--role', 'cline-mimo', '--task', 'ps1-explicit', '--prompt', 'stable']);
    expect(stderrText().split('\n').filter(l => l.includes('warning:'))).toHaveLength(1);
    expect(stderrText()).toContain('reset time unknown');
  });
});

describe('PS1 helpers', () => {
  it.each([
    ['resets at 2026-10-17T22:16:44Z', '2026-10-17T22:16:44.000Z'],
    ['reset at 2026-10-17T22:16:44Z', '2026-10-17T22:16:44.000Z'],
    ['resets at 2026-10-17T22:16:44.123Z', '2026-10-17T22:16:44.123Z'],
    ['reset at 2026-10-17T22:16:44.007Z', '2026-10-17T22:16:44.007Z'],
  ])('parseProviderReset: ISO UTC %s never uses the local-zone converter', (text, expected) => {
    const localToIso = vi.fn(() => 'LOCAL-WALL');
    expect(parseProviderReset(text, Number.NaN, localToIso)).toBe(expected);
    expect(localToIso).not.toHaveBeenCalled();
  });

  it.each([
    'will reset at 2026-10-18 09:00:00',
    'resets in 1 hour 30 minutes',
    'retry after 30 seconds',
  ])('parseProviderReset: ISO UTC takes precedence over %s', other => {
    const localToIso = vi.fn(() => 'LOCAL-WALL');
    const text = `${other}; Your usage window resets at 2026-10-17T22:16:44Z.`;
    expect(parseProviderReset(text, Date.parse('2026-10-17T18:30:00Z'), localToIso))
      .toBe('2026-10-17T22:16:44.000Z');
    expect(localToIso).not.toHaveBeenCalled();
  });

  it('parseProviderReset: invalid ISO UTC dates stay unknown or fall back to an existing reset form', () => {
    for (const iso of ['2026-02-31T09:00:00Z', '2026-13-17T22:16:44Z', '2026-10-17T24:00:00Z']) {
      expect(parseProviderReset(`resets at ${iso}`, 0)).toBeNull();
      expect(parseProviderReset(`resets at ${iso}; resets in 1h`, 0)).toBe('1970-01-01T01:00:00.000Z');
    }
    expect(parseProviderReset('resets at 2026-02-31T09:00:00Z; will reset at 2026-10-18 09:00:00', 0, () => 'LOCAL-WALL'))
      .toBe('LOCAL-WALL');
  });

  it('parseProviderReset: relative ClinePass durations add to runEnd', () => {
    const T = Date.parse('2026-10-11T23:00:27.169Z');
    expect(parseProviderReset('The limit resets in 1h 6m, please try again later.', T))
      .toBe(new Date(T + (66 * 60_000)).toISOString());
    expect(parseProviderReset('resets in 45m', T)).toBe(new Date(T + 45 * 60_000).toISOString());
    expect(parseProviderReset('limit reset in 2h', T)).toBe(new Date(T + 2 * 3600_000).toISOString());
    expect(parseProviderReset('resets in 1 hour 30 minutes', T)).toBe(new Date(T + 90 * 60_000).toISOString());
    expect(parseProviderReset('Usage limit reached. Retry after 30 seconds.', T)).toBe(new Date(T + 30_000).toISOString());
    expect(parseProviderReset('ClinePass limit reached. Try again later.', T)).toBeNull();
    expect(parseProviderReset('', T)).toBeNull();
  });

  it('parseProviderReset: absolute resets pass wall fields to the zone function; invalid stays null', () => {
    const seen: unknown[][] = [];
    const out = parseProviderReset(`x ${OPENCODE_LIMIT_MESSAGE}`, 0, (...a: unknown[]) => {
      seen.push(a);
      return 'INJECTED';
    });
    expect(out).toBe('INJECTED');
    expect(seen).toEqual([[2026, 10, 12, 9, 23, 37]]); // month as written (1-based)
    expect(parseProviderReset('will reset at 2026-13-40 25:61:61', 0)).toBeNull();
    expect(parseProviderReset('will reset at 2026-02-31 09:00:00', 0)).toBeNull(); // no rollover to Mar 3
    // Both present: the exact absolute instant wins over the relative duration.
    expect(parseProviderReset('resets in 5h 0m; will reset at 2026-10-12 09:23:37', 0, () => 'ABS'))
      .toBe('ABS');
  });

  it('stopProviderForNode keys by billing pool, never by role', () => {
    expect(stopProviderForNode({ role: 'cline-qwen', cli: 'cline', model: 'cline-pass/qwen3.8-max' })).toBe('cline');
    expect(stopProviderForNode({ role: 'cline-muse', cli: 'cline', model: 'cline-pass/muse-spark-1.3-contributor' })).toBe('cline');
    expect(stopProviderForNode({ role: 'implement', cli: 'opencode', model: 'zai-coding-plan/glm-5.3' })).toBe('zai');
    expect(stopProviderForNode({ role: 'implement', cli: 'opencode', model: 'anthropic/claude-sonnet' })).toBeNull();
    expect(stopProviderForNode({ role: 'reason', cli: 'codex', model: 'gpt-6-astra' })).toBeNull();
    // Q12: gemini and muse stops reach their plans pools (google, meta); codex stays counter-backed.
    expect(stopProviderForNode({ role: 'breadth', cli: 'agy', model: 'gemini-3.8-flash-high' })).toBe('google');
    expect(stopProviderForNode({ role: 'muse', cli: 'muse', model: 'muse-wonder-1.0' })).toBe('meta');
    expect(stopProviderForNode({ role: 'lead-correction', cli: 'cline' })).toBeNull();
    expect(stopProviderForNode({})).toBeNull();
  });

  it('latestProviderStop returns the newest uncleared stop and skips junk', () => {
    const stop = (at: string) => ({ role: 'r', cli: 'cline', model: 'm', exitCode: 1, recordedAt: at,
      providerStop: { provider: 'cline', resetsAt: null, evidence: at } });
    expect(latestProviderStop([], 'cline')).toBeNull();
    expect(latestProviderStop([null, 'x', 42, { cli: 'cline' }], 'cline')).toBeNull();
    const found = latestProviderStop(
      [stop('2026-10-11T22:00:00.000Z'), stop('2026-10-11T23:00:00.000Z')], 'cline');
    expect(found).toEqual({ providerStop: { provider: 'cline', resetsAt: null, evidence: '2026-10-11T23:00:00.000Z' },
      recordedAt: '2026-10-11T23:00:00.000Z' });
    expect(latestProviderStop([stop('2026-10-11T23:00:00.000Z')], 'zai')).toBeNull(); // other pool
    const tie = latestProviderStop(
      [{ ...stop('2026-10-11T23:00:00.000Z'), providerStop: { provider: 'cline', resetsAt: null, evidence: 'first' } },
        { ...stop('2026-10-11T23:00:00.000Z'), providerStop: { provider: 'cline', resetsAt: null, evidence: 'second' } }], 'cline');
    expect(tie?.providerStop).toMatchObject({ evidence: 'second' }); // later line wins
  });

  it('stderrCliErrors collects stderr JSON error events and nothing else', () => {
    const [hook, limit] = stderrCliErrors('cline', `${CLINE_HOOK_LINE}\n${clineErrLine(CLINE_LIMIT_MESSAGE)}\nplain line`);
    expect(hook).toContain('hook dispatch failed');
    expect(limit).toContain('ClinePass limit reached');
    expect(stderrCliErrors('cline', 'Error: Usage limit reached\nnot json\n{broken')).toEqual([]);
    expect(stderrCliErrors('opencode', 'Error: Usage limit reached for 5 hour')).toEqual([]);
    expect(stderrCliErrors('cline', '')).toEqual([]);
  });

  it('a cline top-level error line normalizes to a warn and the CLI own words', () => {
    const state: Record<string, unknown> = {};
    const [warn] = normalize('cline', clineErrLine(CLINE_LIMIT_MESSAGE), state) as Array<Record<string, unknown>>;
    expect(warn).toMatchObject({ kind: 'warn' });
    expect(String(warn.text)).toContain('ClinePass limit reached');
    expect(state.cliErrors).toHaveLength(1);
  });
});
