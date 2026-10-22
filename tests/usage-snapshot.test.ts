import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Quota cards part A: <live root>/usage/latest.json. Readers and spawn are mocked; the live and tree dirs are
// temp dirs (ORCHESTRA_LIVE_DIR / ORCHESTRA_TREE_DIR), never a real orchestra/. node:fs is NOT mocked here.
const mocks = vi.hoisted(() => ({ codex: vi.fn(), glm: vi.fn(), counter: vi.fn(), spawn: vi.fn() }));
vi.mock('../dispatcher/usage-readers/index.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  readProviderUsage: (provider: string) => {
    const reader = ({ codex: mocks.codex, glm: mocks.glm } as Record<string, (() => unknown) | undefined>)[provider];
    return reader ? reader() : mocks.counter(provider);
  },
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  spawn: mocks.spawn,
}));
// @ts-expect-error - dispatcher tooling is plain ESM
import { writeUsageSnapshot, snapshotFile, policyRoutes } from '../dispatcher/usage-snapshot.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM
import { runUsageCli } from '../dispatcher/usage.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM
import { main } from '../dispatcher/dispatch.mjs';

const POLICY = fileURLToPath(new URL('../dispatcher/policy.full-roster.json', import.meta.url));
const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
const FUTURE = '2099-01-01T00:00:00.000Z';
const win = (limitId: string, usedPercent: number, windowDurationMins: number, resetsAt: string | null = FUTURE) =>
  ({ limitId, usedPercent, windowDurationMins, resetsAt });
const ok = (...windows: unknown[]) => ({ status: 'ok', source: 'native:test', windows });
const geminiReading = (argon: number) => ok(
  win('antigravity-quota-summary-gemini-5h', 10, 300),
  win('antigravity-quota-summary-gemini-weekly', 39, 10080),
  win('antigravity-quota-summary-gemini-argon-wtu-weekly', argon, 10080));

describe('usage snapshot writer (dispatcher/usage-snapshot.mjs)', () => {
  let live: string;
  let tree: string;
  beforeEach(() => {
    vi.clearAllMocks();
    live = mkdtempSync(path.join(tmpdir(), 'ocli-snap-live-'));
    tree = mkdtempSync(path.join(tmpdir(), 'ocli-snap-tree-'));
    vi.stubEnv('ORCHESTRA_LIVE_DIR', live);
    vi.stubEnv('ORCHESTRA_TREE_DIR', tree);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(live, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });
  const read = () => JSON.parse(readFileSync(snapshotFile(live), 'utf8'));
  const write = (readings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    writeUsageSnapshot({ dir: live, treeDir: tree, readings, routes: policyRoutes(policy), ...extra });

  it('writes schema v1 at <live>/usage/latest.json: windows, gate, scoped routes, null stop/setup', async () => {
    const res = await write({ codex: ok(win('codex', 20, 300), win('codex', 40, 10080)), gemini: geminiReading(99) },
      { now: Date.parse('2026-10-23T10:00:00Z') });
    expect(res.ok).toBe(true);
    const doc = read();
    expect(doc.v).toBe(1);
    expect(doc.writtenAt).toBe('2026-10-23T10:00:00.000Z');
    expect(Object.keys(doc.providers).sort()).toEqual(['codex', 'gemini']);
    const codex = doc.providers.codex;
    expect(codex).toEqual({
      readAt: '2026-10-23T10:00:00.000Z', status: 'ok', source: 'native:test', reason: null,
      windows: [
        { limitId: 'codex', usedPercent: 20, windowDurationMins: 300, resetsAt: FUTURE },
        { limitId: 'codex', usedPercent: 40, windowDurationMins: 10080, resetsAt: FUTURE },
      ],
      gate: { state: 'ok', reason: expect.stringContaining('codex at 40%'), headroomPercent: 55,
        window: { limitId: 'codex', windowDurationMins: 10080, usedPercent: 40, resetsAt: FUTURE } },
      stop: null, setup: null,
    });
    expect(codex).not.toHaveProperty('routes'); // codex has no scoped buckets
    const gemini = doc.providers.gemini;
    // Unscoped gate: argon's bucket at 99% binds the pool as a whole.
    expect(gemini.gate.state).toBe('stop');
    const byRole = Object.fromEntries(gemini.routes.map((r: { role: string }) => [r.role, r]));
    expect(byRole.breadth).toEqual({ role: 'breadth', model: 'gemini-4-argon-high', gate: { state: 'stop', reason: expect.any(String), window: expect.any(Object) } });
    expect(byRole['breadth-flash'].gate.state).toBe('ok');
    expect(gemini.routes.every((r: Record<string, unknown>) => Object.keys(r).sort().join() === 'gate,model,role')).toBe(true);
  });

  it('writes atomically: 0644, no temp file left beside it, and replaces an existing file whole', async () => {
    mkdirSync(path.join(live, 'usage'), { recursive: true });
    writeFileSync(snapshotFile(live), '{"v":1,"providers":{"glm":', 'utf8'); // torn/old file
    await write({ codex: ok(win('codex', 1, 300)) });
    expect(statSync(snapshotFile(live)).mode & 0o777).toBe(0o644);
    expect(readdirSync(path.join(live, 'usage'))).toEqual(['latest.json']);
    expect(Object.keys(read().providers)).toEqual(['codex']); // a torn file is not merged
  });

  it('merges: a codex-only write keeps the gemini entry with its own readAt', async () => {
    await write({ gemini: geminiReading(10) }, { now: Date.parse('2026-10-23T08:00:00Z') });
    await write({ codex: ok(win('codex', 5, 300)) }, { now: Date.parse('2026-10-23T09:00:00Z') });
    const doc = read();
    expect(doc.providers.gemini.readAt).toBe('2026-10-23T08:00:00.000Z');
    expect(doc.providers.gemini.windows).toHaveLength(3);
    expect(doc.providers.codex.readAt).toBe('2026-10-23T09:00:00.000Z');
    expect(doc.writtenAt).toBe('2026-10-23T09:00:00.000Z');
  });

  it('never writes identity, a secret or a home path, wherever the reading carries them', async () => {
    const TOKEN = 'sk-ant-oat01-AbCdEf0123456789GhIjKlMnOp';
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    const reading = {
      status: 'unavailable', source: 'plugin:zai', email: 'someone@example.com', accountId: 'acct_9f8e7d',
      organization: 'Example Org', accessToken: TOKEN,
      reason: `failed for someone@example.com at /home/someone/.config/ocli/usage-readers.json with ${TOKEN} / ${JWT}; also /home/someone/x/y`,
      windows: [{ limitId: 'zai-primary', usedPercent: 3, windowDurationMins: 300, resetsAt: null, email: 'someone@example.com', token: TOKEN }],
    };
    await write({ glm: reading, codex: { status: 'ok', windows: [], reason: `Bearer ${JWT}` } });
    const text = readFileSync(snapshotFile(live), 'utf8');
    for (const bad of ['someone@example.com', 'acct_9f8e7d', 'Example Org', TOKEN, JWT, '/Users/', '/home/', 'someone']) {
      expect(text).not.toContain(bad);
    }
    expect(read().providers.glm.windows).toEqual([{ limitId: 'zai-primary', usedPercent: 3, windowDurationMins: 300, resetsAt: null }]);
    expect(read().providers.glm.reason).toMatch(/^failed for /);
  });

  it('stop is the active provider stop from the tree; an expired one is null', async () => {
    writeFileSync(path.join(tree, 'hist.jsonl'), [
      { cli: 'agy', model: 'gemini-4-argon-high', exitCode: 1, recordedAt: '2026-10-23T07:00:00Z',
        providerStop: { provider: 'google', resetsAt: FUTURE, evidence: 'quota exhausted for someone@example.com' } },
      { cli: 'opencode', model: 'zai-coding-plan/glm-5.3', exitCode: 1, recordedAt: '2026-10-23T07:00:00Z',
        providerStop: { provider: 'zai', resetsAt: '2020-01-01T00:00:00.000Z', evidence: 'Usage limit reached' } },
    ].map(n => JSON.stringify(n)).join('\n'));
    await write({ gemini: geminiReading(10), glm: ok(win('zai-primary', 3, 300)) });
    const doc = read();
    expect(doc.providers.gemini.stop).toEqual({ until: FUTURE, reason: expect.stringContaining('quota exhausted') });
    expect(doc.providers.gemini.stop.reason).not.toContain('someone@example.com');
    expect(doc.providers.glm.stop).toBeNull();
  });

  it('setup names the missing setting of an unavailable plugin reader (no value)', async () => {
    await write({ muse: { status: 'unavailable', reason: 'plugin:secret-access', windows: [] } });
    const muse = read().providers.muse;
    expect(muse.status).toBe('unavailable');
    expect(typeof muse.setup).toBe('string');
    expect(muse.setup).toMatch(/keychain service/);
    expect(muse.setup).not.toMatch(/\n/);
  });

  it('a write failure returns ok:false and never throws', async () => {
    writeFileSync(path.join(live, 'usage'), 'not a dir');
    const res = await write({ codex: ok(win('codex', 1, 300)) });
    expect(res.ok).toBe(false);
  });

  // Review pins (u3 adversarial review): each kills a mutant the suite above let survive.
  it('pin: a prefix-less mixed-case token and an opaque Bearer value are scrubbed', async () => {
    const PLAIN = 'Qx7mZp2LkV9wRt4NbY6cHs8D'; // 24 chars, upper+lower+digit, no sk-/eyJ prefix
    const OPAQUE = 'abc123opaquevalue';
    await write({ glm: { status: 'unavailable', windows: [], reason: `key ${PLAIN}; header Bearer ${OPAQUE}` } });
    const body = readFileSync(snapshotFile(live), 'utf8');
    expect(body).not.toContain(PLAIN);
    expect(body).not.toContain(OPAQUE);
    expect(read().providers.glm.reason).toContain('Bearer [secret]');
  });

  it('pin: off-schema status and non-number window fields are coerced, never copied', async () => {
    await write({ codex: { status: 'weird', windows: [{ limitId: 'codex', usedPercent: '5', windowDurationMins: '300', resetsAt: null }] } });
    const codex = read().providers.codex;
    expect(codex.status).toBe('unknown');
    expect(codex.windows).toEqual([{ limitId: 'codex', usedPercent: null, windowDurationMins: null, resetsAt: null }]);
  });

  it('pin: a failed rename leaves no temp file behind', async () => {
    mkdirSync(path.join(snapshotFile(live), 'blocker'), { recursive: true }); // latest.json is a non-empty dir
    const res = await write({ codex: ok(win('codex', 1, 300)) });
    expect(res.ok).toBe(false);
    expect(readdirSync(path.join(live, 'usage'))).toEqual(['latest.json']);
  });

  it('pin: 0644 whatever the umask, and the file is replaced by rename (new inode)', async () => {
    await write({ codex: ok(win('codex', 1, 300)) });
    const before = statSync(snapshotFile(live)).ino;
    const old = process.umask(0o077);
    try { await write({ codex: ok(win('codex', 2, 300)) }); } finally { process.umask(old); }
    const st = statSync(snapshotFile(live));
    expect(st.mode & 0o777).toBe(0o644);
    expect(st.ino).not.toBe(before);
  });

  // fixA (u4 C1): gate.window is the window the gate BINDS on, per provider and per route — from gateFor, never
  // the fullest window the writer could see.
  it('gate.window: gemini provider/breadth bind argon-wtu, breadth-flash binds gemini weekly', async () => {
    await write({ gemini: geminiReading(100) });
    const gemini = read().providers.gemini;
    const argon = { limitId: 'antigravity-quota-summary-gemini-argon-wtu-weekly', windowDurationMins: 10080, usedPercent: 100, resetsAt: FUTURE };
    expect(gemini.gate.window).toEqual(argon); // unscoped gateFor binds the whole pool's fullest
    const byRole = Object.fromEntries(gemini.routes.map((r: { role: string }) => [r.role, r]));
    expect(byRole.breadth.gate).toMatchObject({ state: 'stop', window: argon });
    expect(byRole['breadth-flash'].gate).toEqual({ state: 'ok', reason: expect.any(String),
      window: { limitId: 'antigravity-quota-summary-gemini-weekly', windowDurationMins: 10080, usedPercent: 39, resetsAt: FUTURE } });
  });

  it('gate.window: codex with 3 pools binds the codex pool, not a fuller foreign window', async () => {
    await write({ codex: ok(win('codex', 20, 300), win('codex', 30, 10080, '2099-02-01T00:00:00.000Z'),
      win('codex-spark', 95, 300), win('codex-spark', 10, 10080), win('codex-other', 60, 300)) });
    const codex = read().providers.codex;
    expect(codex.gate.state).toBe('ok');
    expect(codex.gate.window).toEqual({ limitId: 'codex', windowDurationMins: 10080, usedPercent: 30, resetsAt: '2099-02-01T00:00:00.000Z' });
  });

  it('gate.window is null when the gate binds no window (unavailable / until-stop)', async () => {
    await write({ gemini: { status: 'unavailable', reason: 'reader:unavailable', windows: [] }, codex: { status: 'unavailable', windows: [] } });
    const doc = read();
    expect(doc.providers.gemini.gate.window).toBeNull();
    expect(doc.providers.gemini.routes.every((r: { gate: { window: unknown } }) => r.gate.window === null)).toBe(true);
    expect(doc.providers.codex.gate).toMatchObject({ state: 'unknown', window: null });
  });

  it('claude consent: with no claudeConsent passed, the writer reads it like runUsageCli (config, not env only)', async () => {
    const cfg = path.join(tree, 'usage-readers.json');
    writeFileSync(cfg, JSON.stringify({ claude: { keychainReadConsent: true } }));
    vi.stubEnv('OCLI_USAGE_READERS_CONFIG', cfg);
    vi.stubEnv('OCLI_CLAUDE_KEYCHAIN_CONSENT', '');
    await writeUsageSnapshot({ dir: live, treeDir: tree, readings: { claude: { status: 'unavailable', reason: 'credentials-not-found', windows: [] } } });
    expect(read().providers.claude.setup).toMatch(/no stored credential/);
  });

  it('runUsageCli writes every provider it read', async () => {
    const readAllImpl = async () => ({
      codex: ok(win('codex', 10, 300)), claude: ok(win('5-hour limit', 5, 300)), glm: ok(win('zai-primary', 3, 300)),
      gemini: geminiReading(40), muse: { status: 'unavailable', reason: 'plugin:secret-access', windows: [] }, cline: ok(),
      readAt: '2026-10-23T11:00:00.000Z',
    });
    await runUsageCli({ argv: ['node', 'usage.mjs', '--json'], readAllImpl, policyFile: POLICY, claudeConsent: true, write: () => {} });
    const doc = read();
    expect(Object.keys(doc.providers).sort()).toEqual(['claude', 'cline', 'codex', 'gemini', 'glm', 'muse']);
    expect(doc.providers.codex.readAt).toBe('2026-10-23T11:00:00.000Z');
    expect(doc.providers.gemini.routes.length).toBeGreaterThan(0);
  });
});

describe('dispatch writes the usage snapshot', () => {
  let live: string;
  let tree: string;
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = process.exitCode;
    live = mkdtempSync(path.join(tmpdir(), 'ocli-snap-dlive-'));
    tree = mkdtempSync(path.join(tmpdir(), 'ocli-snap-dtree-'));
    vi.stubEnv('ORCHESTRA_LIVE_DIR', live);
    vi.stubEnv('ORCHESTRA_TREE_DIR', tree);
    vi.stubEnv('ORCHESTRA_POLICY', POLICY);
    const ranking = path.join(tree, 'ranking.json');
    writeFileSync(ranking, JSON.stringify({ schemaVersion: 1, source: 'test', observedAt: '2026-10-23', entries: [] }));
    vi.stubEnv('ORCHESTRA_RANKING_FILE', ranking);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.codex.mockResolvedValue(ok(win('codex', 30, 300)));
    mocks.glm.mockResolvedValue(ok(win('zai-primary', 12, 300)));
    mocks.counter.mockResolvedValue({ status: 'unavailable', reason: 'reader:unavailable', windows: [] });
    exitWith([], 0);
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(live, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });
  function exitWith(stdoutLines: string[], code: number) {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        for (const l of stdoutLines) child.stdout.emit('data', `${l}\n`);
        child.emit('close', code, null);
      });
      return child;
    });
  }
  const read = () => JSON.parse(readFileSync(snapshotFile(live), 'utf8'));
  const nodes = () => readFileSync(path.join(tree, 't.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

  it('--role auto --size: the live refresh is written even when nothing is dispatched', async () => {
    await main(['--role', 'auto', '--size', 'S', '--task', 't', '--prompt', 'p']);
    expect(mocks.codex).toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    const doc = read();
    expect(doc.providers.codex.windows[0].usedPercent).toBe(30);
    expect(doc.providers.glm.status).toBe('ok');
  });

  it('--dry-run writes nothing', async () => {
    await main(['--role', 'auto', '--size', 'S', '--task', 't', '--prompt', 'p', '--dry-run']);
    expect(existsSync(path.join(live, 'usage'))).toBe(false);
  });

  it('a run writes usageAfter and the provider stop it just recorded', async () => {
    let reads = 0;
    mocks.glm.mockImplementation(async () => ok(win('zai-primary', ++reads === 1 ? 12 : 97, 300)));
    const limit = JSON.stringify({ type: 'error', timestamp: 1791762679000, sessionID: 'ses_test',
      error: { name: 'APIError', data: { message: 'Usage limit reached for 5 hour. Your limit will reset at 2099-01-01 08:00:00', statusCode: 429 } } });
    exitWith([limit], 1);
    await main(['--role', 'implement', '--task', 't', '--prompt', 'p']);
    expect(nodes()[0].providerStop?.provider).toBe('zai');
    const glm = read().providers.glm;
    expect(glm.windows[0].usedPercent).toBe(97);
    expect(glm.stop).toEqual({ until: '2099-01-01T00:00:00.000Z', reason: expect.stringContaining('Usage limit reached') });
  });

  it('pin: usageBefore is in the snapshot while the CLI runs (before usageAfter)', async () => {
    let reads = 0;
    mocks.glm.mockImplementation(async () => ok(win('zai-primary', ++reads === 1 ? 12 : 97, 300)));
    let atSpawn: number | null = null;
    const spawnImpl = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((...a: unknown[]) => {
      atSpawn = read().providers.glm.windows[0].usedPercent;
      return spawnImpl(...a);
    });
    await main(['--role', 'implement', '--task', 't', '--prompt', 'p']);
    expect(atSpawn).toBe(12);
    expect(read().providers.glm.windows[0].usedPercent).toBe(97);
  });

  it('a snapshot write failure never fails the dispatch', async () => {
    writeFileSync(path.join(live, 'usage'), 'not a dir');
    await main(['--role', 'implement', '--task', 't', '--prompt', 'p']);
    expect(nodes()).toHaveLength(1);
    expect(nodes()[0].exitCode).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
