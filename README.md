<p align="center">
  <img src="assets/banner.png" alt="ocli — live, workflow-style progress for headless coding CLIs in Claude Code" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.1-8b5cf6" alt="Version 0.3.1">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js 20+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22d3ee" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/runtime%20deps-zero-0ea5e9" alt="Zero runtime dependencies">
  <a href="AGENTS.md"><img src="https://img.shields.io/badge/AI%20Agent-Native%20Ready-a78bfa" alt="AI Agent: Native Ready"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-475569" alt="macOS | Linux">
</p>

<p align="center">
  <code>claude-code</code> <code>claude-code-plugin</code> <code>codex</code> <code>opencode</code> <code>antigravity</code>
  <code>gemini</code> <code>muse</code> <code>coding-agents</code> <code>orchestration</code> <code>live-events</code>
</p>

**ocli** shows what your headless coding CLIs are doing while they do it. When Claude Code
orchestrates other agents (Codex, opencode, Antigravity `agy`, Muse) as background developers, each
one runs out of sight: you get a final message, or a stuck terminal, and nothing in between. ocli is
two small pieces: a **dispatcher** that runs one CLI per call and turns its native JSON event stream
into one normalized live-event file per run, and a **Claude Code plugin** that draws those runs as
Workflow-style cards with phases, status dots, token counts and the latest tool call, live.

## The card

```
╭──────────────────────────────────────────────╮
│ fix-parser                             4m12s │   task, total time
│ ocli · Running                               │   Running > Blocked > Failed > Stale > Completed
│ 4 runs · 131k tokens                         │   input + output, summed over runs
│ Fix the tokenizer edge cases                 │   the newest run's --title
│ Phases                                       │
│ ▸ implement ●●● glm-5.3, gpt-6-astra     2/3 │   one dot per run, ended/total, the LLMs
│   ↳ tool.end bash: npm test                  │   a running run's latest event
│ ▸ review ● muse-spark-1.3-contributor    1/1 │
╰──────────────────────────────────────────────╯
```

Press a phase row to expand it into its runs (status, LLM and CLI, elapsed time, tools, tokens,
worktree). Ended runs raise one toast each; the status line reads `ocli: N running`.

What else it does:

- **Declared phases.** `--declare-phases implement,review,merge` writes the task's plan before any run
  starts; the card draws every declared phase in order (pending ones dim) and counts `D/M phases`.
- **Honest scores.** `--verify` scores a run only when the CLI changed the work tree (file contents
  or `HEAD`): a green test suite on an untouched tree proves the base, not the developer.
- **Witness.** The CLI's closing claims ("all tests pass", "fixed", "committed abc1234") are checked
  against its own event trace. Unbacked claims show as `⚠ unwitnessed: …` on the run; they never
  change a score or status.
- **Night digest.** `/ocli-digest` (or `node dispatcher/digest.mjs`) summarizes the last 12 hours per
  task and phase: runs by status, scored passes against unscored runs, tokens, witness findings, and
  what needs a decision.
- **Heartbeat and loop warning.** A running run's live line leads with a 10-cell event-rate sparkline
  (30 s bins) and `xN` once one call repeats; eight identical calls with no success turn it
  warning-coloured and raise one "may be looping" toast. Nothing acts on the run.
- **Resume card** (optional). In a project that keeps dated checkpoint files, the first card shows the
  newest one's phase table, next action and resume command, with a `Queue resume` button.

## Quick start

**1. Install the plugin** (in a terminal session of Claude Code):

```sh
/plugin install ocli-monitor --marketplace <owner>/ocli
```

or from a shell: `claude plugin install ocli-monitor --marketplace <owner>/ocli`.

**2. Get the dispatcher and make the policy yours** (Node.js 20+, no dependencies):

```sh
git clone https://github.com/<owner>/ocli.git
cp ocli/dispatcher/policy.example.json ocli/dispatcher/policy.json
```

This step is not optional in practice. The example routes pin the models they were verified with,
which your accounts may not have: set each route's `model` to one your CLI lists (`opencode models`,
`codex` model list, …), read [Permissions and sandboxing](#permissions-and-sandboxing), and dispatch
each route once by hand before you trust it. Without a `policy.json` the dispatcher uses the example.

**3. Keep the run files out of git.** The dispatcher writes full prompts, raw CLI transcripts and
stdout/stderr tails into your project; add these lines to the project's `.gitignore` first:

```gitignore
orchestra/
.orchestra-last.md
```

**4. Dispatch a run** from your project root, so the live files land where the pane looks:

```sh
node /path/to/ocli/dispatcher/dispatch.mjs \
  --role implement --task fix-parser \
  --phase implement --title "Fix the tokenizer edge cases" \
  --prompt "$(cat brief.md)" --verify "npm test"
```

To show the whole plan before the first run, declare the phases (this writes
`orchestra/live/<task>/plan.json` and spawns nothing):

```sh
node /path/to/ocli/dispatcher/dispatch.mjs --declare-phases implement,review,merge --task fix-parser
```

**5. Open the pane:** `/ocli`. It also opens itself at session start when the terminal is wide.
`/ocli-digest` opens the night digest in its own pane (see [Limitations](#limitations) for where it
runs).

**6. Optional: the resume card.** If your project keeps dated checkpoint files,
`<project root>/checkpoints/YYYY-MM-DD_<slug>.md` with a Markdown table that has `Phase` and `Status`
columns (plus, optionally, a `## Next action` paragraph and a `## Resume` section whose first backtick
span is the resume command), the pane's first card shows the newest one. Without a `checkpoints/` dir
there is simply no card.

| flag | meaning |
|---|---|
| `--role` | a route in the policy (`implement` = opencode, `reason` = codex, `breadth` = agy, `muse` = Muse) |
| `--task` | groups runs into one card; `[A-Za-z0-9][A-Za-z0-9._-]*` |
| `--prompt` | the brief; passed as one argv element, never through a shell |
| `--phase` | the card phase this run belongs to (default: the role) |
| `--title` | what the run is for (default: the prompt's first line) |
| `--root` | the workspace the CLI works in (default: cwd) |
| `--verify` | a shell command run after the CLI; its exit code becomes `score` 1/0 |
| `--suffix` | per-run text appended last, so the shared prompt prefix stays cache-stable |
| `--parent` | the record id of the run this one continues |
| `--declare-phases` | with `--task` only: write the task's plan (comma-separated phase names) and exit |

Exit codes: `0` the run was recorded (whatever the CLI's own exit code), `1` `--verify` failed,
`2` the dispatcher refused, could not start the CLI, or failed after it ran. A run that left the work
tree as it was (contents and `HEAD`) gets `score: null` even when `--verify` passes, whatever its exit
code: a green base says nothing about the developer.

`ORCHESTRA_LIVE_DIR=<dir>` moves the live root away from `<cwd>/orchestra/live`; point the
plugin's `liveDirs` option at the same absolute dir.

## Permissions and sandboxing

A headless CLI cannot answer a permission prompt, so the example routes pass each CLI's own
no-prompt flags. **Only the codex routes run inside a sandbox.** A git worktree (`--root`) is where a
CLI works, not a security boundary: an agent without approvals and without a sandbox can read and
write anything your user can, use the network, and push with your git credentials.

| route | CLI | approval | OS sandbox | shipped status |
|---|---|---|---|---|
| `reason`, `easy` | codex | n/a (`exec`) | yes: `-s workspace-write` confines writes to `{root}` | `ok` / `unverified` |
| `implement` | opencode | off: `--auto` approves everything | none | `ok` |
| `muse` | Muse | off: `--disable-approval`, `--user-input-auto-resolve` | Muse's own, unless a wrapper injects `--yolo` | `ok` |
| `breadth` | agy | off: `--dangerously-skip-permissions` | none, and not confined to `{root}` | `unverified` |

Run the unsandboxed routes only where that is acceptable: a disposable VM or container, or a
dedicated user account without your credentials. `breadth` ships `unverified` for that reason; the
dispatcher refuses it until you set `"status": "ok"` in your own `policy.json`.

## How it works

```
 Claude Code (lead)                                  Claude Code (pane)
        │                                                    ▲
        │ node dispatcher/dispatch.mjs --role … --phase …    │ ocli-monitor plugin
        ▼                                                    │ polls every 2 s, folds by (task, runId, seq)
 ┌──────────────┐  argv, stdin closed  ┌──────────────┐      │
 │ dispatch.mjs │ ───────────────────▶ │  codex exec  │      │
 │              │ ◀─── JSON lines ──── │  opencode run│      │
 │  events.mjs  │      on stdout       │  agy / muse  │      │
 │  normalize() │                      └──────────────┘      │
 └──────┬───────┘                                            │
        │ append, 0600                                       │
        ├──▶ orchestra/live/<task>/<runId>.jsonl  ───────────┘   normalized events (v1)
        ├──▶ orchestra/live/<task>/<runId>.raw.jsonl             every raw line, for evidence
        └──▶ orchestra/tree/<task>.jsonl                         one record per finished run
```

- **One file per run.** Concurrent runs of the same task never share a file; `seq` is contiguous
  and `run.end` is written exactly once, also on Ctrl-C, `SIGTERM` or a closed terminal.
- **Quota claims are checked.** A transcript that merely quotes "rate limit" is not a refusal.
  When the provider exposes a usage counter (codex), the dispatcher reads it before and after the
  run and marks the run `blocked` only when the counter or the CLI's own error event confirms it.
- **Unknown stays unknown.** No verifier means `score: null`, no token report means `null`, never 0.
- **Claims are witnessed, not trusted.** `witness.mjs` compares the CLI's final message with its
  own `tool.end` trace (edits, test runs, commits) and records findings such as `staleGreen` or
  `doneNoChange` on the tree record and on `run.end`.
- **Untrusted text is defused.** Titles, phases and every string the pane draws have ANSI escapes,
  control and bidi characters stripped; only contract fields are read; symlinks and files over
  4 MiB are skipped.

The full contract, including how another dispatcher can write compatible files, is in
[`docs/LIVE-EVENTS.md`](docs/LIVE-EVENTS.md).

## Repository layout

| path | what |
|---|---|
| `.claude-plugin/marketplace.json` | marketplace listing the `ocli-monitor` plugin |
| `plugin/` | the Claude Code plugin (pane, hooks, types, its own tests) |
| `dispatcher/` | `dispatch.mjs`, `events.mjs` (normalizer), `witness.mjs` (claims vs trace), `digest.mjs` (night digest), `usage.mjs` (codex usage reader), `policy.example.json` |
| `docs/LIVE-EVENTS.md` | the normalized live-event contract |
| `tests/` | dispatcher, normalizer, witness and digest tests (vitest), with one real capture per CLI |

## Tests

```sh
npm install && npm test              # dispatcher + normalizer (vitest is the only devDependency)
claude plugin test plugin            # the plugin's own tests, in Claude Code's plugin test runner
claude plugin validate .             # the marketplace manifest only
claude plugin validate plugin        # the plugin manifest, types and hooks
```

## Limitations

- **Claude Code 2.1.294** (the version this was built and tested on) has no `$.ui.notify` and no
  `$.session.root`. A blocked run therefore lands as a toast, not a system notification, and the
  default live dir is resolved from the session cwd.
- **Desktop app:** the pane is a terminal mod surface. In the desktop app it appears only after the
  plugin was installed from a terminal session (or loaded with `CLAUDE_CODE_PLUGIN_DIRS`), and where
  no terminal is bound, toasts are not sent.
- **Error shapes are partly source-derived.** Successful runs of all four CLIs are captured in
  `tests/fixtures/`. Codex `turn.failed`, opencode `error`, agy non-`SUCCESS` results and Muse
  terminal events other than `completed` are mapped from the CLIs' sources, not from captures.
- **Usage counters:** only codex exposes one locally. For opencode, agy and Muse a quota refusal is
  recognized from the CLI's own error event or from stderr on a failed run, and the record says the
  verdict is unconfirmed.
- **`/ocli-digest` needs a checkout.** It runs the plugin's own `../dispatcher/digest.mjs`, never a
  script from your project. A marketplace install caches `plugin/` alone, so there it answers
  `ocli digest unavailable`; load the plugin with `--plugin-dir /path/to/ocli/plugin` for the pane, or
  run `node /path/to/ocli/dispatcher/digest.mjs` from the project root.
- **CLI flags drift.** The argv in `policy.example.json` is what each CLI accepted when it was
  verified; re-probe a route after upgrading a CLI.

## License

[MIT](LICENSE) © 2026 Enes Öztürk
