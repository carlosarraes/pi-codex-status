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
