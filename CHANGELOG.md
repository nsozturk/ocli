# Changelog

All notable changes to ocli. Versions follow [semver](https://semver.org); pre-releases are marked.

## 0.6.0-beta.1

Quota-aware routing, resumable hand-offs, and a starter config that runs with two CLIs.

### Added

- **Quota-aware routing: `--role auto --size S|M|L`.** After the AA-index gates, `quota.mjs` decides
  `run`, `split` (the slice only fits smaller) or `wait` (nothing has room until a reset) against the
  provider plans and the recorded tree. `split`/`wait` print one JSON line and exit `3`; `--dry-run`
  shows the decision from the tree alone. `--size` is also recorded on every node.
- **Provider plans** (`dispatcher/plans.mjs`, strict schema v1): caps come from
  `ORCHESTRA_PLANS`, `~/.config/agent-rules/provider-plans.json` or the shipped example, never from a
  hardcoded table. A counter pool stops at `100 − reservePercent` on every window it reports.
- **WIP hand-off.** A failed, blocked, provider-stopped or signalled run commits what it left as
  `wip(<task>): <reason>` (never on the default branch, never bypassing hooks) and records a
  `handoff` on its node. On a signal the CLI is stopped, the hand-off runs within its budget, and a
  `partial: true` node is written before the signal is re-raised.
- **`--continue <nodeId>`** resumes a hand-off in its worktree with a fixed continuation note placed
  after `--suffix`, so the prompt prefix stays cache-stable; the node records `continuedFrom`.
- **`--worktree auto`**: one worktree per task at `<repo>.worktrees/<task>` on branch `ocli/<task>`,
  created or reused, never merged, removed or forced.
- **Built-in usage readers, ported from CodexBar** (MIT © Peter Steinberger): plan usage for the
  providers your routes use, read without any extra app; raw responses kept locally in
  `~/.config/ocli/data/raw_usage.sqlite` with secrets stripped. A pool without a reading runs `until-stop`.
  Providers: codex, claude, antigravity, zai, muse, cline. Needs Node.js 22.13+ (`node:sqlite`); browser
  cookies are read on macOS only.
- **Quota card** in the pane: per-provider 5-hour and weekly use (binding window bold), reset time,
  `OK` / `STOP` / `?` chips with `until`, scoped Argon/Flash sub-rows, stale dimming after 30 minutes,
  a `setup` line for unavailable readers, and a `quota:` line on each task card. Fed by
  `<live dir>/usage/latest.json`, which the dispatcher writes after every live reading (atomic, merged
  per provider, scrubbed of identity, secrets and home paths). The pane never runs a reader.
- **Usage doctor**: `node dispatcher/usage.mjs [--json]` prints every developer's quota and, where a
  reader cannot read, which setting is missing (env var, `ocli-usage-readers` Keychain service or
  config key). Claude Code's keychain item is read only with explicit consent (default off).
- **Scoped limit buckets** (`limitScopes` in the provider plans): a bucket that belongs to one model
  family (Argon's own weekly bucket) stops only that family's routes, not the whole pool.
- **`breadth-flash`**: agy on Gemini 3.8 Flash high, the explicit seat for simple work while Argon is
  out of quota; never rotated, ships `unverified` like `breadth`.
- **Claude Code as a developer**: `opus` (Opus 5.5 medium, in the rotation) and `opus-high` (high,
  explicit) routes on `claude -p --output-format stream-json`, mapped into the live contract, with
  `acceptEdits` and one `--allowedTools` list instead of a bypass flag.
- **Full final text on the node** (up to 64 KiB, UTF-8 safe); pane events stay at 500 characters.
- **Provider window stops** for Muse ("Subscription quota exhausted … resets"), alongside Cline Pass and Z.ai.
- `ORCHESTRA_POLICY`, `ORCHESTRA_PLANS` and `ORCHESTRA_RANKING_FILE` overrides; per-window usage
  deltas (5-hour and weekly apart) and summed `tokens` on every node.
- CI (`.github/workflows/test.yml`): `npm ci && npm test` on Ubuntu and macOS, Node 22 and 24, and the
  plugin job on macOS (`claude plugin validate` + `claude plugin test plugin`, Claude Code 2.1.309 from npm).
- `SECURITY.md`: the threat model of running agents headless, and private vulnerability reporting.

### Changed

- **Starter config.** `dispatcher/policy.example.json` and `dispatcher/provider-plans.example.json`
  now ship only codex and opencode (plus the claude lead pool). Every other route moved to
  `dispatcher/policy.full-roster.json` / `provider-plans.full-roster.json`.
- **The codex default (`reason`) is GPT-6.1 Sol at `xhigh`**, with a Sol/Terra/Luna fallback chain;
  GPT-6 Astra is its own `astra` route at `max`, outside the rotation.
- The shipped AA ranking (`model-ranking.example.json`) was refreshed (adds GPT-6.1 Sol).

### Fixed

- `tokens.metered` over-counted codex: its input already includes cached tokens and its output
  includes reasoning. Metered tokens are now computed per CLI, and quota recomputes them at read time.

- The hand-off pathspec excludes `node_modules` symlinks, and the first porcelain status line keeps
  its leading space (a modified file's path was cut).
- Two load-timed tests (the hanging-hook signal test and the 205-file hand-off cap test) wait long
  enough on a busy CI runner.

## 0.5.1

- A failed run whose CLI error event says the plan window is used up (Cline Pass, Z.ai) records a
  dated `providerStop`; `--list-routes` and `--role auto` skip that billing pool until the reset.

## 0.5.0

- Cline (Cline Pass) as a developer CLI. Routes carry their Artificial Analysis Intelligence Index;
  `--list-routes` and `--role auto [--min-aa N]`.

## 0.4.0

- The card opens in place with one block per run; History card; spaced cards.
