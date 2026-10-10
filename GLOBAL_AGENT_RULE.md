## ocli — dispatching headless coding CLIs with live progress

When you (the lead agent in Claude Code) hand a slice of work to another coding CLI (Codex,
opencode, Antigravity `agy`, Muse), dispatch it through ocli so the person sees it live in the
`/ocli` pane:

```sh
node <ocli>/dispatcher/dispatch.mjs --role <implement|reason|breadth|muse> --task <task-slug> \
  --phase <implement|review|...> --title "<what this run is for>" \
  --root <worktree> --prompt "$(cat <brief.md>)" [--verify "<test command>"]
```

Rules:

1. Run it from the project root (live files go to `<cwd>/orchestra/live`, which the pane watches).
2. One `--task` per piece of work, so its runs share one card; use `--phase` to separate
   implementation, review and fix rounds.
3. Give every developer CLI its own worktree via `--root`.
4. Read the final message on stdout; exit 0 = recorded, 1 = verifier failed, 2 = refused/errored.
5. `blocked` means the provider refusal was confirmed; do not report a quota outage from transcript
   text alone.
6. A route whose policy `status` is not `ok` is refused; probe it by hand before enabling it.

Contract for the live files: `<ocli>/docs/LIVE-EVENTS.md`.
