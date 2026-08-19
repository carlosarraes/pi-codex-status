# pi-codex-status

A [Pi coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that displays OpenAI Codex and OpenCode Go usage.

## What it shows

### OpenAI Codex

- Account info (model, email, plan type)
- Banked usage reset count and each available reset's expiry in local time
- Rate limit usage with color-coded progress bars (green/yellow/red)
- Reset times for each rate limit window (hourly, weekly, etc.)

### OpenCode Go

- Rolling, weekly, and monthly usage remaining
- Local reset time for every usage window

## Install

```
pi install git:github.com/carlosarraes/pi-codex-status
```

Requires `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` >= 0.80.8.

## Usage

```
/status
/status codex
/status opencode-go
/status ogo
```

`/status` opens Codex by default. Press Tab or Shift+Tab to switch providers.

Codex requires an OpenAI Codex login through Pi's `/login` command.

OpenCode Go uses `OPENCODE_API_KEY` when set, then falls back to the `opencode-go` entry in OpenCode's local `auth.json`.

Interactive mode only.

## License

MIT
