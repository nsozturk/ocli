# AGENTS.md — ocli

Contract for coding agents (Claude Code, Codex, Gemini CLI / Antigravity, opencode, Cursor, Muse)
working in this repository or using it to dispatch other CLIs.

## What this repo is

- `dispatcher/dispatch.mjs` runs ONE headless coding CLI per call and writes normalized live events.
- `dispatcher/events.mjs` is the pure normalizer: CLI JSON line → zero or more contract events.
- `dispatcher/usage.mjs` reads codex's usage counter (`codex app-server`, `account/rateLimits/read`).
- `dispatcher/witness.mjs` is pure: checks a CLI's closing claims against its own `tool.end` trace.
- `dispatcher/digest.mjs` is the read-only night digest of `orchestra/tree` and `orchestra/live`.
- `plugin/` is the Claude Code plugin `ocli-monitor` that draws the live files as cards.
- `plugin/lib/digest.mjs` and `plugin/lib/pane-label.mjs` are byte-identical copies of the
  `dispatcher/` files, so an installed plugin never reaches outside its folder. After editing either
  source run `cp dispatcher/digest.mjs dispatcher/pane-label.mjs plugin/lib/`;
  `tests/plugin-paths.test.ts` fails while they differ.
- `docs/LIVE-EVENTS.md` is the contract between the two. Change it and both sides together.

## Running a dispatch

```sh
node dispatcher/dispatch.mjs --role <route> --task <task> --prompt "<brief>" \
  [--phase <card phase>] [--title <one line>] [--root <workspace>] [--verify "<cmd>"] \
  [--suffix <per-run text>] [--parent <recordId>] [--brief <what the person reads in the pane>]
node dispatcher/dispatch.mjs --declare-phases implement,review,merge --task <task>   # plan only, no run
node dispatcher/digest.mjs [--since <ISO>] [--json 1]                                # last 12 hours
```

- Run it from the project root: live files go to `<cwd>/orchestra/live/<task>/<runId>.jsonl`
  (override: `ORCHESTRA_LIVE_DIR`), tree records to `<cwd>/orchestra/tree/<task>.jsonl`. Both hold
  full prompts and transcripts: the project must gitignore `orchestra/` and `.orchestra-last.md`.
- The pane shows the opening of `--prompt` (its first heading and task paragraph) unless `--brief` is
  given: keep secrets out of it.
- The policy is `ORCHESTRA_POLICY`, else `dispatcher/policy.json`, else `dispatcher/policy.example.json`
  (the starter: `implement` = opencode, `reason` = codex GPT-6.1 Sol xhigh). Every other route ocli
  knows (agy Argon/Flash, Muse, Claude Opus medium/high, Astra, Cline Pass) is in `dispatcher/policy.full-roster.json`.
  Provider plans likewise: `provider-plans.example.json` (codex, glm, claude) or `.full-roster.json`.
- Non-interactive by construction: stdin is closed, argv is an array (no shell), and every route's
  argv carries the CLI's own headless/auto-approve flags.

### Exit codes

| code | meaning |
|---|---|
| 0 | the run finished and was recorded (whatever the CLI's own exit code was) |
| 1 | `--verify` ran and failed (`score: 0`) |
| 2 | the dispatcher refused or failed: bad arguments, unknown or non-`ok` route, unknown argv placeholder, the CLI could not be started (`spawn-error`; the verifier is skipped), or an error after the CLI ran (`run.end.status: dispatch-error`) |

A run that left the work tree as it was (git status, `HEAD` and file contents before the CLI vs
before the verifier, the dispatcher's own files excluded) is `score: null` even when `--verify`
passes, whatever its exit code. Witness findings (`run.end.witness.findings`) are hints for review,
never a status.

The final assistant message is printed on stdout; diagnostics (`[dispatch] …`) go to stderr,
including the live file path and a summary line with `eventWriteErrors`.

### Run statuses (`run.end.status`)

`completed` · `failed` · `blocked` (provider refusal confirmed) · `spawn-error` (CLI not
startable) · `dispatch-error` (dispatcher threw after the run). See `docs/LIVE-EVENTS.md`.

## Operational truths

- A route whose `status` is not `"ok"` is refused. Probe a route once by hand before marking it ok.
- A transcript containing "rate limit" is not a refusal. Only the provider's counter (codex) or
  the CLI's own error event confirms `blocked`; anything else is labelled unconfirmed.
- Per-CLI facts that bite (details in the route `_notes` of `policy.full-roster.json`):
  - **agy** ignores the cwd (`--add-dir {root}`), times out at 5 min by default
    (`--print-timeout`), and ends its print-mode session when the model decides to wait on a long
    command. Give it file-local verification.
  - **opencode** needs `--auto` headless and `--dir {root}`, or relative paths land in `$HOME`.
  - **codex** may stop with a scope question (exit 0, no changes); answer it and re-dispatch.
  - **muse** runs with approvals off (`--disable-approval`) and with its OS sandbox off too if a
    wrapper injects `--yolo`. It hangs if stdin stays open.
  - **claude** (`opus`, `opus-high`): the prompt must come right after `-p` (`--add-dir` and
    `--allowedTools` are variadic and swallow a trailing prompt); `--output-format stream-json` needs
    `--verbose`; edits apply under `acceptEdits`, everything else is limited to one `--allowedTools` list.
- **Approvals are off on every non-codex route** (`--auto`, `--disable-approval`,
  `--dangerously-skip-permissions`, claude `acceptEdits`). Only codex (`-s workspace-write`) has a
  sandbox; a worktree is not one (see `SECURITY.md`). Run the others in a disposable VM, container or dedicated user account. The `breadth`
  (agy) route ships `unverified` for this reason.
- Run each developer CLI in its own worktree (`--root`); concurrent runs never share a live file.

## Working on this repo

- Tests: `npm ci && npm test` (vitest, `tests/`; the suites run on the full-roster files), `claude plugin test plugin`, `claude plugin validate .`
  (marketplace manifest) and `claude plugin validate plugin` (plugin manifest, types, hooks).
  The plugin tests import `claude-code/testing` and run only under `claude plugin test`.
- `plugin/hooks/fixtures.ts` is generated by `node tools/gen-fixtures.mjs <live file>`
  from `tests/fixtures/orchestra-events/*.jsonl` through the real `normalize()`; regenerate it after
  changing `events.mjs`, and check the result for personal paths before committing.
- New CLI event mappings: add a real capture to `tests/fixtures/orchestra-events/` first. A mapping
  derived from source rather than a capture is marked `unverified` in a comment.
- Never weaken a test to make it pass; mutate a clause and confirm a test fails before trusting it.
