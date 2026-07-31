import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexStatusAuth } from "../src/codex-auth.ts";

function jwtPayload(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("resolves status auth from the current provider auth result", async () => {
	const token = jwtPayload({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
		"https://api.openai.com/profile": { email: "user@example.com" },
	});
	let calls = 0;

	const result = await resolveCodexStatusAuth(async () => {
		calls += 1;
		return { auth: { apiKey: token } };
	});

	assert.deepEqual(result, {
		token,
		accountId: "account-123",
		email: "user@example.com",
	});
	assert.equal(calls, 1);
});

test("returns no status auth when provider auth or account identity is unavailable", async () => {
	assert.equal(await resolveCodexStatusAuth(async () => undefined), null);
	assert.equal(await resolveCodexStatusAuth(async () => ({ auth: {} })), null);

	const tokenWithoutAccount = jwtPayload({
		"https://api.openai.com/profile": { email: "user@example.com" },
	});
	assert.equal(
		await resolveCodexStatusAuth(async () => ({ auth: { apiKey: tokenWithoutAccount } })),
		null,
	);

	const tokenWithEmptyAccount = jwtPayload({
		"https://api.openai.com/auth": { chatgpt_account_id: "" },
	});
	assert.equal(
		await resolveCodexStatusAuth(async () => ({ auth: { apiKey: tokenWithEmptyAccount } })),
		null,
	);
});
