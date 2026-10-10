# ocli-monitor

A Claude Code plugin that shows live developer-CLI runs from `dispatcher/dispatch.mjs` in a pane
named `ocli`. It reads the normalized live files `orchestra/live/<task>/<runId>.jsonl` (contract in
[`docs/LIVE-EVENTS.md`](../docs/LIVE-EVENTS.md)). It never reads `*.raw.jsonl`, never writes to the
live dir, and never spawns or owns a CLI process.

## Install

In a terminal session of Claude Code:

```sh
/plugin install ocli-monitor --marketplace <owner>/ocli
```

or from a shell: `claude plugin install ocli-monitor --marketplace <owner>/ocli`.

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

The status line reads `ocli: N running` while any run is running. A run that ends gets one toast;
when more than three end in one tick, `blocked` ones go first and the rest become one
`ocli: +N more runs ended` toast.
A `blocked` run tries `$.ui.notify` first and falls back to a toast. On the 2.1.294 runtime
`$.ui.notify` does not exist, and where no terminal is bound (the desktop) nothing is sent. Ends
that were already there at the first tick are not announced, and a reload never repeats an
announcement (the record of announced runs lives in `$.state`).

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
- Files over 4 MiB are not read and are marked "too large". The engine refuses any `$.fs.read`
  over 4 MiB anyway.

## Tests

```sh
claude plugin validate plugin
claude plugin test plugin   # not via a shell alias that adds flags before `plugin`
```

`hooks/fixtures.ts` is generated by `tools/gen-fixtures.mjs <live file>`, which passes the four
raw CLI captures in `tests/fixtures/orchestra-events/` through the real `normalize`. It also
includes one real normalized GLM live file with its paths sanitized. The plugin test environment
has no Node, so `normalize` cannot be imported there.
