# Quota cards — the pane shows each provider's limits (user request 2026-10-23)

User: "kartlarda kota/limit göstergesiyle başlayalım." The in-house usage readers (0.6) read every provider's
5h / weekly windows, but nothing outside the tree keeps the latest reading, and the pane never shows quota.

## Measured (lead map, ocli main 3d429c9)
- Pane entry `plugin/hooks/register.tsx` (ticks every 2 s via `$.clock.every`, no watchers), cards built in
  `plugin/hooks/reduce.ts` (`card()` ~533, `cardVariants` ~607, `fitCards` ~692, Resume card `checkpointCard` ~784,
  History `historyCard` ~669). Data: live dirs = `options.liveDirs` else `<session root>/orchestra/live`; `scan()`
  reads `<dir>/<task>/<runId>.jsonl` + `<task>/plan.json`; `readUnder` keeps reads under the listed dir.
- `tests/plugin-paths.test.ts`: the plugin reaches nothing outside `plugin/` (no ~/.config, no home paths).
- Dispatcher: readings live only in tree nodes (`usageBefore`/`usageAfter`/`providerStop`); `decideByQuota`'s live
  refresh is in memory only; `dispatcher/usage.mjs` (`runUsageCli`) writes nothing.

## Part A — snapshot writer (dispatcher; mirrored to senatus orchestra/ afterwards)
File: `<live root>/usage/latest.json` where live root = the dispatcher's live dir (the same root the pane scans;
dispatch.mjs resolves it). Written atomically (temp file in the same dir + rename), mode 0644 (no secrets in it).
Schema v1:
```json
{ "v": 1, "writtenAt": "ISO",
  "providers": {
    "<codex|claude|glm|gemini|muse|cline>": {
      "readAt": "ISO", "status": "ok|unknown|unavailable", "source": "native:codex|plugin:zai|lead|…",
      "reason": "short reason or null",
      "windows": [{ "limitId": "…", "usedPercent": 0, "windowDurationMins": 300, "resetsAt": "ISO|null" }],
      "gate": { "state": "ok|stop|unknown", "reason": "…", "headroomPercent": 95,
                "window": { "limitId": "…", "windowDurationMins": 10080, "usedPercent": 39, "resetsAt": "ISO|null" } | null },
      "routes": [{ "role": "breadth", "model": "gemini-4-argon-high",
                   "gate": { "state": "stop", "reason": "…", "window": { "limitId": "…", … } | null } }],
      "stop": { "until": "ISO", "reason": "…" } | null,
      "setup": "one short line: which setting is missing (no value)" | null } } }
```
- `gate.window` = the window the gate actually binds on (gateFor's scoped window for that provider / route model),
  copied at the gate seam, never re-derived; null when the gate binds none (unknown / until-stop / uncapped).
  The pane bolds `gate.window`, and a gate STOP's `until` is `gate.window.resetsAt`.
- `routes` only for providers with scoped buckets (Q19); `stop` = the active provider stop from the tree (latestProviderStop).
- Identity (email/org/account), secrets and absolute home paths NEVER appear (filter at the writer seam; test it).
- Merge, don't clobber: each write updates only the providers it read now and keeps the others with their own
  `readAt` (so a codex-only refresh keeps the gemini entry).
- Writers: `runUsageCli` (every run), and dispatch.mjs every time it obtains a live reading (the `--role auto`
  refresh, usageBefore, usageAfter) and when it records a provider stop. A write failure never fails a dispatch.
- `--dry-run` writes nothing.

## Part B — pane (plugin/)
1. Read `<live dir>/usage/latest.json` each tick through the existing `readUnder` (size cap 64 KiB, skip unchanged by
   size:mtime like scan()). A malformed / missing file ⇒ no Quota card, never a crash.
2. **Quota card** first in the pane (above the Resume card): one row per provider in a fixed order (codex, claude,
   glm, gemini, muse, cline): name, a compact bar + `5h NN%` and `wk NN%` (the binding window bold), reset as
   relative time (`resets 2h10m`), a state chip OK / STOP / ? (unknown) using the pane's existing status colours; a
   STOP row shows `until HH:MM`. Scoped routes (gemini) get sub-rows `argon high/medium STOP · flash OK`. A `setup`
   line is shown dim under an unavailable provider. Stale: `readAt` older than 30 min ⇒ dim row + `stale 2h`.
   Collapsible like other cards (head row ▸/▾), state remembered like the others.
3. **Task cards:** the newest run's route provider gets one line in the card head area: `quota: gemini flash OK ·
   wk 39%` (or `STOP until …`). Only when the snapshot has that provider.
4. Narrow panes: follow the existing `cardVariants`/`fitCards` fallbacks (drop bars first, then sub-rows).
5. No new process, no network, no read outside the live dirs; `tests/plugin-paths.test.ts` stays green.

## Tests
- A (vitest, tests/usage-snapshot.test.ts): schema; atomic write; merge keeps other providers; identity/secret/home
  path never written (fixture reading carrying an email + token); dispatch writes on refresh and on a provider stop
  (stub readers, temp live dir); --dry-run writes nothing; write failure does not fail the run. Mutations: clobber
  instead of merge; identity passed; dry-run writes.
- B (`claude plugin test plugin`, plugin/hooks/*.test.ts with the existing harness): Quota card rows from a fixture
  snapshot; STOP chip + until; scoped sub-rows; stale dimming; setup line; malformed file ⇒ no card; task-card quota
  line; narrow variant. Mutations: stale threshold ignored; binding window not bold; malformed file throws.
