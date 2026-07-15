# pi-codex-status

A [Pi coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that displays OpenAI Codex session status and rate limits.

## What it shows

- Account info (model, email, plan type)
- Banked usage reset count and each available reset's expiry in local time
- Rate limit usage with color-coded progress bars (green/yellow/red)
- Reset times for each rate limit window (hourly, weekly, etc.)

## Install

```
pi install git:github.com/carlosarraes/pi-codex-status
```

Requires `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` >= 0.49.0.

## Usage

```
/status
```

You must be logged in to OpenAI Codex (`/login`) for this to work. Interactive mode only.

## License

MIT
