import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_NATIVE_SOURCE, CLAUDE_KEYCHAIN_SERVICE, CLAUDE_FIVE_HOUR_LIMIT_ID, CLAUDE_WEEKLY_LIMIT_ID,
  resolveClaudeSourcePlan, resolveClaudeStrategies, claudeCLIResolvedBinaryPath, claudeCredentialsPath,
  parseClaudeCredentials, loadClaudeCredentialRecord, resolveClaudeCredentialRouting, decodeClaudeOAuthUsage,
  mapClaudeOAuthUsage, claudeOAuthLoginMethod, fetchClaudeOAuthUsage, parseClaudeAdminSnapshot, mapClaudeAdminUsage,
  fetchClaudeAdminUsage, readClaudeNativeUsage, defaultClaudeTransport,
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
} from '../dispatcher/usage-readers/natives/claude.mjs';
// @ts-expect-error - orchestra tooling is plain ESM, outside the typed src build.
import { createCredentialStore } from '../dispatcher/usage-readers/credentials.mjs';

// Fixtures are ported from CodexBar @ 6480977 (MIT © 2026 Peter Steinberger): Tests/CodexBarTests/ClaudeOAuthTests.swift,
// ClaudeSourcePlannerTests.swift, ClaudeAdminAPIUsageTests.swift. Never the network, never ~/.claude, never the real
// keychain: every transport, file and keychain runner below is a stub or a temp dir.

type Req = { url: string; method: string; headers: Record<string, string>; body?: unknown };
type Res = { status: number; headers?: Record<string, string>; body?: string };
function transportStub(answer: (req: Req) => Res | Promise<Res>) {
  const requests: Req[] = [];
  const transport = vi.fn(async (req: Req) => {
    requests.push(req);
    const r = await answer(req);
    return { status: r.status, headers: r.headers ?? {}, body: Buffer.from(r.body ?? '') };
  });
  return { transport, requests };
}
const json = (v: unknown, status = 200): Res => ({ status, body: JSON.stringify(v) });

const ACCESS = 'sk-ant-oat01-ACCESS-SECRET-1a2b3c';
const REFRESH = 'sk-ant-ort01-REFRESH-SECRET-4d5e6f';
const ADMIN = 'sk-ant-admin01-ADMIN-SECRET-7g8h9i';
const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const FUTURE = NOW + 3_600_000;

const dirs: string[] = [];
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'n2-claude-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function credentialsJSON(over: Record<string, unknown> = {}) {
  return JSON.stringify({ claudeAiOauth: {
    accessToken: ACCESS, refreshToken: REFRESH, expiresAt: FUTURE, scopes: ['user:inference', 'user:profile'],
    rateLimitTier: 'default_claude_max_5x', subscriptionType: 'max', ...over,
  } });
}
function homeWithCredentials(text = credentialsJSON()) {
  const home = tempHome();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.credentials.json'), text, { mode: 0o600 });
  return home;
}

const USAGE_FIXTURE = {
  five_hour: { utilization: 12.5, resets_at: '2025-12-25T12:00:00.000Z' },
  seven_day: { utilization: 30, resets_at: '2025-12-31T00:00:00.000Z' },
  seven_day_sonnet: { utilization: 5 },
};
const map = (payload: unknown, creds: Record<string, unknown> = {}) =>
  mapClaudeOAuthUsage(decodeClaudeOAuthUsage(payload), { credentials: { scopes: ['user:profile'], ...creds }, nowMs: NOW });
type Win = { limitId: string; usedPercent: number; windowDurationMins: number | null; resetsAt: string | null };
const win = (reading: { windows: Win[] }, id: string) => reading.windows.find(w => w.limitId === id);

// ---------------------------------------------------------------- planner (ClaudeSourcePlannerTests)

describe('N2 source planner — ClaudeSourcePlanner.swift', () => {
  const input = (o: Record<string, unknown>) => ({ runtime: 'app', selectedDataSource: 'auto', webExtrasEnabled: false,
    hasWebSession: false, hasCLI: false, hasOAuthCredentials: false, ...o });

  it('app auto plan preserves ordered steps and reasons', () => {
    const plan = resolveClaudeSourcePlan(input({ hasWebSession: true, hasCLI: true, hasOAuthCredentials: true }));
    expect(plan.orderedSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['oauth', 'cli', 'web']);
    expect(plan.orderedSteps.map((s: { inclusionReason: string }) => s.inclusionReason))
      .toEqual(['app-auto-preferred-oauth', 'app-auto-fallback-cli', 'app-auto-fallback-web']);
    expect(plan.availableSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['oauth', 'cli', 'web']);
    expect(plan.preferredStep.dataSource).toBe('oauth');
  });

  it('CLI auto plan preserves ordered steps and reasons', () => {
    const plan = resolveClaudeSourcePlan(input({ runtime: 'cli', hasWebSession: true, hasCLI: true }));
    expect(plan.orderedSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['web', 'cli']);
    expect(plan.orderedSteps.map((s: { inclusionReason: string }) => s.inclusionReason))
      .toEqual(['cli-auto-preferred-web', 'cli-auto-fallback-cli']);
    expect(plan.preferredStep.dataSource).toBe('web');
  });

  it('explicit mode plan is single step', () => {
    const plan = resolveClaudeSourcePlan(input({ selectedDataSource: 'cli', webExtrasEnabled: true, hasCLI: true }));
    expect(plan.orderedSteps).toHaveLength(1);
    expect(plan.orderedSteps[0]).toMatchObject({ dataSource: 'cli', inclusionReason: 'explicit-source-selection' });
    expect(plan.compatibilityStrategy).toEqual({ dataSource: 'cli', useWebExtras: true });
  });

  it('app explicit OAuth selects owner mediated CLI when direct credentials are unavailable', () => {
    const plan = resolveClaudeSourcePlan(input({ selectedDataSource: 'oauth', hasWebSession: true, hasCLI: true }));
    expect(plan.orderedSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['oauth', 'cli']);
    expect(plan.orderedSteps.map((s: { inclusionReason: string }) => s.inclusionReason))
      .toEqual(['explicit-source-selection', 'explicit-oauth-owner-cli-fallback']);
    expect(plan.compatibilityStrategy).toEqual({ dataSource: 'cli', useWebExtras: false });
  });

  it('app explicit OAuth selects direct OAuth when credentials are available', () => {
    const plan = resolveClaudeSourcePlan(input({ selectedDataSource: 'oauth', hasWebSession: true, hasCLI: true, hasOAuthCredentials: true }));
    expect(plan.orderedSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['oauth', 'cli']);
    expect(plan.compatibilityStrategy).toEqual({ dataSource: 'oauth', useWebExtras: false });
  });

  it('CLI explicit OAuth remains terminal', () => {
    const plan = resolveClaudeSourcePlan(input({ runtime: 'cli', selectedDataSource: 'oauth', hasWebSession: true, hasCLI: true }));
    expect(plan.orderedSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['oauth']);
    expect(plan.orderedSteps[0].inclusionReason).toBe('explicit-source-selection');
  });

  it('app auto CLI fallback reports web extras like runtime', () => {
    const plan = resolveClaudeSourcePlan(input({ webExtrasEnabled: true, hasCLI: true }));
    expect(plan.preferredStep.dataSource).toBe('cli');
    expect(plan.compatibilityStrategy).toEqual({ dataSource: 'cli', useWebExtras: true });
  });

  it('no source planner output is deterministic', () => {
    const plan = resolveClaudeSourcePlan(input({}));
    expect(plan.orderedSteps.map((s: { dataSource: string }) => s.dataSource)).toEqual(['oauth', 'cli', 'web']);
    expect(plan.availableSteps).toEqual([]);
    expect(plan.isNoSourceAvailable).toBe(true);
    expect(plan.preferredStep).toBeNull();
    expect(plan.executionSteps).toEqual([]);
    expect(plan.debugLines()).toEqual([
      'planner_order=oauth→cli→web',
      'planner_selected=none',
      'planner_no_source=true',
      'planner_step.oauth=unavailable reason=app-auto-preferred-oauth',
      'planner_step.cli=unavailable reason=app-auto-fallback-cli',
      'planner_step.web=unavailable reason=app-auto-fallback-web',
    ]);
  });

  it('CLI resolver falls back to PATH when the CLAUDE_CLI_PATH override is invalid', () => {
    const dir = tempHome();
    const binary = join(dir, 'claude');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o755);
    expect(claudeCLIResolvedBinaryPath({ CLAUDE_CLI_PATH: '/definitely/missing/claude', PATH: dir })).toBe(binary);
    expect(claudeCLIResolvedBinaryPath({ CLAUDE_CLI_PATH: binary, PATH: '' })).toBe(binary);
    expect(claudeCLIResolvedBinaryPath({ PATH: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------- strategies (ClaudeProviderDescriptor.resolveStrategies)

describe('N2 strategy list — resolveStrategies L287-345', () => {
  const ids = (ctx: Record<string, unknown>) =>
    resolveClaudeStrategies({ runtime: 'app', sourceMode: 'auto', env: {}, hasCLI: false, adminKey: null, ...ctx })
      .map((s: { id: string }) => s.id);

  it('app auto without an admin key plans oauth → cli → web', () => {
    expect(ids({})).toEqual(['claude.oauth', 'claude.cli', 'claude.web']);
  });
  it('explicit api, and auto with an admin key, run the Admin API alone', () => {
    expect(ids({ sourceMode: 'api' })).toEqual(['claude.admin-api']);
    expect(ids({ adminKey: ADMIN })).toEqual(['claude.admin-api']);
  });
  it('an admin key does not hijack an explicit non-auto mode', () => {
    expect(ids({ sourceMode: 'oauth', adminKey: ADMIN })).toEqual(['claude.oauth', 'claude.cli']);
    expect(ids({ sourceMode: 'web', adminKey: ADMIN })).toEqual(['claude.web']);
  });
  it('a selected account is the authority: admin / oauth / web, and an unusable one yields no strategy at all', () => {
    expect(ids({ selectedAccount: { token: `Bearer ${ADMIN}` }, adminKey: null })).toEqual(['claude.admin-api']);
    expect(ids({ selectedAccount: { token: ACCESS } })).toEqual(['claude.oauth']);
    expect(ids({ selectedAccount: { token: 'sessionKey=sk-ant-sid01-abc' } })).toEqual(['claude.web']);
    expect(ids({ selectedAccount: { token: '   ' }, adminKey: ADMIN, hasCLI: true })).toEqual([]);
  });
  it('credential routing matches ClaudeCredentialRouting', () => {
    expect(resolveClaudeCredentialRouting(`Bearer ${ADMIN}`)).toEqual({ kind: 'adminAPIKey', value: ADMIN });
    expect(resolveClaudeCredentialRouting(`bearer ${ACCESS}`)).toEqual({ kind: 'oauth', value: ACCESS });
    expect(resolveClaudeCredentialRouting('abc123')).toEqual({ kind: 'webCookie', value: 'sessionKey=abc123' });
    expect(resolveClaudeCredentialRouting('Bearer sk-other')).toEqual({ kind: 'webCookie', value: 'sessionKey=Bearer sk-other' });
    expect(resolveClaudeCredentialRouting('')).toEqual({ kind: 'none', value: null });
  });
});

// ---------------------------------------------------------------- credentials (read-only)

describe('N2 credentials — locate and read, never write', () => {
  it('parses OAuth credentials (ClaudeOAuthTests)', () => {
    const c = parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', refreshToken: 'test-refresh',
      expiresAt: 4102444800000, scopes: ['usage:read'], rateLimitTier: 'default_claude_max_20x', subscriptionType: 'pro' } }));
    expect(c).toMatchObject({ accessToken: 'test-token', refreshToken: 'test-refresh', scopes: ['usage:read'],
      rateLimitTier: 'default_claude_max_20x', subscriptionType: 'pro', expiresAtMs: 4102444800000 });
  });
  it('typed parse failures: empty access token, missing block, MCP-only payload, wrong types', () => {
    const code = (text: string) => { try { parseClaudeCredentials(text); return 'parsed'; } catch (e) { return (e as { code: string }).code; } };
    expect(code(JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: 'x', expiresAt: 1735689600000 } }))).toBe('credentials-missing-access-token');
    expect(code(JSON.stringify({ other: { accessToken: 'nope' } }))).toBe('credentials-missing-oauth');
    expect(code(JSON.stringify({ mcpOAuth: { 'plugin:slack:slack': { accessToken: '' } } }))).toBe('credentials-mcp-only');
    expect(code(JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 'soon' } }))).toBe('credentials-decode-failed');
    expect(code('not json')).toBe('credentials-decode-failed');
  });

  it('credentials path follows ClaudeConfigPaths (secure-storage dir > CLAUDE_CONFIG_DIR > HOME/.claude)', () => {
    expect(claudeCredentialsPath({ env: { HOME: '/h' } })).toBe('/h/.claude/.credentials.json');
    expect(claudeCredentialsPath({ env: { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' } })).toBe('/cfg/.credentials.json');
    expect(claudeCredentialsPath({ env: { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/sec' } })).toBe('/sec/.credentials.json');
    expect(claudeCredentialsPath({ env: { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } })).toBe('/h/.claude/.credentials.json');
    expect(claudeCredentialsPath({ env: { HOME: '/h', CLAUDE_CONFIG_DIR: 'rel/dir' }, workingDirectory: '/probe' })).toBe('/probe/rel/dir/.credentials.json');
    expect(claudeCredentialsPath({ env: { HOME: '' }, homeDir: '/fallback' })).toBe('/fallback/.claude/.credentials.json');
  });

  it('an environment token wins and nothing else is read', () => {
    const readFile = vi.fn();
    const keychain = { read: vi.fn() };
    const r = loadClaudeCredentialRecord({ env: { CODEXBAR_CLAUDE_OAUTH_TOKEN: ` ${ACCESS} `, HOME: '/nowhere' }, readFile, credentials: keychain, keychainReadConsent: true });
    expect(r).toMatchObject({ owner: 'environment', source: 'environment', credentials: { accessToken: ACCESS, scopes: ['user:profile'] } });
    expect(readFile).not.toHaveBeenCalled();
    expect(keychain.read).not.toHaveBeenCalled();
  });

  it('the credentials file is read before the keychain; the keychain needs explicit consent', () => {
    const home = homeWithCredentials();
    const keychain = { read: vi.fn(() => ({ ok: true, value: credentialsJSON({ accessToken: 'from-keychain' }) })) };
    const r = loadClaudeCredentialRecord({ env: { HOME: home }, credentials: keychain, keychainReadConsent: true, now: () => NOW });
    expect(r).toMatchObject({ owner: 'claudeCLI', source: 'credentialsFile', credentials: { accessToken: ACCESS } });
    expect(keychain.read).not.toHaveBeenCalled();

    const empty = tempHome();
    expect(() => loadClaudeCredentialRecord({ env: { HOME: empty }, credentials: keychain, keychainReadConsent: false, now: () => NOW }))
      .toThrow(expect.objectContaining({ code: 'credentials-not-found' }));
    expect(keychain.read).not.toHaveBeenCalled();
    const k = loadClaudeCredentialRecord({ env: { HOME: empty }, credentials: keychain, keychainReadConsent: true, now: () => NOW });
    expect(k).toMatchObject({ owner: 'claudeCLI', source: 'claudeKeychain', credentials: { accessToken: 'from-keychain' } });
    expect(keychain.read).toHaveBeenCalledWith({ service: CLAUDE_KEYCHAIN_SERVICE, account: null, anyAccount: true });
  });

  it('the keychain item is read through B1 as `security find-generic-password -s "Claude Code-credentials" -w` (no -a)', () => {
    const calls: { file: string; args: string[] }[] = [];
    const run = (file: string, args: string[]) => { calls.push({ file, args }); return { status: 0, stdout: `${credentialsJSON()}\n`, stderr: '' }; };
    const store = createCredentialStore({ platform: 'darwin', run });
    const r = loadClaudeCredentialRecord({ env: { HOME: tempHome() }, credentials: store, keychainReadConsent: true, now: () => NOW });
    expect(r.source).toBe('claudeKeychain');
    expect(calls).toEqual([{ file: '/usr/bin/security', args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'] }]);
    // B1's contract is unchanged: a missing account without the explicit opt-in never spawns.
    expect(store.read({ service: 'Claude Code-credentials', account: '' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('an expired file credential is still returned (the strategy decides), a fresh keychain one is preferred', () => {
    const home = homeWithCredentials(credentialsJSON({ expiresAt: NOW - 1 }));
    const r = loadClaudeCredentialRecord({ env: { HOME: home }, now: () => NOW });
    expect(r.source).toBe('credentialsFile');
    expect(r.credentials.expiresAtMs).toBe(NOW - 1);
  });

  it('review pin: an expired file credential yields to a consented keychain record', () => {
    const home = homeWithCredentials(credentialsJSON({ expiresAt: NOW - 1 }));
    const keychain = { read: vi.fn(() => ({ ok: true, value: credentialsJSON({ accessToken: 'from-keychain' }) })) };
    const r = loadClaudeCredentialRecord({ env: { HOME: home }, credentials: keychain, keychainReadConsent: true, now: () => NOW });
    expect(r).toMatchObject({ source: 'claudeKeychain', credentials: { accessToken: 'from-keychain' } });
  });

  it('a default path under the real home is never read in a test process (fails closed)', () => {
    const readFile = vi.fn(() => credentialsJSON());
    expect(() => loadClaudeCredentialRecord({ env: { HOME: homedir() }, readFile, now: () => NOW }))
      .toThrow(expect.objectContaining({ code: 'credentials-not-found' }));
    expect(readFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- OAuth usage mapping (ClaudeOAuthTests fixtures)

describe('N2 OAuth usage → reading windows', () => {
  it('maps OAuth usage to windows with today\'s claude limitIds; plan goes to identity only', () => {
    const { reading, identity } = map(USAGE_FIXTURE, { rateLimitTier: 'claude_pro' });
    expect(CLAUDE_FIVE_HOUR_LIMIT_ID).toBe('5-hour limit');
    expect(CLAUDE_WEEKLY_LIMIT_ID).toBe('Weekly · all models');
    expect(reading.status).toBe('ok');
    expect(reading.source).toBe(CLAUDE_NATIVE_SOURCE);
    expect(reading.windows).toEqual([
      { limitId: '5-hour limit', usedPercent: 12.5, windowDurationMins: 300, resetsAt: '2025-12-25T12:00:00.000Z' },
      { limitId: 'Weekly · all models', usedPercent: 30, windowDurationMins: 10080, resetsAt: '2025-12-31T00:00:00.000Z' },
      { limitId: 'claude-tertiary', usedPercent: 5, windowDurationMins: 10080, resetsAt: null },
    ]);
    expect(identity.plan).toBe('Claude Pro');
    expect(JSON.stringify(reading)).not.toContain('Claude Pro');
  });

  it('login method: subscription type wins over a generic tier; Max carries its multiplier', () => {
    expect(claudeOAuthLoginMethod('pro', 'default_claude_ai')).toBe('Claude Pro');
    expect(claudeOAuthLoginMethod(null, 'default_claude_max_20x')).toBe('Claude Max 20x');
    expect(claudeOAuthLoginMethod('enterprise', null)).toBe('Claude Enterprise');
    expect(claudeOAuthLoginMethod(null, null)).toBeNull();
  });

  it('ignores the merged design window; routines become claude-routines', () => {
    const { reading } = map({ five_hour: USAGE_FIXTURE.five_hour,
      seven_day_design: { utilization: 44, resets_at: '2025-12-31T00:00:00.000Z' },
      seven_day_routines: { utilization: 18, resets_at: '2026-01-01T00:00:00.000Z' } });
    expect(reading.windows.map((w: { limitId: string }) => w.limitId)).toEqual(['5-hour limit', 'claude-routines']);
    expect(win(reading, 'claude-routines')).toEqual({ limitId: 'claude-routines', usedPercent: 18, windowDurationMins: 10080, resetsAt: '2026-01-01T00:00:00.000Z' });
  });

  it('surfaces the Fable scoped weekly limit from the limits array (microsecond offsets parse)', () => {
    const { reading } = map({
      five_hour: { utilization: 11.0, resets_at: '2026-07-03T00:30:00.282668+00:00' },
      seven_day: { utilization: 9.0, resets_at: '2026-07-08T09:00:00.282694+00:00' },
      seven_day_opus: null, seven_day_sonnet: null,
      limits: [
        { kind: 'session', group: 'session', percent: 11, resets_at: '2026-07-03T00:30:00.282668+00:00', scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 9, resets_at: '2026-07-08T09:00:00.282694+00:00', scope: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: '2026-07-08T09:00:00.283070+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      ] });
    expect(win(reading, '5-hour limit')?.resetsAt).toBe('2026-07-03T00:30:00.282Z');
    expect(win(reading, 'claude-weekly-scoped-fable')).toEqual({ limitId: 'claude-weekly-scoped-fable', usedPercent: 5,
      windowDurationMins: 10080, resetsAt: '2026-07-08T09:00:00.283Z' });
    expect(win(reading, 'claude-tertiary')).toBeUndefined();
  });

  it('orders scoped weekly windows before daily routines; a scope without a model name is ignored', () => {
    const { reading } = map({ ...USAGE_FIXTURE, seven_day_sonnet: undefined,
      seven_day_routines: { utilization: 18, resets_at: '2026-01-01T00:00:00.000Z' },
      limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 29, resets_at: '2025-12-31T00:00:00.000Z',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false }] });
    expect(reading.windows.map((w: { limitId: string }) => w.limitId))
      .toEqual(['5-hour limit', 'Weekly · all models', 'claude-weekly-scoped-fable', 'claude-routines']);
    const none = map({ five_hour: USAGE_FIXTURE.five_hour, limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 5,
      resets_at: '2026-07-08T09:00:00.283070+00:00', scope: { model: null, surface: null }, is_active: false }] });
    expect(none.reading.windows.some((w: { limitId: string }) => w.limitId.startsWith('claude-weekly-scoped-'))).toBe(false);
  });

  it('routines aliases: cowork counts, a null alias falls through to the next populated one', () => {
    const omelette = map({ five_hour: USAGE_FIXTURE.five_hour, seven_day_omelette: { utilization: 29, resets_at: '2025-12-31T00:00:00.000Z' },
      seven_day_cowork: { utilization: 9, resets_at: '2026-01-01T00:00:00.000Z' } });
    expect(omelette.reading.windows.map((w: { limitId: string }) => w.limitId)).toEqual(['5-hour limit', 'claude-routines']);
    expect(win(omelette.reading, 'claude-routines')?.usedPercent).toBe(9);
    const nullCowork = map({ five_hour: USAGE_FIXTURE.five_hour, seven_day_omelette: { utilization: 29 }, seven_day_cowork: null });
    expect(win(nullCowork.reading, 'claude-routines')).toBeUndefined();
    const mixed = map({ five_hour: USAGE_FIXTURE.five_hour, seven_day_design: null, seven_day_omelette: { utilization: 37 },
      seven_day_routines: null, seven_day_cowork: { utilization: 14, resets_at: '2026-01-01T00:00:00.000Z' } });
    expect(win(mixed.reading, 'claude-routines')?.usedPercent).toBe(14);
  });

  it('extra usage is cents → major units (Monthly cap); prefers opus when sonnet is missing', () => {
    const { reading } = map({ five_hour: { utilization: 1, resets_at: '2025-12-25T12:00:00.000Z' },
      extra_usage: { is_enabled: true, monthly_limit: 2050, used_credits: 325 } });
    expect(reading.cost).toEqual({ used: 3.25, limit: 20.5, currencyCode: 'USD', period: 'Monthly cap' });
    const high = map({ five_hour: { utilization: 1 }, extra_usage: { is_enabled: true, monthly_limit: 200000, used_credits: 22200, currency: 'USD' } });
    expect(high.reading.cost).toMatchObject({ used: 222, limit: 2000 });
    const opus = map({ five_hour: { utilization: 10, resets_at: '2025-12-25T12:00:00.000Z' }, seven_day_opus: { utilization: 42 } });
    expect(win(opus.reading, 'claude-tertiary')?.usedPercent).toBe(42);
  });

  it('enterprise spend-only response: no rate windows, a Spend limit cost; nothing at all ⇒ missing session data', () => {
    const { reading, identity } = map({ extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 763, utilization: 38.15, currency: 'EUR' } },
      { subscriptionType: 'enterprise' });
    expect(identity.plan).toBe('Claude Enterprise');
    expect(reading.windows).toEqual([]);
    expect(reading.cost).toEqual({ used: 7.63, limit: 20, currencyCode: 'EUR', period: 'Spend limit' });
    expect(() => map({ seven_day_design: { utilization: 1 } })).toThrow(expect.objectContaining({ code: 'usage-missing-session-data' }));
  });

  it('review pin: weekly is seven_day only, tertiary is sonnet before opus (mapOAuthUsage L996-999)', () => {
    const { reading } = map({ five_hour: { utilization: 1 }, seven_day: { utilization: 30 }, seven_day_oauth_apps: { utilization: 77 },
      seven_day_sonnet: { utilization: 5 }, seven_day_opus: { utilization: 42 } });
    expect(win(reading, 'Weekly · all models')?.usedPercent).toBe(30);
    expect(win(reading, 'claude-tertiary')?.usedPercent).toBe(5);
  });

  it('a weekly-only response does not duplicate the weekly window into the 5-hour id', () => {
    const { reading } = map({ seven_day: { utilization: 40, resets_at: '2025-12-31T00:00:00.000Z' } });
    expect(reading.windows).toEqual([{ limitId: 'Weekly · all models', usedPercent: 40, windowDurationMins: 10080, resetsAt: '2025-12-31T00:00:00.000Z' }]);
  });
});

// ---------------------------------------------------------------- OAuth request (ClaudeOAuthUsageFetcher.swift)

describe('N2 OAuth request — /api/oauth/usage', () => {
  it('GET ?cedar_ember=1 with bearer, beta header and the claude-cli user agent', async () => {
    const { transport, requests } = transportStub(() => json(USAGE_FIXTURE));
    const usage = await fetchClaudeOAuthUsage({ accessToken: ACCESS, transport, claudeVersion: null });
    expect(usage.fiveHour.utilization).toBe(12.5);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1', method: 'GET' });
    expect(requests[0].headers).toMatchObject({ Authorization: `Bearer ${ACCESS}`, Accept: 'application/json',
      'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli/2.1.0 (external, cli)' });
  });
  it('a detected version is the first token of `claude --version`', async () => {
    const { transport, requests } = transportStub(() => json(USAGE_FIXTURE));
    await fetchClaudeOAuthUsage({ accessToken: ACCESS, transport, claudeVersion: '2.3.4 (Claude Code)' });
    expect(requests[0].headers['User-Agent']).toBe('claude-cli/2.3.4 (external, cli)');
  });
  it('400, or 403 without user:profile, retries once without the inventory query and with claude-code/<v>', async () => {
    for (const first of [{ status: 400, body: '{}' }, { status: 403, body: '{"error":"other"}' }]) {
      let n = 0;
      const { transport, requests } = transportStub(() => (n++ === 0 ? first : json(USAGE_FIXTURE)));
      await fetchClaudeOAuthUsage({ accessToken: ACCESS, transport });
      expect(requests.map(r => r.url)).toEqual(['https://api.anthropic.com/api/oauth/usage?cedar_ember=1', 'https://api.anthropic.com/api/oauth/usage']);
      expect(requests[1].headers['User-Agent']).toBe('claude-code/2.1.0');
      expect(requests[1].headers.Authorization).toBe(`Bearer ${ACCESS}`);
    }
  });
  it('status mapping: 403 user:profile (no retry), 401, 429, 500, network error', async () => {
    const code = async (res: Res | Error) => {
      const { transport, requests } = transportStub(() => { if (res instanceof Error) throw res; return res; });
      try { await fetchClaudeOAuthUsage({ accessToken: ACCESS, transport }); return ['ok', requests.length]; }
      catch (e) { return [(e as { code: string }).code, requests.length]; }
    };
    expect(await code({ status: 403, body: 'OAuth token does not meet scope requirement user:profile' })).toEqual(['oauth-scope-rejected', 1]);
    expect(await code({ status: 401, body: '' })).toEqual(['oauth-unauthorized', 1]);
    expect(await code({ status: 429, body: '{"type":"rate_limit_error"}' })).toEqual(['oauth-rate-limited', 1]);
    expect(await code({ status: 500, body: 'boom' })).toEqual(['oauth-server-error:500', 1]);
    expect(await code({ status: 200, body: 'not json' })).toEqual(['oauth-invalid-response', 1]);
    expect(await code(new Error('ECONNRESET'))).toEqual(['oauth-network-error', 1]);
  });
});

// ---------------------------------------------------------------- the reader (strategy chain)

describe('N2 readClaudeNativeUsage — chain, refresh boundary, secrets, no writes', () => {
  const base = (home: string, extra: Record<string, unknown> = {}) => ({
    env: { HOME: home }, now: () => NOW, runtime: 'app', resolveClaudeBinary: () => null, configPath: join(home, 'none.json'),
    credentials: { read: vi.fn(() => ({ ok: false, reason: 'not-found' })) }, ...extra,
  });

  it('auto: OAuth from the credentials file → ok reading, identity separate, attempts recorded', async () => {
    const home = homeWithCredentials();
    const { transport } = transportStub(() => json(USAGE_FIXTURE));
    const out = await readClaudeNativeUsage(base(home, { transport }));
    expect(out.reading).toMatchObject({ status: 'ok', source: 'native:claude', strategy: 'claude.oauth' });
    expect(win(out.reading, '5-hour limit')?.usedPercent).toBe(12.5);
    expect(out.identity).toMatchObject({ plan: 'Claude Max 5x' });
    expect(out.attempts).toEqual([{ strategy: 'claude.oauth', available: true, reason: null }]);
  });

  it('an expired access token ⇒ native:claude:needs-refresh and no network call', async () => {
    const home = homeWithCredentials(credentialsJSON({ expiresAt: NOW - 1000 }));
    const { transport } = transportStub(() => json(USAGE_FIXTURE));
    for (const sourceMode of ['auto', 'oauth']) {
      const out = await readClaudeNativeUsage(base(home, { transport, sourceMode }));
      expect(out.reading).toEqual({ status: 'unavailable', source: 'native:claude', reason: 'native:claude:needs-refresh', windows: [] });
    }
    const noExpiry = homeWithCredentials(credentialsJSON({ expiresAt: undefined }));
    const out = await readClaudeNativeUsage(base(noExpiry, { transport }));
    expect(out.reading.reason).toBe('native:claude:needs-refresh');
    expect(transport).not.toHaveBeenCalled();
  });

  it('a token without user:profile is refused before any request', async () => {
    const home = homeWithCredentials(credentialsJSON({ scopes: ['user:inference'] }));
    const { transport } = transportStub(() => json(USAGE_FIXTURE));
    const out = await readClaudeNativeUsage(base(home, { transport, sourceMode: 'oauth' }));
    expect(out.reading.reason).toBe('native:claude:oauth-missing-scope');
    expect(transport).not.toHaveBeenCalled();
  });

  it('auto: an OAuth failure falls back; cli and web are not-yet-ported, so the OAuth reason surfaces', async () => {
    const home = homeWithCredentials();
    const { transport } = transportStub(() => ({ status: 401, body: '' }));
    const out = await readClaudeNativeUsage(base(home, { transport }));
    expect(out.reading.reason).toBe('native:claude:oauth-unauthorized');
    expect(out.attempts).toEqual([
      { strategy: 'claude.oauth', available: true, reason: 'native:claude:oauth-unauthorized' },
      { strategy: 'claude.cli', available: false, reason: 'not-yet-ported' },
      { strategy: 'claude.web', available: false, reason: 'not-yet-ported' },
    ]);
    const web = await readClaudeNativeUsage(base(home, { transport, sourceMode: 'web' }));
    expect(web.reading.reason).toBe('native:claude:not-yet-ported');
  });

  it('runtime cli auto has no OAuth step at all (web → cli), so nothing is read', async () => {
    const home = homeWithCredentials();
    const { transport } = transportStub(() => json(USAGE_FIXTURE));
    const out = await readClaudeNativeUsage(base(home, { transport, runtime: 'cli' }));
    expect(out.reading.reason).toBe('native:claude:not-yet-ported');
    expect(transport).not.toHaveBeenCalled();
  });

  it('a selected account never falls through to ambient credentials, admin keys or the keychain', async () => {
    const home = homeWithCredentials();
    const readFile = vi.fn((p: string) => readFileSync(p, 'utf8'));
    const credentials = { read: vi.fn(() => ({ ok: true, value: ADMIN })) };
    const { transport } = transportStub(() => ({ status: 401, body: '' }));
    const env = { HOME: home, ANTHROPIC_ADMIN_KEY: ADMIN };
    const bad = await readClaudeNativeUsage(base(home, { env, readFile, credentials, transport, keychainReadConsent: true,
      resolveClaudeBinary: () => '/bin/claude', selectedAccount: { token: '  ' } }));
    expect(bad.reading.reason).toBe('native:claude:no-available-strategy');
    expect(bad.attempts).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
    expect(credentials.read).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();

    const oauth = await readClaudeNativeUsage(base(home, { env, readFile, credentials, transport, keychainReadConsent: true,
      selectedAccount: { token: 'sk-ant-oat01-SELECTED-xyz' } }));
    expect(oauth.reading.reason).toBe('native:claude:oauth-unauthorized');
    expect(oauth.attempts.map((a: { strategy: string }) => a.strategy)).toEqual(['claude.oauth']);
    expect(transport.mock.calls.every(([r]) => r.headers.Authorization === 'Bearer sk-ant-oat01-SELECTED-xyz')).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(credentials.read).not.toHaveBeenCalled();
  });

  it('the credential is never written: file bytes and mtime unchanged, no new files, keychain only read', async () => {
    const home = homeWithCredentials();
    const file = join(home, '.claude', '.credentials.json');
    const before = { text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs, listing: readdirSync(join(home, '.claude')) };
    const keychain = { read: vi.fn(() => ({ ok: false, reason: 'not-found' })) };
    for (const status of [200, 401]) {
      const { transport } = transportStub(() => (status === 200 ? json(USAGE_FIXTURE) : { status }));
      await readClaudeNativeUsage(base(home, { transport, credentials: keychain, keychainReadConsent: true }));
    }
    expect(readFileSync(file, 'utf8')).toBe(before.text);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(readdirSync(join(home, '.claude'))).toEqual(before.listing);
    expect(readdirSync(home)).toEqual(['.claude']);
    expect(Object.keys(keychain)).toEqual(['read']);
    // The module imports no fs writer at all: its only node:fs import is these three readers.
    const source = readFileSync(new URL('../dispatcher/usage-readers/natives/claude.mjs', import.meta.url), 'utf8');
    const fsImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)].map(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
    expect(fsImports).toEqual([['readFileSync', 'accessSync', 'constants']]);
    expect(source).not.toMatch(/from\s*'fs'|require\(|import\(\s*'node:fs/);
  });

  it('tokens never reach logs, reasons, attempts or the reading — even when the server echoes them', async () => {
    const home = homeWithCredentials();
    const logs: string[] = [];
    const log = (e: { message: string }) => { logs.push(JSON.stringify(e)); };
    const cases: ((r: Req) => Res)[] = [
      () => ({ status: 500, body: `bad token ${ACCESS} ${REFRESH}` }),
      () => ({ status: 403, body: `user:profile missing for ${ACCESS}` }),
      () => { throw new Error(`socket closed while sending ${ACCESS}`); },
    ];
    for (const answer of cases) {
      const { transport } = transportStub(answer);
      const out = await readClaudeNativeUsage(base(home, { transport, log }));
      const all = JSON.stringify(out) + logs.join('\n');
      expect(all).not.toContain(ACCESS);
      expect(all).not.toContain(REFRESH);
      expect(out.reading.status).toBe('unavailable');
    }
    expect(logs.length).toBeGreaterThan(0);
  });

  it('review pin: the default transport itself refuses in a test process (not merely a failed fetch)', async () => {
    await expect(defaultClaudeTransport({ url: 'https://api.anthropic.com/api/oauth/usage', method: 'GET', headers: {} }))
      .rejects.toThrow(/test process/);
  });

  it('review pin: a keychain record is never written back — a store offering writers sees only read', async () => {
    const store = { read: vi.fn(() => ({ ok: true, value: credentialsJSON() })), write: vi.fn(), delete: vi.fn(), set: vi.fn(), update: vi.fn() };
    const { transport } = transportStub(() => json(USAGE_FIXTURE));
    const out = await readClaudeNativeUsage(base(tempHome(), { transport, credentials: store, keychainReadConsent: true, sourceMode: 'oauth' }));
    expect(out.reading.status).toBe('ok');
    expect(store.read).toHaveBeenCalled();
    for (const w of [store.write, store.delete, store.set, store.update]) expect(w).not.toHaveBeenCalled();
  });

  it('review pin: explicit OAuth in the app is terminal on a 401 (shouldFallback L769-792)', async () => {
    const home = homeWithCredentials();
    const { transport } = transportStub(() => ({ status: 401, body: '' }));
    const out = await readClaudeNativeUsage(base(home, { transport, sourceMode: 'oauth' }));
    expect(out.attempts).toEqual([{ strategy: 'claude.oauth', available: true, reason: 'native:claude:oauth-unauthorized' }]);
  });

  it('default transport and default keychain refuse in a test process', async () => {
    const home = homeWithCredentials();
    const out = await readClaudeNativeUsage({ env: { HOME: home }, now: () => NOW, sourceMode: 'oauth', configPath: join(home, 'none.json') });
    expect(out.reading.reason).toBe('native:claude:oauth-network-error');
  });
});

// ---------------------------------------------------------------- Admin API (ClaudeAdminAPIUsageTests)

const COSTS = { data: [
  { starting_at: '2023-11-14T00:00:00Z', ending_at: '2023-11-15T00:00:00Z', results: [
    { currency: 'USD', amount: '12345.00', description: 'Claude Sonnet 4 Usage - Input Tokens', cost_type: 'tokens' },
    { currency: 'USD', amount: '2500.00', description: 'Web Search Usage', cost_type: 'web_search' }] },
  { starting_at: '2023-11-15T00:00:00Z', ending_at: '2023-11-16T00:00:00Z', results: [
    { currency: 'USD', amount: '5000', description: 'Claude Haiku Usage - Output Tokens', cost_type: 'tokens' }] },
], has_more: false, next_page: null };
const MESSAGES = { data: [
  { starting_at: '2023-11-14T00:00:00Z', ending_at: '2023-11-15T00:00:00Z', results: [
    { uncached_input_tokens: 1500, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 500 },
      cache_read_input_tokens: 200, output_tokens: 500, model: 'claude-sonnet-4-20250514' },
    { uncached_input_tokens: 100, output_tokens: 50, model: 'claude-opus-4-20250514' }] },
  { starting_at: '2023-11-15T00:00:00Z', ending_at: '2023-11-16T00:00:00Z', results: [
    { uncached_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 100, model: 'claude-sonnet-4-20250514' }] },
], has_more: false, next_page: null };
const ADMIN_NOW = 1_700_179_200_000;

describe('N2 Admin API step', () => {
  it('parses cost and messages usage into daily summaries', () => {
    const s = parseClaudeAdminSnapshot(COSTS, MESSAGES, { nowMs: ADMIN_NOW });
    expect(s.daily).toHaveLength(2);
    expect(s.daily[0].costUSD).toBeCloseTo(148.45, 10);
    expect(s.daily[0]).toMatchObject({ inputTokens: 1600, cacheCreationInputTokens: 1500, cacheReadInputTokens: 200, outputTokens: 550, totalTokens: 3850 });
    const reading = mapClaudeAdminUsage(s).reading;
    expect(reading.cost.used).toBeCloseTo(198.45, 10);
    expect(reading.details.last30DaysTokens).toBe(4450);
    expect(reading.details.topModel).toBe('claude-sonnet-4-20250514');
  });

  it('maps to a cost-only reading (no rate windows) with identity "Admin API"', () => {
    const s = parseClaudeAdminSnapshot(COSTS, MESSAGES, { nowMs: ADMIN_NOW });
    const { reading, identity } = mapClaudeAdminUsage(s);
    expect(reading).toMatchObject({ status: 'ok', source: 'native:claude', strategy: 'claude.admin-api', windows: [] });
    expect(reading.cost).toMatchObject({ limit: 0, currencyCode: 'USD', period: 'Last 30 days' });
    expect(identity).toEqual({ email: null, organization: null, accountId: null, plan: 'Admin API' });
  });

  it('current day is zero when history is stale; latest day is the newest bucket', () => {
    const s = parseClaudeAdminSnapshot(COSTS, MESSAGES, { nowMs: Date.parse('2023-11-17T12:00:00Z') });
    const d = mapClaudeAdminUsage(s).reading.details;
    expect(d.todayCostUSD).toBe(0);
    expect(d.todayTokens).toBe(0);
    expect(d.last7DaysCostUSD).toBeCloseTo(198.45, 10);
  });

  it('requests: cost_report then messages, x-api-key + anthropic-version, group_by per workspace option', async () => {
    for (const enabled of [false, true]) {
      const { transport, requests } = transportStub(() => json({ data: [] }));
      await fetchClaudeAdminUsage({ apiKey: ` ${ADMIN} `, workspaceSpendEnabled: enabled, transport, nowMs: Date.parse('2026-09-24T12:00:00Z') });
      expect(requests).toHaveLength(2);
      const [cost, messages] = requests.map(r => new URL(r.url));
      expect(cost.origin + cost.pathname).toBe('https://api.anthropic.com/v1/organizations/cost_report');
      expect(messages.origin + messages.pathname).toBe('https://api.anthropic.com/v1/organizations/usage_report/messages');
      expect(cost.searchParams.getAll('group_by[]')).toEqual(enabled ? ['description', 'workspace_id'] : ['description']);
      expect(messages.searchParams.getAll('group_by[]')).toEqual(['model']);
      expect(cost.searchParams.get('starting_at')).toBe('2026-08-25T00:00:00Z');
      expect(cost.searchParams.get('ending_at')).toBe('2026-09-25T00:00:00Z');
      expect(cost.searchParams.get('bucket_width')).toBe('1d');
      expect(cost.searchParams.get('limit')).toBe('31');
      for (const r of requests) {
        expect(r.headers).toMatchObject({ 'x-api-key': ADMIN, 'anthropic-version': '2023-06-01', Accept: 'application/json', 'User-Agent': 'CodexBar/1.0' });
      }
    }
  });

  it('workspace totals keep the organization total and are only reported when enabled', () => {
    const costs = { data: [
      { starting_at: '2026-09-23T00:00:00Z', ending_at: '2026-09-24T00:00:00Z', results: [
        { currency: 'USD', amount: '1250', description: 'Input tokens', workspace_id: 'wrk_fixture' },
        { currency: 'USD', amount: '250', description: 'Output tokens', workspace_id: 'wrk_fixture' },
        { currency: 'USD', amount: '50', description: 'Input tokens', workspace_id: null }] },
      { starting_at: '2026-09-24T00:00:00Z', ending_at: '2026-09-25T00:00:00Z', results: [
        { currency: 'USD', amount: '75', description: 'Input tokens', workspace_id: null }] }] };
    for (const enabled of [false, true]) {
      const s = parseClaudeAdminSnapshot(costs, { data: [] }, { nowMs: Date.parse('2026-09-24T12:00:00Z'), workspaceSpendEnabled: enabled });
      const { reading } = mapClaudeAdminUsage(s);
      expect(reading.cost.used).toBeCloseTo(16.25, 10);
      if (enabled) expect(reading.details.workspaceCosts).toEqual([{ name: 'wrk_fixture', costUSD: 15 }, { name: 'Default', costUSD: 1.25 }]);
      else expect(reading.details.workspaceCosts).toBeUndefined();
    }
  });

  it('the admin key resolves as a secure setting (env > keychain > file) and never leaks', async () => {
    const home = tempHome();
    const configPath = join(home, 'usage-readers.json');
    writeFileSync(configPath, JSON.stringify({ claude: { ANTHROPIC_ADMIN_KEY: 'sk-ant-admin01-FROM-FILE' } }));
    const credentials = { read: vi.fn((q: { service: string; account: string }) =>
      (q.service === 'ocli-usage-readers' && q.account === 'claude.ANTHROPIC_ADMIN_KEY' ? { ok: true, value: ADMIN } : { ok: false, reason: 'not-found' })) };
    const { transport, requests } = transportStub(r => (r.url.includes('cost_report') ? json(COSTS) : { status: 500, body: `echo ${ADMIN}` }));
    const logs: string[] = [];
    const out = await readClaudeNativeUsage({ env: { HOME: home }, configPath, credentials, transport, now: () => ADMIN_NOW,
      resolveClaudeBinary: () => null, log: (e: unknown) => logs.push(JSON.stringify(e)) });
    expect(out.attempts.map((a: { strategy: string }) => a.strategy)).toEqual(['claude.admin-api']);
    expect(requests[0].headers['x-api-key']).toBe(ADMIN);
    expect(out.reading.reason).toBe('native:claude:admin-api-error:messages:500');
    expect(JSON.stringify(out) + logs.join('')).not.toContain(ADMIN);

    const fromFile = transportStub(() => json({ data: [] }));
    await readClaudeNativeUsage({ env: { HOME: home }, configPath, credentials: { read: () => ({ ok: false, reason: 'not-found' }) },
      transport: fromFile.transport, now: () => ADMIN_NOW, resolveClaudeBinary: () => null });
    expect(fromFile.requests[0].headers['x-api-key']).toBe('sk-ant-admin01-FROM-FILE');

    const fromEnv = transportStub(() => json({ data: [] }));
    const ok = await readClaudeNativeUsage({ env: { HOME: home, ANTHROPIC_ADMIN_API_KEY: 'sk-ant-admin01-ENV' }, configPath, credentials,
      transport: fromEnv.transport, now: () => ADMIN_NOW, resolveClaudeBinary: () => null });
    expect(fromEnv.requests[0].headers['x-api-key']).toBe('sk-ant-admin01-ENV');
    expect(ok.reading).toMatchObject({ status: 'ok', strategy: 'claude.admin-api', windows: [] });
  });
});
