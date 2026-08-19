import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
	buildResetCreditsView,
	fetchResetCreditDetails,
	formatResetCredits,
	type ResetCreditsView,
} from "./reset-credits.ts";
import { resolveCodexStatusAuth, type CodexStatusAuth } from "./codex-auth.ts";
import {
	fetchOpenCodeGoUsage,
	resolveOpenCodeGoApiKey,
	type OpenCodeGoUsage,
	type OpenCodeGoUsageWindow,
} from "./opencode-go.ts";
import { runStatusModal, type StatusAction } from "./status-modal.ts";
import {
	STATUS_ARGUMENTS,
	parseStatusTarget,
	type StatusProvider,
} from "./status-target.ts";

type RateLimitWindow = {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds: number;
	reset_at: number;
};

type RateLimitDetails = {
	allowed: boolean;
	limit_reached: boolean;
	primary_window?: RateLimitWindow | null;
	secondary_window?: RateLimitWindow | null;
};

type UsageResponse = {
	plan_type: string;
	rate_limit_reset_credits?: {
		available_count: number;
	} | null;
	rate_limit?: RateLimitDetails | null;
	additional_rate_limits?: Array<{
		metered_feature: string;
		limit_name: string;
		rate_limit?: RateLimitDetails | null;
	}> | null;
};

type CodexStatusData = {
	model: string;
	directory: string;
	email?: string;
	planType: string;
	usage: UsageResponse;
	resetCredits: ResetCreditsView | null;
};

type ProviderStatusData =
	| { provider: "codex"; data: CodexStatusData }
	| { provider: "opencode-go"; data: OpenCodeGoUsage };

function titleCase(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function windowLabel(seconds: number): string {
	if (seconds === 604800) return "Weekly limit";
	const hours = Math.round(seconds / 3600);
	return `${hours}h limit`;
}

function formatResetTime(resetAt: number): string {
	const date = new Date(resetAt);
	const now = new Date();
	const hh = date.getHours().toString().padStart(2, "0");
	const mm = date.getMinutes().toString().padStart(2, "0");
	const time = `${hh}:${mm}`;

	const isToday =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();

	if (isToday) return `resets ${time}`;

	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `resets ${time} on ${date.getDate()} ${months[date.getMonth()]}`;
}

function renderBar(usedPercent: number, width: number = 20): string {
	const remaining = Math.round(((100 - usedPercent) / 100) * width);
	const used = width - remaining;
	return "█".repeat(remaining) + "░".repeat(used);
}

function barColor(usedPercent: number, fg: (color: ThemeColor, text: string) => string): (s: string) => string {
	const remaining = 100 - usedPercent;
	if (remaining > 50) return (s: string) => fg("success", s);
	if (remaining > 20) return (s: string) => fg("warning", s);
	return (s: string) => fg("error", s);
}

class StatusComponent implements Component {
	private status: ProviderStatusData;
	private fg: (color: ThemeColor, text: string) => string;
	private onDone: (action: StatusAction) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		status: ProviderStatusData,
		theme: Pick<Theme, "fg">,
		onDone: (action: StatusAction) => void,
	) {
		this.status = status;
		this.fg = theme.fg.bind(theme);
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

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
}

async function fetchUsage(token: string, accountId: string): Promise<UsageResponse> {
	const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-Id": accountId,
		},
	});
	if (!res.ok) {
		throw new Error(`Usage API returned ${res.status}`);
	}
	return (await res.json()) as UsageResponse;
}

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
			model: ctx.model?.id ?? "unknown",
			directory,
			email,
			planType: usage.plan_type,
			usage,
			resetCredits: buildResetCreditsView(
				usage.rate_limit_reset_credits?.available_count,
				resetCreditDetails,
			),
		};
	} catch {
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

async function loadProviderWithUi(
	provider: StatusProvider,
	ctx: ExtensionCommandContext,
): Promise<ProviderStatusData | null> {
	const label = provider === "codex" ? "Codex" : "OpenCode Go";
	const result = await ctx.ui.custom<
		{ ok: true; status: ProviderStatusData } |
		{ ok: false; message: string } |
		null
	>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Fetching ${label} status...`);
		loader.onAbort = () => done(null);
		loadProviderStatus(provider, ctx)
			.then((status) => done({ ok: true, status }))
			.catch((error: unknown) => done({
				ok: false,
				message: error instanceof Error ? error.message : `Failed to fetch ${label} status`,
			}));
		return loader;
	});

	if (!result) return null;
	if (!result.ok) throw new Error(result.message);
	return result.status;
}

export default function statusExtension(pi: ExtensionAPI) {
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

			const initialProvider = parseStatusTarget(args);
			if (!initialProvider) {
				ctx.ui.notify("Usage: /status [codex|opencode-go|ogo]", "error");
				return;
			}

			await runStatusModal(initialProvider, {
				load: (provider) => loadProviderWithUi(provider, ctx),
				show: (_provider, status) =>
					ctx.ui.custom<StatusAction>((_tui, theme, _kb, done) =>
						new StatusComponent(status, theme, done)
					),
				notifyError: (provider, error) => {
					const label = provider === "codex" ? "Codex" : "OpenCode Go";
					ctx.ui.notify(
						error instanceof Error ? error.message : `Failed to fetch ${label} status`,
						"error",
					);
				},
			});
		},
	});
}
