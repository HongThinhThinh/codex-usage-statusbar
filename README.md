# Codex Usage & Reset (Local)

Shows Codex quota (5h and 7d windows), reset times in Vietnam time (UTC+7), and color-coded usage directly in the VS Code status bar.

- Reads quota through `codex app-server` with a persistent connection, so updates are realtime.
- Watches `auth.json` and clears old values when you switch accounts.
- Never sends a model turn, so it does not consume quota.

## Install (one command)

Requirements: VS Code, Node.js 18+, the `code` command in PATH, and a signed-in Codex (OpenAI ChatGPT extension or Codex app).

```bash
git clone https://github.com/HongThinhThinh/codex-usage-statusbar.git
cd codex-usage-statusbar
npm run install:local
```

Then run `Developer: Reload Window` in VS Code.

On a machine where the repo is already cloned, run `git pull && npm run install:local`.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `localCodexUsage.codexExecutablePath` | `auto` | Auto-detects the Codex app, the `openai.chatgpt-*` extension under `~/.vscode` or `~/.cursor`, then `codex` on PATH. Set an absolute path only if detection picks the wrong binary. |
| `localCodexUsage.refreshIntervalSeconds` | `5` | `0` disables background polling. |
| `localCodexUsage.statusBarIcon` | `dashboard` | `none` hides the icon. |

The `CODEX_HOME` environment variable is respected when locating `auth.json` (default `~/.codex`).

## Test

```bash
npm test
```

`test/realtime.cjs` needs a real Codex binary. If `codex` is not on PATH:

```bash
CODEX_EXECUTABLE="/path/to/codex" npm test
```

## Command Palette

- `Codex Quota: Refresh`
- `Codex Quota: Show Details`
- `Codex Quota: Set Refresh Interval`
- `Codex Quota: Open Settings`
- `Codex Quota: Open Usage Page`
