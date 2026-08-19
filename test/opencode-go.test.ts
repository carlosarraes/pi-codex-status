import assert from "node:assert/strict";
import test from "node:test";

import {
	fetchOpenCodeGoUsage,
	resolveOpenCodeGoApiKey,
	type FetchLike,
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
