import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

// u5-e-package-port review pins: each test kills one mutant the slice's own tests let survive.
// @ts-expect-error - dispatcher tooling is plain ESM, outside the typed src build.
import { DEFAULT_RAW_USAGE_DB } from '../dispatcher/usage-readers/raw-store.mjs';
// @ts-expect-error - dispatcher tooling is plain ESM, outside the typed src build.
import { readAll, readGlmUsage } from '../dispatcher/usage.mjs';

const unavailable = { reading: { status: 'unavailable', reason: 'stub', windows: [] } };
const refusing = async () => { throw new Error('refused'); };

describe('u5-e-package-port review pins', () => {
  it('M1: the package raw usage db defaults to ~/.config/ocli/data/raw_usage.sqlite (the package has no repo data/)', () => {
    expect(DEFAULT_RAW_USAGE_DB).toBe(join(homedir(), '.config', 'ocli', 'data', 'raw_usage.sqlite'));
  });

  it('M9: readGlmUsage reads the glm provider (the zai plugin through index.mjs), not an unknown id', async () => {
    const read = vi.fn(async () => unavailable);
    await readGlmUsage({ rawStore: null, transport: refusing, configPath: '/nonexistent/ocli-test/x.json', readers: { plugin: { read } } });
    expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0] as unknown[])[0]).toBe('glm');
  });

  it('M8: readAll hands the lead snapshot to the claude reading (fallback when the native reader has none)', async () => {
    const stub = { read: vi.fn(async () => unavailable) };
    const snapshot = { windows: [{ label: 'Current 5-hour session', percentUsed: 37, resetsAt: '2026-10-21T15:00:00Z' }] };
    const all = await readAll({ claudeSnapshot: snapshot, rawStore: null, transport: refusing, configPath: '/nonexistent/ocli-test/x.json',
      readers: { codex: stub, claude: stub, gemini: stub, plugin: stub } });
    expect(all.claude.status).toBe('ok');
    expect(all.claude.windows.map((w: { usedPercent: number }) => w.usedPercent)).toEqual([37]);
  });
});
