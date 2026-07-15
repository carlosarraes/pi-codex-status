import assert from "node:assert/strict";
import test from "node:test";

import {
	buildResetCreditsView,
	fetchResetCreditDetails,
	formatResetCredits,
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
