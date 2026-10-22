import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import * as usage from '../dispatcher/usage.mjs';

// The CLI body is injectable: no real reader, keychain, ~/.config/ocli or network is touched.
const POLICY = fileURLToPath(new URL('../dispatcher/policy.full-roster.json', import.meta.url));
const USAGE_SRC = fileURLToPath(new URL('../dispatcher/usage.mjs', import.meta.url));

const win = (limitId: string, usedPercent: number, windowDurationMins: number, model: string | null = null) =>
  ({ limitId, usedPercent, windowDurationMins, resetsAt: null, model });
const ok = (...windows: unknown[]) => ({ status: 'ok', windows });
const readings = () => ({
  codex: ok(win('codex', 10, 300), win('codex', 20, 10080)),
  claude: ok(win('5-hour limit', 5, 300), win('Weekly · all models', 6, 10080)),
  glm: ok(win('zai-primary', 3, 300)),
  gemini: ok(
    win('antigravity-quota-summary-gemini-5h', 12, 300),
    win('antigravity-quota-summary-gemini-weekly', 15, 10080),
    win('antigravity-quota-summary-gemini-argon-wtu-weekly', 40, 10080, 'gemini-4-argon')),
  muse: { status: 'unavailable', reason: 'plugin:secret-access', windows: [] },
  cline: ok(),
  readAt: '2026-01-01T00:00:00.000Z',
});

async function run(argv: string[]) {
  let out = '';
  // The CLI writes its usage snapshot under the live root: a temp dir, never a real orchestra/.
  const dir = mkdtempSync(path.join(tmpdir(), 'ocli-usage-cli-'));
  vi.stubEnv('ORCHESTRA_LIVE_DIR', path.join(dir, 'live'));
  vi.stubEnv('ORCHESTRA_TREE_DIR', path.join(dir, 'tree'));
  try {
    await usage.runUsageCli({ argv, readAllImpl: async () => readings(), policyFile: POLICY, claudeConsent: true, write: (s: string) => { out += s; } });
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

describe('usage.mjs CLI (runUsageCli)', () => {
  it('the module graph loads and exports the CLI body', async () => {
    const mod = await import('../dispatcher/usage.mjs');
    expect(typeof mod.runUsageCli).toBe('function');
  });

  it('prints each provider section, the setup lines of an unavailable plugin, and the scoped-bucket lines', async () => {
    const out = await run(['node', 'usage.mjs']);
    for (const name of ['CODEX', 'CLAUDE', 'GLM', 'GEMINI', 'MUSE', 'CLINE']) expect(out).toContain(`\n${name}  [`);
    expect(out).toContain('MUSE  [unavailable]');
    expect(out).toMatch(/setup: .*keychain service/);
    expect(out).toMatch(/setup: security add-generic-password/);
    expect(out).toContain('-> scoped antigravity-quota-summary-gemini-argon-wtu-weekly: binds breadth');
    expect(out).toContain('breadth (gemini-4-argon-high): DISPATCH');
  });

  it('--json parses and carries setup for the unavailable provider only', async () => {
    const parsed = JSON.parse(await run(['node', 'usage.mjs', '--json']));
    expect(Object.keys(parsed.setup)).toEqual(['muse']);
    expect(parsed.setup.muse.needs.length).toBeGreaterThan(0);
    expect(parsed.codex.status).toBe('ok');
  });

  it('the main-module guard has no top-level await (tree-read.mjs imports usage.mjs: it would never settle)', () => {
    const src = readFileSync(USAGE_SRC, 'utf8');
    const guard = src.slice(src.indexOf('if (process.argv[1] && import.meta.url')).replace(/^\s*\/\/.*$/gm, '');
    expect(guard.length).toBeGreaterThan(0);
    expect(guard).not.toMatch(/\bawait\b/);
    expect(guard).toMatch(/runUsageCli\(\)/);
    expect(guard).toMatch(/\.then\(/);
  });
});
