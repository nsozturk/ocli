# Live-event contract (v1)

The dispatcher (`dispatcher/dispatch.mjs`) writes one normalized live file per run. The
`ocli-monitor` plugin reads nothing else. Any program that writes files to this contract shows up in
the pane: you do not need this dispatcher to use the plugin.

## File layout

```
<live root>/<task>/<runId>.jsonl       normalized events, one JSON object per line   (this contract)
<live root>/<task>/<runId>.raw.jsonl   every raw CLI line: {"at","stream","line"}     (never read by the plugin)
```

- **Live root.** `<cwd>/orchestra/live` by default, where `cwd` is the dispatcher's working
  directory (normally the project root). `ORCHESTRA_LIVE_DIR=<dir>` moves it. The plugin watches
  `<project root>/orchestra/live` unless its `liveDirs` option lists other absolute dirs.
- **`task`** matches `[A-Za-z0-9][A-Za-z0-9._-]*`: no `/`, no leading `.` or `-`. The dispatcher
  rejects anything else before it touches the disk.
- **`runId`** is a fresh UUID per run, so concurrent runs of the same task never share a file.
- **Mode `0600`.** Both files are created owner-only (they can hold prompts and absolute paths).
  Directories are created with `mkdir -p` semantics.
- **Append-only.** Lines are appended, never rewritten. A reader may see a torn last line while a
  run is being written; the plugin skips any line that does not parse and reads it again next tick.

## Envelope

Every line is one JSON object with these fields, then the fields of its kind:

| field | type | meaning |
|---|---|---|
| `v` | `1` | contract version; a reader ignores any other value |
| `runId` | string | equals the file name without `.jsonl` |
| `seq` | integer ≥ 0 | per-run sequence number, see ordering |
| `at` | ISO-8601 string | the dispatcher's receipt time, **not** the CLI's own timestamp |
| `task` | string | equals the directory name |
| `role` | string | the policy route that ran (`implement`, `reason`, …) |
| `cli` | string | `codex`, `opencode`, `agy`, `muse`, … |
| `kind` | string | one of the kinds below |

The plugin folds a line into a run only when its `runId` is the file name and its `task` is the
directory name. A line that names another run is ignored.

## Kinds

| kind | fields | notes |
|---|---|---|
| `run.start` | `model`, `root`, `parentId`, `pid`, `title`, `phase` | the first line, `seq: 0` (unless that write failed). `pid` is `null` when spawn threw. `title`: `--title`, else the prompt's first non-empty line, at most 120 code points. `phase`: `--phase`, else the role, at most 40 code points. Both have ANSI escapes, control and bidi characters removed. `root` is the absolute workspace; the pane shows only its last segment. |
| `step` | `label` | lifecycle marks: CLI-native ones (`thread.started`, `turn.started`, `init`, `step_start`, …) and the dispatcher's own: `cli.exit code=<n> signal=<s>`, `verify.start`, `verify.end code=<n>` |
| `message` | `text` | assistant text. The last one is the run's final answer. |
| `warn` | `text` | a warning or an error the **CLI itself** emitted (never model-authored text) |
| `tool.start` | `tool`, `detail` | a tool call began (not every CLI reports starts) |
| `tool.end` | `tool`, `detail`, `ok` | `ok` is `true`, `false`, or `null` when the CLI gives no verdict |
| `usage` | `input`, `output`, `cached`, `reasoning` | token counts; each is a number or `null` (unknown, never `0`). Sum them per run. |
| `unparsed` | `line` | a stdout line that is not a JSON object, first 500 characters |
| `run.end` | `exitCode`, `signal`, `ms`, `status`, `nodeId`, `score`, `dropped` | exactly once, last. `dropped` maps CLI event types the normalizer did not translate to counts (at most 50 keys, then `__other__`). |

`text`, `detail` and `line` are cut at 500 characters. Unknown kinds must be ignored by readers.

### `run.end.status`

| status | meaning |
|---|---|
| `completed` | the CLI exited 0 and nothing marked the run blocked |
| `failed` | the CLI exited non-zero, or the dispatcher was killed by `SIGINT`/`SIGTERM`/`SIGHUP` (then `signal` is set and `exitCode` is `null`) |
| `blocked` | the provider refused the run (quota / rate limit), confirmed by its usage counter or by the CLI's own error event |
| `spawn-error` | the CLI could not be started (not installed, not executable) |
| `dispatch-error` | the dispatcher itself threw after the CLI ran (usage read, verifier, tree write); `exitCode` still carries the CLI's exit code |

Before `run.end` arrives a reader shows the run as `running`; the plugin shows a running run whose
last event is more than 10 minutes old as `stale`. A reader treats any other status string as
`failed`. `score` is `1` or `0` when a `--verify` command ran, otherwise `null` (unknown, not zero). It is
also `null` when the CLI never started (`spawn-error`: the verifier is skipped) and when a `failed` or
`blocked` run left the work tree as it was: a verifier passing on an untouched tree scores the base, not
the run.

## Ordering guarantees

- `seq` starts at `0` and is contiguous within a run: it advances only after a line was written, so
  a failed write never leaves a gap (the event is lost and counted in the dispatcher's
  `eventWriteErrors` instead).
- `run.start` is first and `run.end` is last, exactly once, also when the dispatcher is interrupted
  by a signal. (A `SIGKILL` cannot be caught: that run stays `running`, then `stale`.)
- `cli.exit` is written as soon as the CLI exits, before the usage read and the verifier, so a
  finished CLI does not look busy while the verifier runs.
- Events are written while the CLI runs, in the order its stdout lines arrive. UTF-8 split across
  chunks is reassembled; CR and empty lines are kept in the raw file.
- Readers deduplicate by `(task, runId, seq)`: a `seq` at or below one already folded is skipped,
  so reading the same file twice changes nothing.

## Writing compatible files from another dispatcher

1. Pick a task name matching the pattern above and a fresh UUID; create
   `<live root>/<task>/<runId>.jsonl` with mode `0600`.
2. Write `run.start` with `seq: 0` as soon as the process is spawned.
3. For each thing worth showing, append one line with the next `seq` and your receipt time in `at`.
   Map your tool's events onto the kinds above; leave anything you cannot map out rather than
   guessing, and count it in `run.end.dropped`.
4. Always write `run.end` last, including on errors and signals (a `finally` block plus signal
   handlers). A run without `run.end` shows as running, then stale.
5. Keep untrusted text short and plain. The plugin strips ANSI escapes and control characters at
   ingest anyway, and never renders more than the contract fields.

A minimal valid run:

```jsonl
{"v":1,"runId":"0b9c…","seq":0,"at":"2026-01-01T12:00:00.000Z","task":"fix-parser","role":"implement","cli":"mytool","kind":"run.start","model":"m","root":"/repo","parentId":null,"pid":4242,"title":"Fix the parser","phase":"implement"}
{"v":1,"runId":"0b9c…","seq":1,"at":"2026-01-01T12:00:03.000Z","task":"fix-parser","role":"implement","cli":"mytool","kind":"tool.end","tool":"bash","detail":"npm test","ok":true}
{"v":1,"runId":"0b9c…","seq":2,"at":"2026-01-01T12:00:09.000Z","task":"fix-parser","role":"implement","cli":"mytool","kind":"run.end","exitCode":0,"signal":null,"ms":9000,"status":"completed","nodeId":null,"score":null,"dropped":{}}
```

## Per-CLI sources

The normalizer is `dispatcher/events.mjs`; `tests/fixtures/orchestra-events/` holds one real
capture per CLI. Codex `turn.failed`/`error` events, opencode `error` events, agy non-`SUCCESS`
results and muse terminal events other than `run.terminal.completed` are mapped from the CLIs'
source or binaries, not from captures: they are marked `unverified` in the code.
