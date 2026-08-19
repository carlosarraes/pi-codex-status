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
