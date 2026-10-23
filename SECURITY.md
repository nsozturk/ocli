# Security

ocli runs other coding agents for you, headless, with their approval prompts turned off. That is the
point of it, and it is also the main risk. Read this before you dispatch anything.

## The threat model in one paragraph

A headless CLI cannot answer a permission prompt, so every shipped route passes that CLI's own
no-prompt flag. The developer CLI then runs with **your user's permissions**: it can read and write any
file you can, run commands, use the network, and push with your git credentials. **The git worktree you
give it (`--root`, `--worktree auto`) is where it works, not a security boundary.** The worktree is the
only confinement ocli itself provides; real confinement has to come from the CLI's own sandbox or from
where you run it.

## Route by route

| route | CLI | what is turned off | sandbox |
|---|---|---|---|
| `reason`, `astra`, `easy` | codex | n/a: `codex exec` does not prompt | **yes**: `-s workspace-write` confines writes to `{root}` (reads and network are not confined) |
| `implement` | opencode | `--auto`: every permission request is approved | none |
| `muse` | Muse | `--disable-approval`, `--user-input-auto-resolve`; a wrapper that injects `--yolo` also turns Muse's own OS sandbox off | Muse's own, unless `--yolo` |
| `breadth`, `breadth-flash` | agy (Antigravity) | `--dangerously-skip-permissions` | none, and not confined to `{root}` |
| `opus`, `opus-high` | Claude Code | `--permission-mode acceptEdits`: file edits apply unasked | none; everything outside one `--allowedTools` list (read-only git, `git add/commit`, test commands, `cp/ls/mkdir`) still prompts and is denied headless |
| `cline-*` | Cline (Cline Pass) | act-mode auto-approve | none |

`breadth`, `breadth-flash` and `easy` ship `"status": "unverified"`: the dispatcher refuses them until you mark them
`ok` in your own `dispatcher/policy.json`.

## Rules

1. **Never point a dispatch at a checkout that holds secrets.** No `.env` with live keys, no cloud
   credentials, no signing keys, no production config in the worktree, and none reachable from it.
   A CLI that can read the tree can send what it reads to its provider.
2. **Run the unsandboxed routes somewhere disposable**: a VM, a container, or a dedicated user account
   without your SSH keys, git credentials and browser sessions.
3. **Keep the run files out of git.** `orchestra/live/` holds full prompts and every raw CLI line,
   `orchestra/tree/` holds prompts, final texts and stdout/stderr tails, and `.orchestra-last.md` is
   the last message. Add `orchestra/` and `.orchestra-last.md` to your project's `.gitignore`. The
   dispatcher writes the live and raw files owner-only (0600).
4. **Keep secrets out of briefs.** The pane shows the opening of `--prompt` (or `--brief`) to anyone who
   can see your terminal, and the tree keeps it.
5. **Probe a new or upgraded route by hand** before you set it `ok`: CLI flags drift between versions,
   and a flag that silently stops meaning "headless" can stall or, worse, widen what the CLI may do.

## What ocli itself touches

- **Usage readers read your browser cookies, Keychain items and your CLIs' OAuth tokens, locally.**
  To show plan usage, ocli's built-in readers (ported from CodexBar) use the sessions you already
  have: the OAuth token files of your CLIs, cookies from your browsers, items in your Keychain, and
  `codex app-server` with codex's own login. They never ask you for a credential.
  - A credential is sent nowhere except that provider's own usage endpoint.
  - Secrets never reach logs, tree nodes, live files, the pane or any report: nodes carry usage
    windows only.
  - Account identity (email, plan, org) stays only in the raw store, `~/.config/ocli/data/raw_usage.sqlite`
    (local, secrets stripped before a response is written).
  - Where CodexBar delegates an OAuth token refresh to the owning CLI instead of refreshing the
    token itself, the port keeps that safeguard, so ocli never rotates a token behind your CLI's back.
  - **Claude Code's keychain item is read only with your consent, and default OFF**:
    `OCLI_CLAUDE_KEYCHAIN_CONSENT=1`, or `{ "claude": { "keychainReadConsent": true } }` in the config. It is read, never
    written. Without consent the claude reader reports what is missing and reads nothing.
  - API keys you give the readers (Z.ai, Cline, Muse) live where you put them: an env var, the
    config file, or the macOS Keychain service `ocli-usage-readers`. `node dispatcher/usage.mjs` says
    which setting is missing; it never prints a value or an account identity.
  - `OCLI_DISABLE_KEYCHAIN=1` turns every Keychain read off.
  - Live-verified in this beta (macOS): the codex and antigravity readers. The claude, zai (glm),
    cline and muse readers need a setting first (consent or an API key) and are not live-verified;
    the cursor reader is not ported. `node dispatcher/usage.mjs` says what each one is missing.
  - Settings: environment variables first, then `~/.config/ocli/usage-readers.json`
    (`OCLI_USAGE_READERS_CONFIG` names another file).
- The plugin (`ocli-monitor`) reads only the live dirs, `plan.json` and dated checkpoint files, skips
  symlinks, strips ANSI/control/bidi characters from everything it draws, makes no network calls, and
  submits a prompt only when you press `Queue resume`. Details: "What it runs and reads" in the README.
- The dispatcher passes argv as an array with stdin closed: a prompt never reaches a shell.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository
(private vulnerability reporting). Do not open a public issue for it. Include the version
(`package.json`), the route and CLI involved, and the smallest reproduction you have.
