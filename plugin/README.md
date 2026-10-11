# ocli-monitor

**ocli (Orchestrated CLI):** run headless coding CLIs — Codex, opencode, Antigravity `agy`, Muse —
under one lead and watch them live in Claude Code as Workflow-style cards. This is the plugin half.

A Claude Code plugin that shows live developer-CLI runs from `dispatcher/dispatch.mjs` in a pane
named `ocli`. It reads the normalized live files `orchestra/live/<task>/<runId>.jsonl` (contract in
[`docs/LIVE-EVENTS.md`](../docs/LIVE-EVENTS.md)). It never reads `*.raw.jsonl`, never writes to the
live dir, and never spawns or owns a CLI process.

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
`claude plugin install ocli-monitor --marketplace <owner>/ocli`.

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

- **Spawns** one process, only on `/ocli-digest`: `node <plugin root>/bin/digest.mjs --root <project
  root>/orchestra` via `$.process.run`, 20 s timeout. Nothing else is ever run.
- **Reads** the live dirs (`liveDirs`, else `<project root>/orchestra/live`): `<task>/<runId>.jsonl`
  (never `*.raw.jsonl`, at most 500 per tick, none over 4 MiB) and `<task>/plan.json` (at most 64 KiB,
  dated within a day); `<project root>/checkpoints/YYYY-MM-DD_*.md` (plain names, at most 256 KiB);
  and this session's subagent list (`$.agent.list`).
  Each file only when its resolved `realPath` lies under the resolved dir it was listed from; symlinks
  are skipped and a path that moves during the read is dropped.
- **Never** uses the network, writes anything outside its own `$.state` (and the clipboard, on a
  `Copy` press), or submits a prompt on its own (`$.prompt.submit` runs only on a `Queue resume` press, with fixed text).

The project root is `$.session.root`; on some builds `$.session.root` is unavailable, and the plugin
falls back to the session cwd. Claude Code puts a plugin's `bin/` on the Bash tool's `PATH`; the two
files in `bin/` are plain modules, not executables.

## What it shows

One card per task (`orchestra/live/<task>/`), the task with the most recent activity first,
modelled on Claude Code's Workflow progress card:

```
╭──────────────────────────────────────────────╮
│ slice-046-cards                        4m12s │   task, total time (first start → last end, or now)
│ ocli · Running                               │   Running > Blocked > Failed > Stale > Completed
│ 4 runs · 131k tokens                         │   input + output summed; ? while none reported
│ Slice 046 cards                              │   the newest run's title
│ Phases                                       │
│ ▸ implement ●●● gpt-6-astra, glm-5.3     2/3 │   one dot per run, ended/total, the LLMs
│   ↳ tool.end bash: npm test                  │   a running run's latest event, always shown
│ ▸ review ● glm-5.3                       1/1 │
╰──────────────────────────────────────────────╯
```

The border and the status word take the task's colour; each dot its run's: running `suggestion`,
completed `success`, blocked or stale `warning`, failed / spawn-error / dispatch-error / any unknown
status `error`. Pressing a phase row (`▸`, a click or Enter under the focus) expands it (`▾`) to its
runs, each with its own lines: status glyph (`●` running, `◌` stale, `✓` completed, `⊘` blocked,
`✗` failed-like), the LLM and CLI, elapsed time, tool count, tokens `in/out`, the role; then the
title and worktree, then the latest event. What is expanded is kept in `$.state`, so a reload keeps
it. A press acts on what is drawn: a `▸` row opens, a `▾` row closes. A phase with more runs than
the row has room for shows its newest dots and `+K` for the rest; a long phase name is cut before
the dots and the LLM names are. Every surface's element table has `Button` (terminal, desktop, mobile, vscode), so the rows can
be pressed everywhere; a surface that could not press them would draw them collapsed.

Cards are never cut in the middle. A card that does not fit the pane closes its phases one at a
time, the one expanded first closing first, so the latest press stays open. If it is too tall even
closed (many phases, many running runs), it is drawn as its header:

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
node. An expanded run with findings gets a last line in `warning`, e.g.
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

A running run's live line leads with a heartbeat: a 10-cell event-rate sparkline (30 s bins, oldest
left), plus `xN` on the repeated call's own row once one call has repeated three times. Eight
identical calls (a `tool.start`, or a `tool.end` with no start open) with no successful matching end
mark the run as looping: its live line turns `warning` and one "may be looping" toast is shown, kept
in `$.state` so a reload does not repeat it. Nothing acts on the run.

## /ocli-digest

Runs the plugin's own `node <plugin root>/bin/digest.mjs --root <project root>/orchestra` (20 s
timeout) and draws what it prints, the last 12 hours per task and phase, in a pane named
`ocli-digest`, with a `Copy` button. Each line of the output is cleaned as every other untrusted
string is. A digest longer than the pane holds (or cut by the runtime) ends in a `… cut:` line,
since its last section, `Needs a decision`, is the one lost. It never submits a prompt and never
calls a model. When the script cannot run (no project root, no plugin root, `$.process` missing on
the runtime, a timeout, a non-zero exit) the command answers `ocli digest unavailable: <reason>`
and opens nothing.
`$.process.run`, `$.ui.copy` and `Markdown` are not yet proven on the 2.1.294 runtime: each is
called inside a try, and without `Markdown` the pane draws one `Text` per line.

`bin/digest.mjs` (with `bin/pane-label.mjs`) is a byte-identical copy of the repository's
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
