# ocli-monitor

**ocli (Orchestrated CLI):** run headless coding CLIs — Codex, opencode, Antigravity `agy`, Muse —
under one lead and watch them live in Claude Code as Workflow-style cards. This is the plugin half.

A Claude Code plugin that shows live developer-CLI runs from `dispatcher/dispatch.mjs` in a pane
named `ocli`. It reads the normalized live files `orchestra/live/<task>/<runId>.jsonl` (contract in
[`docs/LIVE-EVENTS.md`](../docs/LIVE-EVENTS.md)). It never reads `*.raw.jsonl`, never writes to the
live dir, and never spawns or owns a CLI process.

## Changes

- **0.5.0** — Cline (Cline Pass) is a developer CLI: its `--json` stream (tool calls, usage, final text, errors) feeds the cards like the others. The dispatcher records each route's Artificial Analysis Intelligence Index (`aa`), lists routes by it (`--list-routes`) and can pick by it (`--role auto [--min-aa N]`).
- **0.4.0** — The card's head is the toggle: it opens the card in place, with one block per run
  saying what the run was asked (`run.start.brief`, new and optional in the live contract), where it
  works, what it is doing and how it ended; the closed card keeps one line per phase (parts joined
  with ` · `, `N/M done`) and each running run's live line. Cards are spaced apart. Finished cards
  get an `×`, and Completed ones a `Move completed to history` button, that move them to a History
  card (never automatically), kept per project across sessions. Phase rows are no longer pressable.

## Requirements

Claude Code ≥ 2.1.292 (mods need ≥ 2.1.287 in the terminal, ≥ 2.1.286 in the Desktop app) and
Node.js ≥ 22 on `PATH` for `/ocli-digest`.

## Install

From a local clone of the repository:

```sh
claude plugin marketplace add /path/to/ocli    # registers the marketplace "ocli"
claude plugin install ocli-monitor@ocli
```

or `claude plugin install ocli-monitor --marketplace /path/to/ocli`. Once published:
`claude plugin install ocli-monitor --marketplace nsozturk/ocli`.

For development, load it from a checkout instead:

```sh
claude --plugin-dir /path/to/ocli/plugin
# or, for sessions started by the desktop app or an SDK host:
export CLAUDE_CODE_PLUGIN_DIRS=/path/to/ocli/plugin
```

`/ocli` opens the pane. The pane also opens itself at session start: wide terminals place it
right away, and narrower ones keep it waiting until you run `/ocli`.

## Options (`userConfig`)

| field | default |
|---|---|
| `liveDirs` | empty → `<project root>/orchestra/live` |

`liveDirs` is a comma-separated list of absolute paths. Relative entries are ignored. For a
`--plugin-dir` load, set it in settings under `pluginConfigs["ocli-monitor"].options`, or from `/config`.

## What it runs and reads

- **Spawns** one process, only on `/ocli-digest`: `node <plugin root>/lib/digest.mjs --root <project
  root>/orchestra` via `$.process.run`, 20 s timeout. Nothing else is ever run.
- **Reads** the live dirs (`liveDirs`, else `<project root>/orchestra/live`): `<task>/<runId>.jsonl`
  (never `*.raw.jsonl`, at most 500 per tick, none over 4 MiB) and `<task>/plan.json` (at most 64 KiB,
  dated within a day); `<project root>/checkpoints/YYYY-MM-DD_*.md` (plain names, at most 256 KiB);
  and this session's subagent list (`$.agent.list`).
  Each file only when its resolved `realPath` lies under the resolved dir it was listed from; symlinks
  are skipped and a path that moves during the read is dropped.
- **Never** uses the network, writes anything outside its own `$.state` and `$.store` (the History
  list only; and the clipboard, on a `Copy` press), or submits a prompt on its own (`$.prompt.submit` runs only on a `Queue resume` press, with fixed text).

The project root is `$.session.root`; on some builds `$.session.root` is unavailable, and the plugin
falls back to the session cwd. The bundled scripts live in `lib/`, not `bin/`, so the plugin adds
nothing to the Bash tool's `PATH`.

## What it shows

One card per task (`orchestra/live/<task>/`), the task with the most recent activity first,
modelled on Claude Code's Workflow progress card:

```
╭──────────────────────────────────────────────────────────╮
│ ▸ fix-parser                                       4m12s │   ▸/▾ opens it in place; total time; × once ended
│ ocli · Running                                           │   Running > Blocked > Failed > Stale > Completed
│ 4 runs · 131k tokens                                     │   input + output summed; ? while none reported
│ Fix the tokenizer edge cases                             │   the newest run's title
│ Phases                                                   │
│   implement  ●●●  glm-5.3, gpt-6-astra · 2/3 done        │   one dot per run, the LLMs, ended/total
│     ▁▁▂▃▁▅▇█▃▂ ↳ tool.end bash: npm test                 │   a running run's sparkline and last action
│   review  ●  muse-spark-1.3-contributor · 1/1 done       │
╰──────────────────────────────────────────────────────────╯
```

The border and the status word take the task's colour; each dot its run's: running `suggestion`,
completed `success`, blocked or stale `warning`, failed / spawn-error / dispatch-error / any unknown
status `error`. Each card has a blank row under it. A phase row is one line, its parts joined with
` · `: its runs' dots, `⚠N` for runs whose claims are unwitnessed and `⟳N` (in `warning`) for runs
that may be looping, the LLM names, the cache ratio, `N/M done`. Under it, each running run keeps one
glanceable line: its sparkline and last action (ended runs have none in the closed card). A phase with more runs than the row has room for shows its
newest dots and `+K` for the rest; a long phase name is cut before the dots and the LLM names are.

Pressing the card's head (`▸ <task>`, a click or Enter under the focus) opens the card in place
(`▾`); pressing it again closes it. Open, each phase row is followed by one block per run:

```
╭──────────────────────────────────────────────────────────╮
│ ▾ fix-parser                                       2m10s │
│ ocli · Running                                           │
│ 2 runs · 131k tokens                                     │
│ Phases                                                   │
│   implement  ●●  gpt-6-astra, glm-5.3 · 1/2 done         │
│   ✓ completed · gpt-6-astra (codex) · reason · 1m02s     │   one block per run, under its phase
│     RK0 tokenizer tests · Add the missing edge cases…    │   the brief: what the run was asked
│     end: completed · exit 0 · score 1 · verify passed    │   how it ended
│   ● running · glm-5.3 (opencode) · implement · 2m10s     │
│     RK1 catalogue adapter · Write the catalogue adapter  │   --brief, else heading · task paragraph · --suffix
│     for the GLM route and its tests. · SLICE: RK1 only   │
│     in /work/wt-rk1 · parent 3f2a9c                      │   where it works, what it continues
│     12 tools · tokens in 120k · out 4k · cached 98k      │
│     ▁▁▂▃▁▅▇█▃▂ ↳ tool.start bash: npm test               │   what it is doing now
│     ✓ edit: src/adapter.ts                               │   its last tool calls (✓ ok, ✗ failed)
│     says: Writing the adapter now.                       │   its latest message
╰──────────────────────────────────────────────────────────╯
```

Each block: the status glyph and word (`●` running, `◌` stale, `✓` completed, `⊘` blocked, `✗`
failed-like), the LLM and CLI, the role and elapsed time; the brief (`run.start.brief`: `--brief`,
else the prompt's first heading, its first task paragraph and the `--suffix` without its worktree
path; the title for an older dispatcher), up to three lines; the whole workspace path and the parent node; tools, warnings and
tokens; while running, the live line; the last five tool calls; the latest message, up to two lines;
the last three warnings; unwitnessed claims; once ended, exit code, score and the `--verify` verdict.
Every field is cleaned at ingest and cut to the pane's width. What is open is kept in `$.state`, so
a reload keeps it. A press acts on what is drawn: a `▸` head opens, a `▾` head closes. Every
surface's element table has `Button` (terminal, desktop, mobile, vscode), so heads can be pressed
everywhere.

Cards are never cut in the middle. An open card that does not fit is drawn in a compact form (one
brief and message line, no tool calls or warnings), then closed; when two open cards do not both
fit, the one opened first closes first, so the latest press stays open. If a card is too tall even
closed (many phases), it is drawn as its header:

```
╭──────────────────────────────────────────────╮
│ slice-046-cards                        4m12s │
│ ocli · Running                               │
│ 25 runs · 131k tokens                        │
│ 25 phases · pane too short to list them      │
╰──────────────────────────────────────────────╯
```

A card that does not fit even as its header is left out, and the smaller cards after it still get
their turn; what was left out is summed in one `+N more tasks · subagents hidden` line.
Below the task cards, "Claude subagents" is a card of its own, filled from `$.agent.list()` (this
session's subagents and teammates; workflow agents are not listed). The footer shows how many dirs
are watched, the last tick time and the error count.

### History

A card whose runs have all ended (`Completed`, `Failed` or `Blocked`, and no run running or stale)
has an `×` on its head; pressing it moves the card to the **History** card at the bottom of the
pane, closed by default (`▸ History  N`). Open, it lists the moved cards newest first (task, status,
runs, tokens, span and when it was moved, in local time), each with a `restore` button that puts it
back. `Move completed to history`, at the top of the pane while any Completed card qualifies, moves
every Completed card at once; Failed and Blocked cards keep their own `×`. Nothing is ever moved
automatically: a finished card stays until you press. The runs are read again at the press, so a
card whose task started running meanwhile is not moved. A moved card comes back on its own when one
of its runs has a newer event (a new run of the task).

History is per project: each entry carries its scope, the dirs the pane watches, and only the
current scope's entries hide cards, draw or are restored. It is a snapshot per (scope, task) in
`$.state`, mirrored to `$.store` (the plugin's own JSON file under the Claude Code configuration
dir), so it outlives the session. On load the stored list is merged under what `$.state` holds; a
read that fails is retried the next tick, and nothing is written to `$.store` before a read
succeeded. Read back, every entry is checked and cleaned (times within a Date's range, `runs` a
count, entries without a scope dropped), one per (scope, task), at most 100.

### Phases: `--phase`

A run's phase comes from the dispatcher:

```sh
node dispatcher/dispatch.mjs --role implement --task slice-046-cards --phase implement --prompt "$(cat brief.md)"
node dispatcher/dispatch.mjs --role reason --task slice-046-cards --phase review --prompt "$(cat review.md)"
```

`--phase` is cleaned like `--title` (escapes, control and bidi characters removed, whitespace
folded) and cut at 40 characters. Without it, or when it is empty, the phase is the role, and runs
written before phases existed are grouped by their role too.

### Declared phases: `--declare-phases`

The whole plan can be declared before any run starts, so the card shows how much is left:

```sh
node dispatcher/dispatch.mjs --declare-phases implement,review,mutate,merge --task slice-047
```

This writes `orchestra/live/<task>/plan.json` (`{v: 1, phases: [{name}], declaredAt}`, atomically,
owner-only); it spawns nothing and records nothing in the tree. Names are cleaned like `--phase`,
deduped and capped at 50; declaring again replaces the plan. The card then draws the declared phases
first, in order: one with no run yet is a dim `declared` row with `0/0`. Phases that were not
declared still show, after them. The count row adds `D/M phases`, where a phase is done once it has
a run and none of its runs is running or stale, and M counts the undeclared phases too; when the row
is too narrow for all of it, `D/M phases` moves to its front, so it is never the part cut. A plan with
no run yet is a card of its own (`ocli · Declared`, no border colour), placed by the plan's mtime
(a future mtime counts as the moment it was read). A plan over 64 KiB, older than a day or dated more
than a day ahead, a link, or one naming no phase is not used; a malformed one costs one footer error
per change of the file. Deleting `plan.json` takes the declared rows away; a dir that cannot be listed
for a tick keeps the plan last read. The dispatcher writes the plan through a random temp name opened
exclusively, so a link planted in the live dir is refused, never written through.

### Unwitnessed claims

The dispatcher checks a CLI's closing claims against its own event trace (`dispatcher/witness.mjs`)
and puts the finding codes on `run.end` as `witness: {findings: [...]}`; the text stays in the tree
node. A run with findings gets a line in `warning` in the open card, above its end line, e.g.
`⚠ unwitnessed: claimedTestsButNone, staleGreen`, and its phase row says `⚠N` for the N such runs.
Codes are cleaned and capped (10, 40 characters each); any other shape of `witness` is ignored. A
finding is a hint for the review, never a status: it changes no score, colour or count.

### Resume card: the project's checkpoint

Optional: this card exists only for a project that keeps dated checkpoint files with a phase table;
without a `checkpoints/` dir there is no card and no error.

The first card is the project's checkpoint, from `<project root>/checkpoints/YYYY-MM-DD_*.md` (the
root as for the live dir: `$.session.root`, then `$.session.cwd`, whatever `liveDirs` says; on some
builds `$.session.root` is unavailable and the session cwd is used, so skipping the card when
`liveDirs` is set would never draw it). Of the ten newest files (by the date in the name, then by mtime) it takes the first with a
resume command, else the first that parses at all: a notes file, or a feature checkpoint a merge
touched later, does not displace the lead's checkpoint. A newer checkpoint with its own resume command
does. It is read on the first tick, every 30th after it (about once a minute) and on the tick the
session moves to another project, whose card then replaces the old one at once (no root: no card).
An unchanged listing is not read again.

The card shows the file name and `done/total`, one row per phase of the first table with `Phase` and
`Status` columns (`#n phase · status`: done green, running blue, blocked yellow), `next:` (the first
paragraph under the last `##`/`###` `Next action`, `Next exact action` or `Next actions` heading not
marked superseded: checkpoints append, so the last is the live one) and `resume:` (the first backtick
span under the last `##`/`###` `Resume…` heading). A row that says `running` while neither a live
event nor a write of the checkpoint came for 30 minutes adds `checkpoint says running, no live event
or checkpoint write for Nm`. Any live run counts, even one unrelated to the running phase. A pane too
short for the phase rows draws the card without them; shorter still, the "more" line says
`checkpoint hidden`.

`Queue resume` (drawn when there is a resume command) submits one fixed prompt, never automatically:
`Read <root>/checkpoints/<name> first, then git status, then continue from the first phase that is
not done.` Only the file name enters it, and only a plain one (`[A-Za-z0-9._-]+.md`); no checkpoint
text does. A root that is not plain (a run of spaces, a control character, over 400 characters) is
never put in it: the press toasts to resume by hand. When the submit fails, a toast carries the same
text to copy. No checkpoints dir, or one that is a link or resolves outside the root, is no card and no
error. A checkpoints dir or file that cannot be statted, listed or read keeps the card last drawn and
costs one error per load (about a minute) until it reads; a file refused by the realPath guard costs
one error per change of the listing.

The status line reads `ocli: N running` while any run is running. A run that ends gets one toast;
when more than three end in one tick, `blocked` ones go first and the rest become one
`ocli: +N more runs ended` toast.
A `blocked` run tries `$.ui.notify` first and falls back to a toast. On the 2.1.294 runtime
`$.ui.notify` does not exist, and where no terminal is bound (the desktop) nothing is sent. Ends
that were already there at the first tick are not announced, and a reload never repeats an
announcement (the record of announced runs lives in `$.state`).

In the open card, a running run's live line leads with a heartbeat: a 10-cell event-rate sparkline
(30 s bins, oldest left), plus `xN` on the repeated call's own row once one call has repeated three
times. Eight identical calls (a `tool.start`, or a `tool.end` with no start open) with no successful
matching end mark the run as looping: its live line turns `warning`, its phase row says `⟳N`, and one
"may be looping" toast is shown, kept in `$.state` so a reload does not repeat it. Nothing acts on
the run.

## /ocli-digest

Runs the plugin's own `node <plugin root>/lib/digest.mjs --root <project root>/orchestra` (20 s
timeout) and draws what it prints, the last 12 hours per task and phase, in a pane named
`ocli-digest`, with a `Copy` button. Each line of the output is cleaned as every other untrusted
string is. A digest longer than the pane holds (or cut by the runtime) ends in a `… cut:` line,
since its last section, `Needs a decision`, is the one lost. It never submits a prompt and never
calls a model. When the script cannot run (no project root, no plugin root, `$.process` missing on
the runtime, a timeout, a non-zero exit) the command answers `ocli digest unavailable: <reason>`
and opens nothing.
`$.process.run`, `$.ui.copy` and `Markdown` are not yet proven on the 2.1.294 runtime: each is
called inside a try, and without `Markdown` the pane draws one `Text` per line.

`lib/digest.mjs` (with `lib/pane-label.mjs`) is a byte-identical copy of the repository's
`dispatcher/digest.mjs`, kept equal by a test, so a marketplace install, which caches `plugin/`
alone, has it too. `node /path/to/ocli/dispatcher/digest.mjs` run from the project root prints the
same digest.

## Safety

Everything read from a live file is treated as untrusted CLI output:

- ANSI escapes and control characters are stripped at ingest, so nothing drawn, toasted or
  notified can carry a terminal escape.
- Only known contract fields are read.
- A file speaks only for its own run: from `<task>/<runId>.jsonl`, only lines whose `runId` is the
  file name and whose `task` is the dir name are folded, and a run is identified by `<task>/<runId>`.
  A CLI that writes into another run's own file directly is not stopped (the reader cannot tell).
- At most 500 live files are considered per tick; the rest are skipped and counted in the pane.
- `run.end.dropped` is kept as a single total; its CLI-controlled keys are never stored.
- A file is read only if its resolved `realPath` lies under the resolved live dir. Symlinks are
  skipped. The path is resolved again after the read and the text is dropped if it moved; a swap
  and a swap back within one read is not caught, since `$.fs.read` has no no-follow open.
- A dir that cannot be listed costs one error per tick and does not stop the other dirs.
- `/ocli-digest` is the one place the plugin runs code, and it runs only the script beside the
  plugin (`$.plugin.root`), never one from the session's project: a project that carries its own
  `dispatcher/digest.mjs` never has it executed; only its `orchestra/` dir is read, as data (`--root`).
- A checkpoint is read under the same realPath guard, only if it is a plain dated `.md` of at most
  256 KiB; every cell and line of it is cleaned before it is drawn.
- Files over 4 MiB are not read and are marked "too large". The engine refuses any `$.fs.read`
  over 4 MiB anyway.

## Tests

```sh
claude plugin validate plugin
claude plugin test plugin   # not via a shell alias that adds flags before `plugin`
```

`hooks/fixtures.ts` is generated by the repository's `tools/gen-fixtures.mjs <live file>` (outside
`plugin/`, never shipped), which passes the four
raw CLI captures in `tests/fixtures/orchestra-events/` through the real `normalize`. It also
includes one real normalized GLM live file with its paths sanitized. The plugin test environment
has no Node, so `normalize` cannot be imported there.
