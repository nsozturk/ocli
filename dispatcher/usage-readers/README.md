# Usage readers

`node dispatcher/usage.mjs` (add `--json` for a machine-readable `setup` object) reads every developer's quota. When a reader
is unavailable it prints a `setup:` hint: the setting it needs and where it may come from. Values are never printed.

## Usage readers: credentials

| Provider | Unavailable reason | What it needs | Where it may come from |
|---|---|---|---|
| claude | `native:claude:credentials-not-found` | consent to read Claude Code's keychain item (read-only, never written; default OFF) | env `OCLI_CLAUDE_KEYCHAIN_CONSENT=1`, or `usage-readers.json` `{ "claude": { "keychainReadConsent": true } }` |
| claude (consent given) | `native:claude:credentials-not-found` | Claude Code has no stored credential | run `claude` once and sign in |
| claude (consent given) | `native:claude:credentials-keychain-access-revoked` | keychain access to Claude Code's item was denied | re-allow it in Keychain Access, or unset the consent |
| glm | `plugin:secret-access` | `Z_AI_API_KEY` | env `Z_AI_API_KEY`; keychain service `ocli-usage-readers` account `zai.Z_AI_API_KEY`; config `{ "zai": { "Z_AI_API_KEY": "..." } }` |
| cline | `plugin:secret-access` | `CLINE_API_KEY` | env `CLINE_API_KEY`; keychain account `clinepass.CLINE_API_KEY`; config `{ "clinepass": { "CLINE_API_KEY": "..." } }` |
| muse | `plugin:authentication-expired` | a fresh Muse Code login, stored as `MUSE_DEVICE_TOKEN` | env `MUSE_DEVICE_TOKEN`; keychain account `muse.MUSE_DEVICE_TOKEN`; config `{ "muse": { "MUSE_DEVICE_TOKEN": "..." } }` |

Store a keychain secret (macOS prompts for the value because `-w` comes last; do not paste it into a shell line):

    security add-generic-password -s ocli-usage-readers -a zai.Z_AI_API_KEY -w
    security add-generic-password -s ocli-usage-readers -a clinepass.CLINE_API_KEY -w
    security add-generic-password -s ocli-usage-readers -a muse.MUSE_DEVICE_TOKEN -w

The config file is `~/.config/ocli/usage-readers.json` (override with env `OCLI_USAGE_READERS_CONFIG`).
