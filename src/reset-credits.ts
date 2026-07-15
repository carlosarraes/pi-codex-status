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
