import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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
	rate_limit?: RateLimitDetails | null;
	additional_rate_limits?: Array<{
		metered_feature: string;
		limit_name: string;
		rate_limit?: RateLimitDetails | null;
	}> | null;
};

type StatusData = {
	model: string;
	directory: string;
	email?: string;
	planType: string;
	usage: UsageResponse;
};

function decodeJwt(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function titleCase(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function windowLabel(seconds: number): string {
	if (seconds === 604800) return "Weekly limit";
	const hours = Math.round(seconds / 3600);
	return `${hours}h limit`;
}

function formatResetTime(resetAt: number): string {
	const date = new Date(resetAt * 1000);
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

function barColor(usedPercent: number, fg: (c: string, s: string) => string): (s: string) => string {
	const remaining = 100 - usedPercent;
	if (remaining > 50) return (s: string) => fg("success", s);
	if (remaining > 20) return (s: string) => fg("warning", s);
	return (s: string) => fg("error", s);
}

class StatusComponent implements Component {
	private data: StatusData;
	private fg: (color: string, text: string) => string;
	private onDone: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		data: StatusData,
		theme: { fg: (color: string, text: string) => string },
		onDone: () => void,
	) {
		this.data = data;
		this.fg = theme.fg.bind(theme);
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.onDone();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const fg = this.fg;
		const d = this.data;
		const lines: string[] = [];

		const border = fg("dim", "─".repeat(Math.min(width - 4, 60)));
		const pad = "  ";

		lines.push("");
		lines.push(`${pad}${fg("accent", ">_ Pi")}`);
		lines.push("");
		lines.push(`${pad}${fg("warning", "Visit https://chatgpt.com/codex/settings/usage")} for up-to-date`);
		lines.push(`${pad}information on rate limits and credits`);
		lines.push("");
		lines.push(`${pad}${border}`);
		lines.push("");

		const label = (k: string, v: string) => `${pad}${fg("dim", k.padEnd(18))}${v}`;

		lines.push(label("Model:", d.model));
		lines.push(label("Directory:", d.directory));
		if (d.email) {
			lines.push(label("Account:", `${d.email} (${titleCase(d.planType)})`));
		} else {
			lines.push(label("Account:", `(${titleCase(d.planType)})`));
		}
		lines.push("");

		const addRateLimits = (details: RateLimitDetails | null | undefined, heading?: string) => {
			if (!details) return;
			if (heading) {
				lines.push(`${pad}${fg("accent", heading)}`);
			}

			if (details.primary_window) {
				const w = details.primary_window;
				const remaining = 100 - w.used_percent;
				const color = barColor(w.used_percent, fg);
				const bar = color(`[${renderBar(w.used_percent)}]`);
				const pct = color(`${remaining}% left`);
				const reset = fg("dim", `(${formatResetTime(w.reset_at)})`);
				lines.push(`${pad}${fg("dim", windowLabel(w.limit_window_seconds).padEnd(18))}${bar} ${pct} ${reset}`);
			}

			if (details.secondary_window) {
				const w = details.secondary_window;
				const remaining = 100 - w.used_percent;
				const color = barColor(w.used_percent, fg);
				const bar = color(`[${renderBar(w.used_percent)}]`);
				const pct = color(`${remaining}% left`);
				const reset = fg("dim", `(${formatResetTime(w.reset_at)})`);
				lines.push(`${pad}${fg("dim", windowLabel(w.limit_window_seconds).padEnd(18))}${bar} ${pct} ${reset}`);
			}
		};

		addRateLimits(d.usage.rate_limit);

		if (d.usage.additional_rate_limits) {
			for (const extra of d.usage.additional_rate_limits) {
				lines.push("");
				addRateLimits(extra.rate_limit, `${extra.limit_name}:`);
			}
		}

		lines.push("");
		lines.push(`${pad}${fg("dim", "Press q, Esc, or Ctrl+C to dismiss")}`);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines.map((l) => truncateToWidth(l, width));
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

export default function statusExtension(pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show session status and rate limits",
		async handler(_args, ctx: ExtensionCommandContext) {
			if (!ctx.hasUI) {
				ctx.ui.notify("/status requires interactive mode", "error");
				return;
			}

			const authStorage = ctx.modelRegistry.authStorage;
			const cred = authStorage.get("openai-codex");
			if (!cred || cred.type !== "oauth") {
				ctx.ui.notify("Not logged in to OpenAI Codex. Use /login first.", "error");
				return;
			}

			const result = await ctx.ui.custom<StatusData | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Fetching status...");
				loader.onAbort = () => done(null);

				const doFetch = async () => {
					const token = await authStorage.getApiKey("openai-codex");
					if (!token) throw new Error("Failed to get API key");

					const accountId = (cred as Record<string, unknown>).accountId as string | undefined;
					if (!accountId) throw new Error("No accountId in credentials");

					const usage = await fetchUsage(token, accountId);
					const jwt = decodeJwt(token);
					const email = (jwt?.email as string) ?? undefined;

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
					};
				};

				doFetch().then(done).catch(() => done(null));
				return loader;
			});

			if (!result) {
				ctx.ui.notify("Failed to fetch status", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new StatusComponent(result, theme, () => done());
			});
		},
	});
}
