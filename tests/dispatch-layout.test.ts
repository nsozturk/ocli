// Where the standalone dispatcher reads its policy and writes its files.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), append: vi.fn(), live: vi.fn(), readFile: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async original => ({ ...await original<Record<string, unknown>>(), appendFileSync: mocks.live, mkdirSync: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<Record<string, unknown>>(), readFile: mocks.readFile, appendFile: mocks.append, mkdir: vi.fn() }));
vi.mock('../dispatcher/usage.mjs', async original => ({ ...await original<Record<string, unknown>>(), readCodexUsage: vi.fn(async () => ({ status: 'unknown' })), readGlmUsage: vi.fn(async () => ({ status: 'unknown' })), claudeUsageFromLead: vi.fn(), usageDelta: vi.fn(), gateFor: vi.fn() }));
// @ts-expect-error plain ESM tooling
import { main } from '../dispatcher/dispatch.mjs';
const example = readFileSync(new URL('../dispatcher/policy.full-roster.json', import.meta.url), 'utf8');
const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
const dispatch = () => main(['--role', 'reason', '--task', 'layout', '--prompt', 'p']);
let workspace: string;
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  fs.mkdirSync(path.resolve('tmp'), { recursive: true });
  workspace = fs.mkdtempSync(path.resolve('tmp', 'rs1-layout-'));
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 7 });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  fs.rmSync(workspace, { recursive: true, force: true });
});
it('without ORCHESTRA_LIVE_DIR, live files go under <cwd>/orchestra/live/<task>/ (where the pane looks)', async () => {
  mocks.readFile.mockResolvedValue(example);
  await dispatch();
  const files = [...new Set(mocks.live.mock.calls.map(([file]) => String(file)))];
  const runId = JSON.parse(mocks.append.mock.calls[0][1]).runId;
  expect(files.sort()).toEqual([
    path.join(process.cwd(), 'orchestra', 'live', 'layout', `${runId}.jsonl`),
    path.join(process.cwd(), 'orchestra', 'live', 'layout', `${runId}.raw.jsonl`),
  ]);
});
it('the tree record is appended to <cwd>/orchestra/tree/<task>.jsonl', async () => {
  mocks.readFile.mockResolvedValue(example);
  await dispatch();
  expect(mocks.append.mock.calls[0][0]).toBe(path.join(process.cwd(), 'orchestra', 'tree', 'layout.jsonl'));
});
it('reads dispatcher/policy.json first and uses it when present', async () => {
  const own = JSON.parse(example);
  own.routes.reason.model = 'my-own-model';
  mocks.readFile.mockImplementation(async (file: string) => {
    if (file.endsWith(`${path.sep}policy.json`)) return JSON.stringify(own);
    throw new Error(`unexpected read ${file}`);
  });
  await dispatch();
  const argv = mocks.spawn.mock.calls[0][1];
  expect(argv[argv.indexOf('-m') + 1]).toBe('my-own-model');
});
it('falls back to policy.example.json only when policy.json does not exist', async () => {
  mocks.readFile.mockImplementation(async (file: string) => {
    if (file.endsWith(`${path.sep}policy.json`)) throw enoent();
    if (file.endsWith(`${path.sep}policy.example.json`)) return example;
    throw new Error(`unexpected read ${file}`);
  });
  await dispatch();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.spawn.mock.calls[0][0]).toBe('codex');
});
it('a policy.json that exists but cannot be read is an error, not a silent switch to the example', async () => {
  mocks.readFile.mockImplementation(async (file: string) => {
    if (file.endsWith(`${path.sep}policy.json`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return example;
  });
  await expect(dispatch()).rejects.toThrow('EACCES');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('the example policy refuses a route that is not marked ok', async () => {
  mocks.readFile.mockResolvedValue(example);
  await expect(main(['--role', 'easy', '--task', 'layout', '--prompt', 'p'])).rejects.toThrow(/route easy \(codex\) is unverified/);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
