# Codex Usage Reset Visibility Design

**Date:** 2026-07-15
**Status:** Approved

## Goal

Extend Pi's `/status` view to show the number of banked Codex usage resets and the local expiration date and time of each available reset.

## Success Criteria

- `/status` shows the authoritative available reset count when either Codex endpoint provides it.
- Every available detailed reset is listed in earliest-expiry-first order.
- Expiration timestamps are shown in the machine's local timezone.
- A failed detail request does not prevent account information or rate-limit bars from rendering.
- The extension remains read-only and never displays reset IDs, OAuth tokens, grant descriptions, or redemption controls.
- Existing rate-limit rendering is unchanged.

## API Evidence

The extension already calls:

- `GET https://chatgpt.com/backend-api/wham/usage`

That response can include:

```json
{
  "rate_limit_reset_credits": {
    "available_count": 4
  }
}
```

Detailed reset rows are available from:

- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`

using the same headers as the usage request:

- `Authorization: Bearer [OAuth token]`
- `ChatGPT-Account-Id: [account ID]`

The detail response includes `available_count` and credit rows with `status`, `granted_at`, nullable `expires_at`, `title`, and other metadata. A read-only live probe returned HTTP 200 and four available reset rows for the current account.

The current Codex source defines and tests this wire contract in:

- [`backend-client/src/client/rate_limit_resets.rs`](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/backend-client/src/client/rate_limit_resets.rs#L21-L110)
- [`backend-client/src/types.rs`](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/backend-client/src/types.rs#L20-L54)
- [`backend-client/src/client/rate_limit_resets_tests.rs`](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/backend-client/src/client/rate_limit_resets_tests.rs#L8-L135)

Codex's own TUI filters detailed rows to available credits, sorts expiring credits first, and puts non-expiring credits last:

- [`tui/src/chatwidget/reset_credits.rs`](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/tui/src/chatwidget/reset_credits.rs#L72-L114)

## Architecture

### Fetching

During `/status`, fetch usage and reset-credit details concurrently with the existing OAuth token and account ID.

- The usage request remains required because it powers the current rate-limit bars.
- The reset-detail request is optional and must not make `/status` fail.
- Both requests are read-only GETs.

### Data model

Add typed representations for:

- `UsageResponse.rate_limit_reset_credits?.available_count`
- The detail response's `available_count` and `credits`
- The credit fields needed for display: `status` and nullable `expires_at`

Keep reset-credit parsing, normalization, sorting, and date formatting outside the TUI component so they can be tested independently.

### Normalization

When detailed data is available:

1. Treat `available_count` as the authoritative count.
2. Keep only rows whose status is `available`.
3. Sort rows by `expires_at` ascending.
4. Put rows without an expiration after expiring rows.
5. Do not expose or retain unnecessary display metadata in the rendered view.

When the detail request fails or is malformed, retain the count from `/wham/usage` if present. Do not turn a transport or parsing failure into a false zero.

## Display

Place the reset block after account information and before rate-limit bars:

```text
Usage resets:     4 available
                  #1 expires 00:29 on 18 Jul 2026
                  #2 expires 23:56 on 26 Jul 2026
                  #3 expires 19:10 on 31 Jul 2026
                  #4 expires 17:52 on 12 Aug 2026
```

Use the machine's local timezone and a locale-independent 24-hour format.

### Special cases

- Zero resets: show `0 available` and no detail rows.
- Null expiry: show `#N does not expire`.
- Invalid or missing expiry: show `#N expiry unavailable`.
- Detail request failure with a known count: show `N available (expiry details unavailable)`.
- Fewer available detail rows than the reported count: render known rows, then `N more expiry details unavailable`.
- No reset-credit count from either response: omit the entire block for compatibility with ineligible accounts or older backend responses.

All lines continue to use the existing width truncation behavior.

## Error Handling

- Usage request failure preserves the current behavior: `/status` reports that status could not be fetched.
- Reset-detail HTTP, authentication, timeout, JSON, or schema failure degrades to count-only rendering.
- Parsing one malformed credit must not expose raw response data or credentials.
- The extension must never call `/wham/rate-limit-reset-credits/consume`.

## Testing

Add focused tests for the pure reset-credit logic:

- normal count and multiple expiration rows
- earliest-expiry-first sorting
- non-available row filtering
- zero resets
- local date/time formatting
- null expiration
- invalid expiration
- detail failure with usage-summary fallback
- count/detail mismatch
- complete absence of reset-credit information

Existing rate-limit bars should be covered by a regression check or remain untouched by the extracted reset-credit code.

## Non-Goals

- Redeeming a reset from Pi
- Automatically redeeming soon-to-expire resets
- Showing redeemed or currently redeeming credits
- Displaying credit IDs, grant sources, profile data, descriptions, or total-earned history
- Replacing the direct API integration with the Codex app-server protocol
