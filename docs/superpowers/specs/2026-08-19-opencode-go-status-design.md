# OpenCode Go Status Design

## Goal

Extend the existing `/status` command so users can inspect either OpenAI Codex or OpenCode Go usage in the same interactive view.

## Command behavior

- `/status` opens the existing Codex view.
- `/status codex` opens the Codex view.
- `/status opencode-go` and `/status ogo` open the OpenCode Go view.
- Unknown arguments show a concise usage error.
- Argument autocomplete offers `codex`, `opencode-go`, and `ogo`.
- Tab or Shift+Tab switches between Codex and OpenCode Go.
- `q`, Escape, Enter, or Ctrl+C dismisses the view.

## Interaction model

The command handler owns a small modal loop:

1. Parse the requested initial provider.
2. Fetch only that provider and show the existing loader while it runs.
3. Render the provider in the status component.
4. When the component returns a switch action, fetch the other provider if it is not cached.
5. Re-render the component with the selected provider.
6. Exit when the component returns a dismiss action.

Successful provider responses are cached for the lifetime of the open status modal. This keeps the initial command fast and avoids duplicate requests while switching tabs.

If a provider fails while switching, notify the user and return to the previously rendered provider. If the initially requested provider fails, notify the user and close the command. Codex authentication and behavior remain unchanged unless the user switches providers.

## OpenCode Go authentication

Resolve the API key in this order:

1. A non-empty `OPENCODE_API_KEY` environment variable.
2. The `opencode-go.key` string in OpenCode's `auth.json`.

Resolve the auth file from `$XDG_DATA_HOME/opencode/auth.json` when `XDG_DATA_HOME` is set; otherwise use `~/.local/share/opencode/auth.json`. Missing files, malformed JSON, missing entries, and non-string or empty keys are treated as unavailable credentials. Secret values must never be included in notifications or logs.

## OpenCode Go API

Send:

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <api-key>
```

The response must contain `usage.rolling`, `usage.weekly`, and `usage.monthly`. Each window must have:

- `percent`: a finite number, interpreted as used percentage and clamped to 0–100 for rendering.
- `resetsAt`: a valid date string.

The `status` field is not needed for rendering. Non-success HTTP responses, transport errors, malformed JSON, and invalid required fields fail the OpenCode Go fetch with a user-safe message.

## UI

The component adds a provider header showing `Codex | OpenCode Go`, with the active provider emphasized.

The Codex pane preserves the current account, model, directory, reset-credit, and rate-limit output.

The OpenCode Go pane renders three rows in this order:

1. Rolling
2. Weekly
3. Monthly

Each row reuses the existing color thresholds and remaining-capacity bar. It displays `100 - percent` as the percentage left and formats `resetsAt` in local time. The footer becomes `Tab switch provider • q, Esc, Enter, or Ctrl+C dismiss`.

All rendered lines remain width-safe through `truncateToWidth`.

## Code organization

- `src/opencode-go.ts`: API-key resolution, response validation, usage fetching, and normalized OpenCode Go types.
- `src/index.ts`: command argument parsing, modal-loop orchestration, provider-specific rendering, and Tab handling.
- `test/opencode-go.test.ts`: authentication precedence, auth-file failures, request headers, response normalization, and API failures.
- `test/status-command.test.ts`: command target aliases and invalid arguments.

Keep shared progress-bar and reset-time formatting in `src/index.ts` unless extracting it materially improves testability. Avoid unrelated refactoring.

## Testing

Use test-first development for each behavior:

- Default, explicit Codex, `opencode-go`, and `ogo` routing.
- Invalid command arguments.
- Environment key precedence over auth-file credentials.
- XDG and default auth-file resolution.
- Missing and malformed auth data.
- Correct endpoint and Bearer header.
- Normalization and percentage clamping.
- HTTP, transport, JSON, and schema failures.
- Existing Codex auth and reset-credit regression suite.

Finish with the full test suite, syntax/type checks available in the project, `git diff --check`, and an interactive Pi smoke test covering `/status`, Tab switching, and `/status ogo`.
