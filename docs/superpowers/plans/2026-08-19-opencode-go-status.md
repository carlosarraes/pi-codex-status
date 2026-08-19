# OpenCode Go Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenCode Go usage tab and direct `/status opencode-go` and `/status ogo` routing without regressing the existing Codex status view.

**Architecture:** Keep network and credential handling in a dependency-free `opencode-go` module, isolate command-target parsing in a tiny pure module, and place caching/failure recovery in a testable modal-loop helper. Refactor the existing TUI into a two-provider view: only the requested provider loads initially, Tab switches providers, and each successful response is fetched once per open modal.

**Tech Stack:** TypeScript ESM, Node.js 22 built-in `fetch`, `node:fs/promises`, `node:test`, Pi Extension API, Pi TUI.

## Global Constraints

- `/status` and `/status codex` open Codex first.
- `/status opencode-go` and `/status ogo` open OpenCode Go first.
- Tab and Shift+Tab switch providers; `q`, Escape, Enter, and Ctrl+C dismiss.
- Resolve OpenCode Go credentials from non-empty `OPENCODE_API_KEY` first, then OpenCode's `auth.json`.
- Resolve the auth file from `$XDG_DATA_HOME/opencode/auth.json`, falling back to `~/.local/share/opencode/auth.json`.
- Call only `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <api-key>`.
- Never log or render API keys, Codex tokens, or account IDs.
- Treat rolling, weekly, and monthly windows as required; clamp finite used percentages to 0–100 and require valid reset dates.
- Fetch only the selected provider initially and cache successful responses for the lifetime of the open modal.
- A failed provider switch returns to the previously rendered provider; an initial failure closes the command after notifying the user.
- Preserve existing Codex account, model, directory, reset-credit, and rate-limit behavior.
- Add no runtime or development dependencies.

## File Structure

- Create `src/opencode-go.ts`: OpenCode key resolution, auth-file parsing, usage request, schema validation, and normalized usage types.
- Create `test/opencode-go.test.ts`: deterministic tests with injected filesystem and fetch functions.
- Create `src/status-target.ts`: pure command alias parsing and completion values.
- Create `test/status-target.test.ts`: routing and invalid-argument tests without importing Pi peer packages.
- Create `src/status-modal.ts`: provider switching, successful-response caching, cancellation, and failure recovery.
- Create `test/status-modal.test.ts`: modal-loop caching, switch-failure, initial-failure, and cancellation tests.
- Modify `src/index.ts`: provider-aware rendering, Tab actions, loader orchestration, and command autocomplete.
- Modify `README.md`: document both providers, aliases, key discovery, and Tab navigation.
- Modify `package.json`: update package description to include OpenCode Go.

---

### Task 1: OpenCode Go credentials and usage client

**Files:**
- Create: `src/opencode-go.ts`
- Create: `test/opencode-go.test.ts`

**Interfaces:**
- Produces: `resolveOpenCodeGoApiKey(options?: OpenCodeGoAuthOptions): Promise<string | null>`.
- Produces: `fetchOpenCodeGoUsage(apiKey: string, fetchImpl?: FetchLike): Promise<OpenCodeGoUsage>`.
- Produces: `OpenCodeGoUsageWindow = { usedPercent: number; resetAt: number }` where `resetAt` is epoch milliseconds.
- Produces: `OpenCodeGoUsage = { rolling: OpenCodeGoUsageWindow; weekly: OpenCodeGoUsageWindow; monthly: OpenCodeGoUsageWindow }`.
- `OpenCodeGoAuthOptions` accepts injected `env`, `homeDir`, and `readFileImpl` values for deterministic tests.

- [ ] **Step 1: Write failing authentication tests**

Create `test/opencode-go.test.ts` with the authentication cases first:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
	resolveOpenCodeGoApiKey,
	type ReadFileLike,
} from "../src/opencode-go.ts";

test("resolveOpenCodeGoApiKey prefers OPENCODE_API_KEY without reading disk", async () => {
	let reads = 0;
	const readFileImpl: ReadFileLike = async () => {
		reads += 1;
		return "{}";
	};

	const result = await resolveOpenCodeGoApiKey({
		env: { OPENCODE_API_KEY: "  env-secret  ", XDG_DATA_HOME: "/xdg" },
		homeDir: "/home/tester",
		readFileImpl,
	});

	assert.equal(result, "env-secret");
	assert.equal(reads, 0);
});

test("resolveOpenCodeGoApiKey reads the XDG OpenCode auth entry", async () => {
	let observedPath = "";
	const readFileImpl: ReadFileLike = async (path) => {
		observedPath = path;
		return JSON.stringify({ "opencode-go": { type: "api", key: "file-secret" } });
	};

	const result = await resolveOpenCodeGoApiKey({
		env: { XDG_DATA_HOME: "/custom/data" },
		homeDir: "/home/tester",
		readFileImpl,
	});

	assert.equal(result, "file-secret");
	assert.equal(observedPath, "/custom/data/opencode/auth.json");
});

test("resolveOpenCodeGoApiKey falls back to the default Linux data path", async () => {
	let observedPath = "";
	const readFileImpl: ReadFileLike = async (path) => {
		observedPath = path;
		return JSON.stringify({ "opencode-go": { key: "default-secret" } });
	};

	const result = await resolveOpenCodeGoApiKey({
		env: {},
		homeDir: "/home/tester",
		readFileImpl,
	});

	assert.equal(result, "default-secret");
	assert.equal(observedPath, "/home/tester/.local/share/opencode/auth.json");
});

test("resolveOpenCodeGoApiKey rejects missing and malformed auth data", async () => {
	const cases = [
		"not-json",
		"null",
		JSON.stringify({}),
		JSON.stringify({ "opencode-go": null }),
		JSON.stringify({ "opencode-go": { key: 123 } }),
		JSON.stringify({ "opencode-go": { key: "   " } }),
	];

	for (const content of cases) {
		assert.equal(
			await resolveOpenCodeGoApiKey({
				env: { OPENCODE_API_KEY: "   " },
				homeDir: "/home/tester",
				readFileImpl: async () => content,
			}),
			null,
		);
	}

	assert.equal(
		await resolveOpenCodeGoApiKey({
			env: {},
			homeDir: "/home/tester",
			readFileImpl: async () => {
				throw new Error("missing");
			},
		}),
		null,
	);
});
```

- [ ] **Step 2: Run the focused tests and verify the module is missing**

Run:

```bash
node --experimental-strip-types --test test/opencode-go.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/opencode-go.ts`.

- [ ] **Step 3: Implement API-key resolution**

Create `src/opencode-go.ts` with the authentication boundary:

```typescript
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_TIMEOUT_MS = 5_000;

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type ReadFileLike = (path: string, encoding: "utf8") => Promise<string>;

export type OpenCodeGoAuthOptions = {
	env?: Readonly<Record<string, string | undefined>>;
	homeDir?: string;
	readFileImpl?: ReadFileLike;
};

export type OpenCodeGoUsageWindow = {
	usedPercent: number;
	resetAt: number;
};

export type OpenCodeGoUsage = {
	rolling: OpenCodeGoUsageWindow;
	weekly: OpenCodeGoUsageWindow;
	monthly: OpenCodeGoUsageWindow;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveOpenCodeGoApiKey(
	options: OpenCodeGoAuthOptions = {},
): Promise<string | null> {
	const env = options.env ?? process.env;
	const environmentKey = env.OPENCODE_API_KEY?.trim();
	if (environmentKey) return environmentKey;

	const dataHome = env.XDG_DATA_HOME?.trim() || join(options.homeDir ?? homedir(), ".local", "share");
	const authPath = join(dataHome, "opencode", "auth.json");

	try {
		const raw = await (options.readFileImpl ?? readFile)(authPath, "utf8");
		const auth = JSON.parse(raw) as unknown;
		if (!isRecord(auth)) return null;
		const entry = auth["opencode-go"];
		if (!isRecord(entry) || typeof entry.key !== "string") return null;
		return entry.key.trim() || null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run the authentication tests and verify they pass**

Run:

```bash
node --experimental-strip-types --test test/opencode-go.test.ts
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Add failing API request and normalization tests**

Replace the import from `../src/opencode-go.ts` with:

```typescript
import {
	fetchOpenCodeGoUsage,
	resolveOpenCodeGoApiKey,
	type FetchLike,
	type ReadFileLike,
} from "../src/opencode-go.ts";
```

Then append:

```typescript
test("fetchOpenCodeGoUsage sends the Bearer key and normalizes all windows", async () => {
	let observedUrl = "";
	let observedInit: RequestInit | undefined;
	const fetchImpl: FetchLike = async (input, init) => {
		observedUrl = String(input);
		observedInit = init;
		return new Response(JSON.stringify({
			usage: {
				rolling: { status: "ok", percent: -5, resetsAt: "2026-08-19T05:47:02.407Z" },
				weekly: { status: "ok", percent: 42.5, resetsAt: "2026-08-24T00:00:00.407Z" },
				monthly: { status: "ok", percent: 125, resetsAt: "2026-09-17T20:04:38.407Z" },
			},
		}), { status: 200, headers: { "Content-Type": "application/json" } });
	};

	const result = await fetchOpenCodeGoUsage("secret-key", fetchImpl);

	assert.equal(observedUrl, "https://opencode.ai/zen/go/v1/usage");
	assert.equal(observedInit?.method, "GET");
	assert.equal(new Headers(observedInit?.headers).get("Authorization"), "Bearer secret-key");
	assert.ok(observedInit?.signal instanceof AbortSignal);
	assert.deepEqual(result, {
		rolling: { usedPercent: 0, resetAt: Date.parse("2026-08-19T05:47:02.407Z") },
		weekly: { usedPercent: 42.5, resetAt: Date.parse("2026-08-24T00:00:00.407Z") },
		monthly: { usedPercent: 100, resetAt: Date.parse("2026-09-17T20:04:38.407Z") },
	});
});

test("fetchOpenCodeGoUsage rejects HTTP, transport, JSON, and schema failures", async () => {
	const failures: FetchLike[] = [
		async () => new Response("denied", { status: 401 }),
		async () => {
			throw new Error("offline");
		},
		async () => new Response("not-json", { status: 200 }),
		async () => new Response(JSON.stringify({ usage: {} }), { status: 200 }),
		async () => new Response(JSON.stringify({
			usage: {
				rolling: { percent: Number.NaN, resetsAt: "2026-08-19T05:47:02.407Z" },
				weekly: { percent: 2, resetsAt: "2026-08-24T00:00:00.407Z" },
				monthly: { percent: 3, resetsAt: "2026-09-17T20:04:38.407Z" },
			},
		}), { status: 200 }),
		async () => new Response(JSON.stringify({
			usage: {
				rolling: { percent: 1, resetsAt: "invalid" },
				weekly: { percent: 2, resetsAt: "2026-08-24T00:00:00.407Z" },
				monthly: { percent: 3, resetsAt: "2026-09-17T20:04:38.407Z" },
			},
		}), { status: 200 }),
	];

	for (const fetchImpl of failures) {
		await assert.rejects(
			fetchOpenCodeGoUsage("secret-key", fetchImpl),
			/OpenCode Go usage/,
		);
	}
});
```

- [ ] **Step 6: Run the focused tests and verify the missing client fails**

Run:

```bash
node --experimental-strip-types --test test/opencode-go.test.ts
```

Expected: FAIL because `fetchOpenCodeGoUsage` has not been exported.

- [ ] **Step 7: Implement response validation and fetching**

Append to `src/opencode-go.ts`:

```typescript
function parseWindow(value: unknown): OpenCodeGoUsageWindow | null {
	if (!isRecord(value) || typeof value.percent !== "number" || !Number.isFinite(value.percent)) {
		return null;
	}
	if (typeof value.resetsAt !== "string") return null;
	const resetAt = Date.parse(value.resetsAt);
	if (!Number.isFinite(resetAt)) return null;
	return {
		usedPercent: Math.min(100, Math.max(0, value.percent)),
		resetAt,
	};
}

function parseUsage(value: unknown): OpenCodeGoUsage | null {
	if (!isRecord(value) || !isRecord(value.usage)) return null;
	const rolling = parseWindow(value.usage.rolling);
	const weekly = parseWindow(value.usage.weekly);
	const monthly = parseWindow(value.usage.monthly);
	if (!rolling || !weekly || !monthly) return null;
	return { rolling, weekly, monthly };
}

export async function fetchOpenCodeGoUsage(
	apiKey: string,
	fetchImpl: FetchLike = fetch,
): Promise<OpenCodeGoUsage> {
	try {
		const response = await fetchImpl(OPENCODE_GO_USAGE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(OPENCODE_GO_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`OpenCode Go usage API returned ${response.status}`);
		}
		const usage = parseUsage(await response.json());
		if (!usage) throw new Error("OpenCode Go usage API returned invalid data");
		return usage;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("OpenCode Go usage")) {
			throw error;
		}
		throw new Error("OpenCode Go usage request failed", { cause: error });
	}
}
```

- [ ] **Step 8: Run the focused and full test suites**

Run:

```bash
node --experimental-strip-types --test test/opencode-go.test.ts
npm test
```

Expected: 6 focused tests pass and 16 total tests pass, with 0 failures.

- [ ] **Step 9: Commit the OpenCode Go client**

```bash
git add src/opencode-go.ts test/opencode-go.test.ts
git commit -m "feat(status): add OpenCode Go usage client"
```

---

### Task 2: Status command target parsing

**Files:**
- Create: `src/status-target.ts`
- Create: `test/status-target.test.ts`

**Interfaces:**
- Produces: `StatusProvider = "codex" | "opencode-go"`.
- Produces: `STATUS_ARGUMENTS = ["codex", "opencode-go", "ogo"]`.
- Produces: `parseStatusTarget(args: string): StatusProvider | null`.
- The empty string maps to `codex`; unknown or multi-token arguments map to `null`.

- [ ] **Step 1: Write failing routing tests**

Create `test/status-target.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { STATUS_ARGUMENTS, parseStatusTarget } from "../src/status-target.ts";

test("parseStatusTarget defaults to Codex and accepts explicit Codex", () => {
	assert.equal(parseStatusTarget(""), "codex");
	assert.equal(parseStatusTarget("   "), "codex");
	assert.equal(parseStatusTarget("codex"), "codex");
	assert.equal(parseStatusTarget(" CODEX "), "codex");
});

test("parseStatusTarget accepts OpenCode Go names", () => {
	assert.equal(parseStatusTarget("opencode-go"), "opencode-go");
	assert.equal(parseStatusTarget("ogo"), "opencode-go");
	assert.equal(parseStatusTarget(" OGO "), "opencode-go");
});

test("parseStatusTarget rejects unknown and extra arguments", () => {
	assert.equal(parseStatusTarget("opencode"), null);
	assert.equal(parseStatusTarget("ogo extra"), null);
});

test("STATUS_ARGUMENTS exposes every accepted explicit value", () => {
	assert.deepEqual(STATUS_ARGUMENTS, ["codex", "opencode-go", "ogo"]);
});
```

- [ ] **Step 2: Run the focused tests and verify the module is missing**

Run:

```bash
node --experimental-strip-types --test test/status-target.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/status-target.ts`.

- [ ] **Step 3: Implement target parsing**

Create `src/status-target.ts`:

```typescript
export type StatusProvider = "codex" | "opencode-go";

export const STATUS_ARGUMENTS = ["codex", "opencode-go", "ogo"] as const;

export function parseStatusTarget(args: string): StatusProvider | null {
	const target = args.trim().toLowerCase();
	if (target === "" || target === "codex") return "codex";
	if (target === "opencode-go" || target === "ogo") return "opencode-go";
	return null;
}
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --experimental-strip-types --test test/status-target.test.ts
npm test
```

Expected: 4 focused tests pass and 20 total tests pass, with 0 failures.

- [ ] **Step 5: Commit command routing**

```bash
git add src/status-target.ts test/status-target.test.ts
git commit -m "feat(status): add provider aliases"
```

---

### Task 3: Tabbed provider UI and cached modal loop

**Files:**
- Create: `src/status-modal.ts`
- Create: `test/status-modal.test.ts`
- Modify: `src/index.ts:1-288`
- Modify: `README.md:1-26`
- Modify: `package.json:1-23`

**Interfaces:**
- Consumes from Task 1: `resolveOpenCodeGoApiKey`, `fetchOpenCodeGoUsage`, `OpenCodeGoUsage`, and `OpenCodeGoUsageWindow`.
- Consumes from Task 2: `parseStatusTarget`, `STATUS_ARGUMENTS`, and `StatusProvider`.
- Produces: `runStatusModal<T>(initialProvider, dependencies): Promise<void>` with lazy loading, caching, cancellation, and previous-provider recovery.
- Produces internal `ProviderStatusData = { provider: "codex"; data: CodexStatusData } | { provider: "opencode-go"; data: OpenCodeGoUsage }`.
- Produces internal `StatusAction = "switch" | "dismiss"` returned by `StatusComponent`.

- [ ] **Step 1: Add provider imports and split status data types**

In `src/index.ts`, add these imports after `codex-auth.ts`:

```typescript
import {
	fetchOpenCodeGoUsage,
	resolveOpenCodeGoApiKey,
	type OpenCodeGoUsage,
	type OpenCodeGoUsageWindow,
} from "./opencode-go.ts";
import {
	STATUS_ARGUMENTS,
	parseStatusTarget,
	type StatusProvider,
} from "./status-target.ts";
```

Rename `StatusData` to `CodexStatusData`, then add:

```typescript
type ProviderStatusData =
	| { provider: "codex"; data: CodexStatusData }
	| { provider: "opencode-go"; data: OpenCodeGoUsage };

type StatusAction = "switch" | "dismiss";
```

Change `formatResetTime` to accept epoch milliseconds instead of epoch seconds:

```typescript
function formatResetTime(resetAt: number): string {
	const date = new Date(resetAt);
```

Update both existing Codex calls from:

```typescript
formatResetTime(w.reset_at)
```

to:

```typescript
formatResetTime(w.reset_at * 1000)
```

- [ ] **Step 2: Make `StatusComponent` provider-aware and handle Tab**

Change the component fields and constructor to:

```typescript
class StatusComponent implements Component {
	private status: ProviderStatusData;
	private fg: (color: string, text: string) => string;
	private onDone: (action: StatusAction) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		status: ProviderStatusData,
		theme: { fg: (color: string, text: string) => string },
		onDone: (action: StatusAction) => void,
	) {
		this.status = status;
		this.fg = theme.fg.bind(theme);
		this.onDone = onDone;
	}
```

Replace `handleInput` with:

```typescript
	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.onDone("switch");
			return;
		}
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.ctrl("c")) ||
			data === "q"
		) {
			this.onDone("dismiss");
		}
	}
```

- [ ] **Step 3: Replace `render` with the complete provider-aware renderer**

Replace the existing `StatusComponent.render` method with:

```typescript
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const fg = this.fg;
		const status = this.status;
		const lines: string[] = [];
		const border = fg("dim", "─".repeat(Math.min(width - 4, 60)));
		const pad = "  ";
		const label = (key: string, value: string) => `${pad}${fg("dim", key.padEnd(18))}${value}`;
		const providerTab = (provider: StatusProvider, text: string) =>
			status.provider === provider ? fg("accent", `[${text}]`) : fg("dim", text);

		lines.push("");
		lines.push(`${pad}${fg("accent", ">_ Pi")}`);
		lines.push("");
		lines.push(`${pad}${providerTab("codex", "Codex")}  ${providerTab("opencode-go", "OpenCode Go")}`);
		lines.push("");

		if (status.provider === "codex") {
			const d = status.data;
			lines.push(`${pad}${fg("warning", "Visit https://chatgpt.com/codex/settings/usage")} for up-to-date`);
			lines.push(`${pad}information on rate limits and credits`);
			lines.push("");
			lines.push(`${pad}${border}`);
			lines.push("");

			lines.push(label("Model:", d.model));
			lines.push(label("Directory:", d.directory));
			if (d.email) {
				lines.push(label("Account:", `${d.email} (${titleCase(d.planType)})`));
			} else {
				lines.push(label("Account:", `(${titleCase(d.planType)})`));
			}
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
				if (!details) return;
				if (heading) lines.push(`${pad}${fg("accent", heading)}`);

				if (details.primary_window) {
					const window = details.primary_window;
					const remaining = 100 - window.used_percent;
					const color = barColor(window.used_percent, fg);
					const bar = color(`[${renderBar(window.used_percent)}]`);
					const pct = color(`${remaining}% left`);
					const reset = fg("dim", `(${formatResetTime(window.reset_at * 1000)})`);
					lines.push(`${pad}${fg("dim", windowLabel(window.limit_window_seconds).padEnd(18))}${bar} ${pct} ${reset}`);
				}

				if (details.secondary_window) {
					const window = details.secondary_window;
					const remaining = 100 - window.used_percent;
					const color = barColor(window.used_percent, fg);
					const bar = color(`[${renderBar(window.used_percent)}]`);
					const pct = color(`${remaining}% left`);
					const reset = fg("dim", `(${formatResetTime(window.reset_at * 1000)})`);
					lines.push(`${pad}${fg("dim", windowLabel(window.limit_window_seconds).padEnd(18))}${bar} ${pct} ${reset}`);
				}
			};

			addRateLimits(d.usage.rate_limit);
			if (d.usage.additional_rate_limits) {
				for (const extra of d.usage.additional_rate_limits) {
					lines.push("");
					addRateLimits(extra.rate_limit, `${extra.limit_name}:`);
				}
			}
		} else {
			const usage = status.data;
			lines.push(`${pad}${border}`);
			lines.push("");
			lines.push(`${pad}${fg("accent", "OpenCode Go usage")}`);
			lines.push("");

			const addOpenCodeWindow = (labelText: string, window: OpenCodeGoUsageWindow) => {
				const remaining = 100 - window.usedPercent;
				const color = barColor(window.usedPercent, fg);
				const bar = color(`[${renderBar(window.usedPercent)}]`);
				const pct = color(`${remaining}% left`);
				const reset = fg("dim", `(${formatResetTime(window.resetAt)})`);
				lines.push(`${pad}${fg("dim", labelText.padEnd(18))}${bar} ${pct} ${reset}`);
			};

			addOpenCodeWindow("Rolling", usage.rolling);
			addOpenCodeWindow("Weekly", usage.weekly);
			addOpenCodeWindow("Monthly", usage.monthly);
		}

		lines.push("");
		lines.push(`${pad}${fg("dim", "Tab switch provider • q, Esc, Enter, or Ctrl+C dismiss")}`);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, width));
		return this.cachedLines;
	}
```

- [ ] **Step 4: Extract provider loaders above the extension factory**

Add these functions after `fetchUsage`:

```typescript
async function loadCodexStatus(ctx: ExtensionCommandContext): Promise<CodexStatusData> {
	let statusAuth: CodexStatusAuth | null;
	try {
		statusAuth = await resolveCodexStatusAuth(
			() => ctx.modelRegistry.getProviderAuth("openai-codex"),
		);
	} catch {
		throw new Error("Failed to resolve OpenAI Codex credentials. Use /login and try again.");
	}
	if (!statusAuth) {
		throw new Error("Not logged in to OpenAI Codex. Use /login first.");
	}

	try {
		const { token, accountId, email } = statusAuth;
		const [usage, resetCreditDetails] = await Promise.all([
			fetchUsage(token, accountId),
			fetchResetCreditDetails(token, accountId),
		]);

		const homedir = process.env.HOME || process.env.USERPROFILE || "";
		let directory = process.cwd();
		if (homedir && directory.startsWith(homedir)) {
			directory = "~" + directory.slice(homedir.length);
		}

		return {
			model: ctx.model.id,
			directory,
			email,
			planType: usage.plan_type,
			usage,
			resetCredits: buildResetCreditsView(
				usage.rate_limit_reset_credits?.available_count,
				resetCreditDetails,
			),
		};
	} catch (error) {
		if (error instanceof Error && (
			error.message.startsWith("Failed to resolve") ||
			error.message.startsWith("Not logged in")
		)) {
			throw error;
		}
		throw new Error("Failed to fetch OpenAI Codex status");
	}
}

async function loadOpenCodeGoStatus(): Promise<OpenCodeGoUsage> {
	const apiKey = await resolveOpenCodeGoApiKey();
	if (!apiKey) {
		throw new Error("OpenCode Go API key not found. Set OPENCODE_API_KEY or log in with OpenCode.");
	}
	try {
		return await fetchOpenCodeGoUsage(apiKey);
	} catch {
		throw new Error("Failed to fetch OpenCode Go usage");
	}
}

async function loadProviderStatus(
	provider: StatusProvider,
	ctx: ExtensionCommandContext,
): Promise<ProviderStatusData> {
	if (provider === "codex") {
		return { provider, data: await loadCodexStatus(ctx) };
	}
	return { provider, data: await loadOpenCodeGoStatus() };
}

function otherProvider(provider: StatusProvider): StatusProvider {
	return provider === "codex" ? "opencode-go" : "codex";
}
```

- [ ] **Step 5: Replace the command handler with argument routing and the modal loop**

Replace the current `pi.registerCommand("status", ...)` body with:

```typescript
	pi.registerCommand("status", {
		description: "Show Codex or OpenCode Go usage and rate limits",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = STATUS_ARGUMENTS.filter((value) => value.startsWith(normalized));
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		async handler(args, ctx: ExtensionCommandContext) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/status requires interactive mode", "error");
				return;
			}

			let activeProvider = parseStatusTarget(args);
			if (!activeProvider) {
				ctx.ui.notify("Usage: /status [codex|opencode-go|ogo]", "error");
				return;
			}

			const cache = new Map<StatusProvider, ProviderStatusData>();
			let previousProvider: StatusProvider | null = null;

			while (true) {
				let status = cache.get(activeProvider);
				if (!status) {
					const providerBeingLoaded = activeProvider;
					const result = await ctx.ui.custom<
						{ ok: true; status: ProviderStatusData } |
						{ ok: false; message: string } |
						null
					>((tui, theme, _kb, done) => {
						const label = providerBeingLoaded === "codex" ? "Codex" : "OpenCode Go";
						const loader = new BorderedLoader(tui, theme, `Fetching ${label} status...`);
						loader.onAbort = () => done(null);
						loadProviderStatus(providerBeingLoaded, ctx)
							.then((loaded) => done({ ok: true, status: loaded }))
							.catch((error: unknown) => done({
								ok: false,
								message: error instanceof Error ? error.message : `Failed to fetch ${label} status`,
							}));
						return loader;
					});

					if (!result) return;
					if (!result.ok) {
						ctx.ui.notify(result.message, "error");
						if (!previousProvider) return;
						activeProvider = previousProvider;
						previousProvider = null;
						continue;
					}
					status = result.status;
					cache.set(providerBeingLoaded, status);
				}

				const action = await ctx.ui.custom<StatusAction>((_tui, theme, _kb, done) =>
					new StatusComponent(status, theme, done)
				);
				if (action === "dismiss") return;
				previousProvider = activeProvider;
				activeProvider = otherProvider(activeProvider);
			}
		},
	});
```

This loop loads only the initial provider, caches successful data, and restores the previous tab after a failed switch.

- [ ] **Step 6: Run automated regression checks**

Run:

```bash
npm test
node --experimental-strip-types --check src/index.ts
node --experimental-strip-types --check src/opencode-go.ts
git diff --check
```

Expected:

- 23 tests pass, 0 fail.
- Every syntax check exits 0.
- `git diff --check` reports no whitespace errors.

- [ ] **Step 7: Update package metadata and README**

In `package.json`, replace the description with:

```json
"description": "OpenAI Codex and OpenCode Go usage extension for Pi",
```

Replace the README introduction and usage sections so the complete file reads:

```markdown
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
```

- [ ] **Step 8: Run direct OpenCode Go smoke tests**

With `OPENCODE_API_KEY` set, run this credential-safe check:

```bash
node --experimental-strip-types - <<'NODE'
import { fetchOpenCodeGoUsage, resolveOpenCodeGoApiKey } from "./src/opencode-go.ts";
const key = await resolveOpenCodeGoApiKey();
if (!key) throw new Error("OpenCode Go key was not resolved");
const usage = await fetchOpenCodeGoUsage(key);
console.log(Object.keys(usage).join(","));
NODE
```

Expected output:

```text
rolling,weekly,monthly
```

The command must not print the API key.

- [ ] **Step 9: Run interactive Pi acceptance checks**

Launch the local extension:

```bash
pi --no-extensions -e ./src/index.ts
```

Verify this sequence:

1. `/status` opens Codex and preserves the current account, reset-credit, and rate-limit content.
2. Pressing Tab loads OpenCode Go once and displays rolling, weekly, and monthly rows.
3. Pressing Shift+Tab returns to cached Codex content without another loader.
4. Pressing Tab again returns to cached OpenCode Go content without another loader.
5. `q`, Escape, Enter, and Ctrl+C each dismiss the status view.
6. `/status opencode-go` opens OpenCode Go directly without loading Codex.
7. `/status ogo` behaves identically to `/status opencode-go`.
8. `/status unknown` shows `Usage: /status [codex|opencode-go|ogo]`.
9. Command autocomplete offers `codex`, `opencode-go`, and `ogo`.

Temporarily unset the environment key while leaving the local OpenCode auth file available, then verify `/status ogo` still loads from `auth.json`. Do not print either credential source.

- [ ] **Step 10: Run package and diff verification**

Run:

```bash
npm test
npm pack --dry-run --json
git diff --check
git status --short
```

Expected:

- 23 tests pass, 0 fail.
- The package contains `src/index.ts`, `src/opencode-go.ts`, `src/status-modal.ts`, `src/status-target.ts`, and existing source modules.
- Test files are excluded because `package.json` publishes only `src`.
- No whitespace errors are reported.
- Only `README.md`, `package.json`, and `src/index.ts` remain uncommitted after Tasks 1 and 2.

- [ ] **Step 11: Commit the tabbed UI and documentation**

```bash
git add README.md package.json src/index.ts
git commit -m "feat(status): show OpenCode Go usage"
```

## Final Verification

Run after all three task commits:

```bash
npm test
node --experimental-strip-types --check src/index.ts
npm pack --dry-run --json
git diff --check upstream/main...HEAD
git status --short --branch
```

Expected:

- 23 tests pass, 0 fail.
- Syntax and package checks succeed.
- No whitespace errors are reported.
- The worktree is clean.
- The branch contains the design commit plus three focused implementation commits; the implementation plan may be committed separately with the documentation commit if desired.
