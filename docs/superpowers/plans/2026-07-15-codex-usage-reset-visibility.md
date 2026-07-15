# Codex Usage Reset Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/status` to show the available Codex usage-reset count and each available reset's local expiration date and time.

**Architecture:** Add one focused reset-credit module that owns the optional read-only API request, validates unknown backend JSON, builds a display model, and formats plain display text. Keep `src/index.ts` responsible for orchestration and TUI styling: fetch usage and reset details concurrently, preserve the existing required usage path, and render the optional reset block without changing rate-limit bars.

**Tech Stack:** TypeScript ESM, Node.js 22 built-in `fetch`, `AbortSignal.timeout`, `node:test`, Pi Extension API, Pi TUI.

## Global Constraints

- Use only `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`; never call the `/consume` endpoint.
- Reuse `Authorization: Bearer` and `ChatGPT-Account-Id` without logging either value.
- Treat `/wham/usage` as required and reset-credit details as optional.
- A reset-detail HTTP, timeout, JSON, or schema failure must degrade to the `/wham/usage` count when present, never to a false zero.
- Filter detail rows to `status === "available"`, sort valid expiries ascending, and put null or unavailable expiries last.
- Render expiry timestamps in the machine's local timezone using 24-hour `HH:mm on D Mon YYYY` text.
- Never render credit IDs, tokens, grant descriptions, profile data, or redemption controls.
- Preserve all existing account and rate-limit bar behavior.
- Add no runtime or development dependencies.

## File Structure

- Create `src/reset-credits.ts`: read-only reset-credit API client, unknown-JSON normalization, display model, and plain-text formatting.
- Create `test/reset-credits.test.ts`: deterministic unit tests using Node's built-in test runner and fake `fetch` implementations.
- Modify `src/index.ts`: add usage-summary typing, run parallel reads, store the reset view, and style/render the reset block.
- Modify `package.json`: add the dependency-free test command.
- Modify `README.md`: document the additional `/status` output.

---

### Task 1: Reset-credit API and normalized display model

**Files:**
- Create: `src/reset-credits.ts`
- Create: `test/reset-credits.test.ts`
- Modify: `package.json:1-19`

**Interfaces:**
- Produces: `fetchResetCreditDetails(token: string, accountId: string, fetchImpl?: FetchLike): Promise<unknown | null>`
- Produces: `buildResetCreditsView(summaryCount: unknown, rawDetails: unknown): ResetCreditsView | null`
- Produces: `ResetCreditExpiry` and `ResetCreditsView` types consumed by Task 2.
- No project source outside these files is changed in this task.

- [ ] **Step 1: Add the Node test command**

Replace `package.json` with:

```json
{
  "name": "pi-codex-status",
  "version": "0.1.0",
  "description": "OpenAI Codex status and rate limits extension for Pi",
  "main": "./src/index.ts",
  "type": "module",
  "license": "MIT",
  "author": "carraes",
  "files": [
    "src"
  ],
  "scripts": {
    "test": "node --experimental-strip-types --test test/*.test.ts"
  },
  "pi": {
    "extensions": ["./src"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": ">=0.78.0",
    "@earendil-works/pi-coding-agent": ">=0.78.0"
  }
}
```

- [ ] **Step 2: Write failing tests for API safety, normalization, sorting, and fallback**

Create `test/reset-credits.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildResetCreditsView,
	fetchResetCreditDetails,
	type FetchLike,
} from "../src/reset-credits.ts";

test("fetchResetCreditDetails uses the read-only endpoint and account headers", async () => {
	let observedUrl = "";
	let observedInit: RequestInit | undefined;
	const fetchImpl: FetchLike = async (input, init) => {
		observedUrl = String(input);
		observedInit = init;
		return new Response(JSON.stringify({ available_count: 1, credits: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};

	const result = await fetchResetCreditDetails("secret-token", "account-123", fetchImpl);

	assert.deepEqual(result, { available_count: 1, credits: [] });
	assert.equal(observedUrl, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(observedInit?.method, "GET");
	const headers = new Headers(observedInit?.headers);
	assert.equal(headers.get("Authorization"), "Bearer secret-token");
	assert.equal(headers.get("ChatGPT-Account-Id"), "account-123");
	assert.ok(observedInit?.signal instanceof AbortSignal);
});

test("fetchResetCreditDetails returns null for HTTP, transport, and JSON failures", async () => {
	const httpFailure: FetchLike = async () => new Response("denied", { status: 401 });
	const transportFailure: FetchLike = async () => {
		throw new Error("offline");
	};
	const jsonFailure: FetchLike = async () => new Response("not-json", { status: 200 });

	assert.equal(await fetchResetCreditDetails("token", "account", httpFailure), null);
	assert.equal(await fetchResetCreditDetails("token", "account", transportFailure), null);
	assert.equal(await fetchResetCreditDetails("token", "account", jsonFailure), null);
});

test("buildResetCreditsView filters unavailable rows and sorts expiry states", () => {
	const early = "2026-07-18T00:29:44Z";
	const late = "2026-07-26T23:56:47Z";
	const view = buildResetCreditsView(9, {
		available_count: 4,
		credits: [
			{ status: "redeemed", expires_at: "2026-07-01T00:00:00Z" },
			{ status: "available", expires_at: null },
			{ status: "available", expires_at: "not-a-date" },
			{ status: "available", expires_at: late },
			{ status: "available", expires_at: early },
		],
	});

	assert.deepEqual(view, {
		availableCount: 4,
		detailsAvailable: true,
		credits: [
			{ kind: "at", timestamp: Date.parse(early) },
			{ kind: "at", timestamp: Date.parse(late) },
			{ kind: "never" },
			{ kind: "unavailable" },
		],
		missingDetailCount: 0,
	});
});

test("buildResetCreditsView trusts zero and caps contradictory detail rows", () => {
	assert.deepEqual(
		buildResetCreditsView(2, {
			available_count: 0,
			credits: [{ status: "available", expires_at: "2026-07-18T00:00:00Z" }],
		}),
		{
			availableCount: 0,
			detailsAvailable: true,
			credits: [],
			missingDetailCount: 0,
		},
	);
});

test("buildResetCreditsView reports count and detail-row mismatches", () => {
	const view = buildResetCreditsView(1, {
		available_count: 3,
		credits: [{ status: "available", expires_at: "2026-07-18T00:00:00Z" }],
	});

	assert.equal(view?.availableCount, 3);
	assert.equal(view?.credits.length, 1);
	assert.equal(view?.missingDetailCount, 2);
});

test("buildResetCreditsView falls back to the usage summary without inventing details", () => {
	assert.deepEqual(buildResetCreditsView(3, null), {
		availableCount: 3,
		detailsAvailable: false,
		credits: [],
		missingDetailCount: 0,
	});
	assert.deepEqual(buildResetCreditsView(-4, null), {
		availableCount: 0,
		detailsAvailable: false,
		credits: [],
		missingDetailCount: 0,
	});
	assert.equal(buildResetCreditsView(undefined, null), null);
	assert.equal(buildResetCreditsView(undefined, { available_count: "3", credits: [] }), null);
});
```

- [ ] **Step 3: Run the tests and confirm the new module is missing**

Run:

```bash
npm test
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/reset-credits.ts`.

- [ ] **Step 4: Implement the API client and normalized view**

Create `src/reset-credits.ts`:

```typescript
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CREDITS_TIMEOUT_MS = 5_000;

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type ResetCreditExpiry =
	| { kind: "at"; timestamp: number }
	| { kind: "never" }
	| { kind: "unavailable" };

export type ResetCreditsView = {
	availableCount: number;
	detailsAvailable: boolean;
	credits: ResetCreditExpiry[];
	missingDetailCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.trunc(value));
}

function normalizeExpiry(value: unknown): ResetCreditExpiry {
	if (value === null) return { kind: "never" };
	if (typeof value !== "string") return { kind: "unavailable" };
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return { kind: "unavailable" };
	return { kind: "at", timestamp };
}

function expiryRank(expiry: ResetCreditExpiry): number {
	if (expiry.kind === "at") return 0;
	if (expiry.kind === "never") return 1;
	return 2;
}

function compareExpiries(a: ResetCreditExpiry, b: ResetCreditExpiry): number {
	const rankDifference = expiryRank(a) - expiryRank(b);
	if (rankDifference !== 0) return rankDifference;
	if (a.kind === "at" && b.kind === "at") return a.timestamp - b.timestamp;
	return 0;
}

function parseDetails(rawDetails: unknown): { availableCount: number; credits: unknown[] } | null {
	if (!isRecord(rawDetails)) return null;
	const availableCount = normalizeCount(rawDetails.available_count);
	if (availableCount === undefined || !Array.isArray(rawDetails.credits)) return null;
	return { availableCount, credits: rawDetails.credits };
}

export async function fetchResetCreditDetails(
	token: string,
	accountId: string,
	fetchImpl: FetchLike = fetch,
): Promise<unknown | null> {
	try {
		const response = await fetchImpl(RESET_CREDITS_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"ChatGPT-Account-Id": accountId,
			},
			signal: AbortSignal.timeout(RESET_CREDITS_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export function buildResetCreditsView(
	summaryCount: unknown,
	rawDetails: unknown,
): ResetCreditsView | null {
	const details = parseDetails(rawDetails);
	if (!details) {
		const availableCount = normalizeCount(summaryCount);
		if (availableCount === undefined) return null;
		return {
			availableCount,
			detailsAvailable: false,
			credits: [],
			missingDetailCount: 0,
		};
	}

	const credits = details.credits
		.filter(isRecord)
		.filter((credit) => credit.status === "available")
		.map((credit) => normalizeExpiry(credit.expires_at))
		.sort(compareExpiries)
		.slice(0, details.availableCount);

	return {
		availableCount: details.availableCount,
		detailsAvailable: true,
		credits,
		missingDetailCount: Math.max(0, details.availableCount - credits.length),
	};
}
```

- [ ] **Step 5: Run the focused tests and confirm they pass**

Run:

```bash
npm test
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 6: Commit the tested reset-credit model**

```bash
git add package.json src/reset-credits.ts test/reset-credits.test.ts
git commit -m "feat(status): add reset-credit data model"
```

---

### Task 2: Local expiry formatting and `/status` integration

**Files:**
- Modify: `src/reset-credits.ts`
- Modify: `test/reset-credits.test.ts`
- Modify: `src/index.ts:1-267`
- Modify: `README.md:5-10`

**Interfaces:**
- Consumes from Task 1: `fetchResetCreditDetails`, `buildResetCreditsView`, and `ResetCreditsView`.
- Produces: `formatResetCredits(view: ResetCreditsView): ResetCreditsText`.
- Integrates `StatusData.resetCredits: ResetCreditsView | null` into the existing TUI.

- [ ] **Step 1: Add the formatter import and failing display tests**

In `test/reset-credits.test.ts`, replace the import block with:

```typescript
import {
	buildResetCreditsView,
	fetchResetCreditDetails,
	formatResetCredits,
	type FetchLike,
} from "../src/reset-credits.ts";
```

Append these tests:

```typescript
test("formatResetCredits uses local 24-hour expiry text", () => {
	const first = new Date(2026, 6, 18, 0, 29).getTime();
	const second = new Date(2026, 6, 26, 23, 56).getTime();

	assert.deepEqual(
		formatResetCredits({
			availableCount: 4,
			detailsAvailable: true,
			credits: [
				{ kind: "at", timestamp: first },
				{ kind: "at", timestamp: second },
				{ kind: "never" },
				{ kind: "unavailable" },
			],
			missingDetailCount: 0,
		}),
		{
			summary: "4 available",
			details: [
				"#1 expires 00:29 on 18 Jul 2026",
				"#2 expires 23:56 on 26 Jul 2026",
				"#3 does not expire",
				"#4 expiry unavailable",
			],
		},
	);
});

test("formatResetCredits explains count-only fallback and detail mismatches", () => {
	assert.deepEqual(
		formatResetCredits({
			availableCount: 2,
			detailsAvailable: false,
			credits: [],
			missingDetailCount: 0,
		}),
		{ summary: "2 available (expiry details unavailable)", details: [] },
	);

	assert.deepEqual(
		formatResetCredits({
			availableCount: 3,
			detailsAvailable: true,
			credits: [{ kind: "never" }],
			missingDetailCount: 2,
		}),
		{
			summary: "3 available",
			details: ["#1 does not expire", "2 more expiry details unavailable"],
		},
	);

	assert.deepEqual(
		formatResetCredits({
			availableCount: 0,
			detailsAvailable: true,
			credits: [],
			missingDetailCount: 0,
		}),
		{ summary: "0 available", details: [] },
	);
});
```

- [ ] **Step 2: Run the tests and confirm the formatter export is missing**

Run:

```bash
npm test
```

Expected: FAIL because `reset-credits.ts` does not export `formatResetCredits`.

- [ ] **Step 3: Implement locale-independent local-time formatting**

Append to `src/reset-credits.ts`:

```typescript
export type ResetCreditsText = {
	summary: string;
	details: string[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatExpiry(expiry: ResetCreditExpiry): string {
	if (expiry.kind === "never") return "does not expire";
	if (expiry.kind === "unavailable") return "expiry unavailable";

	const date = new Date(expiry.timestamp);
	if (!Number.isFinite(date.getTime())) return "expiry unavailable";
	const hours = date.getHours().toString().padStart(2, "0");
	const minutes = date.getMinutes().toString().padStart(2, "0");
	return `expires ${hours}:${minutes} on ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatResetCredits(view: ResetCreditsView): ResetCreditsText {
	const summary = !view.detailsAvailable && view.availableCount > 0
		? `${view.availableCount} available (expiry details unavailable)`
		: `${view.availableCount} available`;
	const details = view.credits.map((expiry, index) => `#${index + 1} ${formatExpiry(expiry)}`);
	if (view.missingDetailCount > 0) {
		const noun = view.missingDetailCount === 1 ? "detail" : "details";
		details.push(`${view.missingDetailCount} more expiry ${noun} unavailable`);
	}
	return { summary, details };
}
```

- [ ] **Step 4: Run the formatter tests and confirm they pass**

Run:

```bash
npm test
```

Expected: 8 tests pass, 0 fail.

- [ ] **Step 5: Add reset-credit imports and status types to `src/index.ts`**

After the existing Pi imports, add:

```typescript
import {
	buildResetCreditsView,
	fetchResetCreditDetails,
	formatResetCredits,
	type ResetCreditsView,
} from "./reset-credits.ts";
```

Add the reset summary field to `UsageResponse` immediately after `plan_type`:

```typescript
	rate_limit_reset_credits?: {
		available_count: number;
	} | null;
```

Add this field to `StatusData` immediately after `usage`:

```typescript
	resetCredits: ResetCreditsView | null;
```

- [ ] **Step 6: Fetch required usage and optional details concurrently**

In `doFetch`, replace:

```typescript
					const usage = await fetchUsage(token, accountId);
```

with:

```typescript
					const [usage, resetCreditDetails] = await Promise.all([
						fetchUsage(token, accountId),
						fetchResetCreditDetails(token, accountId),
					]);
```

In the returned `StatusData`, add after `usage`:

```typescript
						resetCredits: buildResetCreditsView(
							usage.rate_limit_reset_credits?.available_count,
							resetCreditDetails,
						),
```

This preserves failure semantics because `fetchUsage` still rejects on failure while `fetchResetCreditDetails` catches optional-request failures and returns `null`.

- [ ] **Step 7: Render the reset block before rate-limit bars**

In `StatusComponent.render`, replace the blank line immediately after the account label block:

```typescript
		lines.push("");

		const addRateLimits = (details: RateLimitDetails | null | undefined, heading?: string) => {
```

with:

```typescript
		lines.push("");

		if (d.resetCredits) {
			const resetText = formatResetCredits(d.resetCredits);
			lines.push(label("Usage resets:", resetText.summary));
			for (const detail of resetText.details) {
				lines.push(label("", fg("dim", detail)));
			}
			lines.push("");
		}

		const addRateLimits = (details: RateLimitDetails | null | undefined, heading?: string) => {
```

The existing final `truncateToWidth` mapping remains unchanged and applies to every reset line.

- [ ] **Step 8: Document the new status information**

In `README.md`, add this bullet beneath account info:

```markdown
- Banked usage reset count and each available reset's expiry in local time
```

The complete “What it shows” list becomes:

```markdown
## What it shows

- Account info (model, email, plan type)
- Banked usage reset count and each available reset's expiry in local time
- Rate limit usage with color-coded progress bars (green/yellow/red)
- Reset times for each rate limit window (hourly, weekly, etc.)
```

- [ ] **Step 9: Run automated verification**

Run:

```bash
npm test
npm pack --dry-run
```

Expected:

- 8 tests pass, 0 fail.
- The package dry run includes `src/index.ts` and `src/reset-credits.ts`.
- The package dry run excludes `test/reset-credits.test.ts` because `files` contains only `src`.

- [ ] **Step 10: Run an interactive smoke test**

Launch Pi with the local extension:

```bash
pi -e ./src/index.ts
```

Then enter:

```text
/status
```

Verify:

- Account information still renders.
- `Usage resets:` shows the current backend count.
- Available reset rows are ordered by earliest local expiry.
- Each valid row uses `HH:mm on D Mon YYYY`.
- Rate-limit bars and their reset times are unchanged.
- No token, account ID, credit ID, description, or redeem action appears.
- `q`, Escape, Enter, and Ctrl+C still dismiss the view.

- [ ] **Step 11: Review the diff and commit the integration**

Run:

```bash
git diff --check
git status --short
git diff -- src/index.ts src/reset-credits.ts test/reset-credits.test.ts package.json README.md
```

Expected: only the approved reset-credit implementation, tests, package test script, and README update are present.

Commit:

```bash
git add src/index.ts src/reset-credits.ts test/reset-credits.test.ts package.json README.md
git commit -m "feat(status): show usage reset expiries"
```

## Final Verification

Run after both task commits:

```bash
npm test
git diff --check upstream/main...HEAD
git status --short --branch
```

Expected:

- 8 tests pass, 0 fail.
- No whitespace errors are reported.
- The worktree is clean.
- The branch contains the design commit, the plan commit, and two focused implementation commits.
