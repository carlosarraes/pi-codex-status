import assert from "node:assert/strict";
import test from "node:test";

import { runStatusModal, type StatusAction } from "../src/status-modal.ts";
import type { StatusProvider } from "../src/status-target.ts";

test("runStatusModal lazily loads each provider once and reuses cached data", async () => {
	const loads: StatusProvider[] = [];
	const shown: Array<{ provider: StatusProvider; data: string }> = [];
	const actions: StatusAction[] = ["switch", "switch", "dismiss"];

	await runStatusModal("codex", {
		load: async (provider) => {
			loads.push(provider);
			return `${provider}-data`;
		},
		show: async (provider, data) => {
			shown.push({ provider, data });
			return actions.shift() ?? "dismiss";
		},
		notifyError: () => assert.fail("unexpected error"),
	});

	assert.deepEqual(loads, ["codex", "opencode-go"]);
	assert.deepEqual(shown, [
		{ provider: "codex", data: "codex-data" },
		{ provider: "opencode-go", data: "opencode-go-data" },
		{ provider: "codex", data: "codex-data" },
	]);
});

test("runStatusModal returns to the previous provider after a switch fails", async () => {
	const shown: StatusProvider[] = [];
	const errors: Array<{ provider: StatusProvider; message: string }> = [];

	await runStatusModal("codex", {
		load: async (provider) => {
			if (provider === "opencode-go") throw new Error("usage unavailable");
			return "codex-data";
		},
		show: async (provider) => {
			shown.push(provider);
			return shown.length === 1 ? "switch" : "dismiss";
		},
		notifyError: (provider, error) => {
			errors.push({
				provider,
				message: error instanceof Error ? error.message : "unknown",
			});
		},
	});

	assert.deepEqual(shown, ["codex", "codex"]);
	assert.deepEqual(errors, [{ provider: "opencode-go", message: "usage unavailable" }]);
});

test("runStatusModal closes after an initial failure or cancelled load", async () => {
	let shows = 0;
	let errors = 0;

	await runStatusModal("opencode-go", {
		load: async () => {
			throw new Error("initial failure");
		},
		show: async () => {
			shows += 1;
			return "dismiss";
		},
		notifyError: () => {
			errors += 1;
		},
	});

	await runStatusModal("opencode-go", {
		load: async () => null,
		show: async () => {
			shows += 1;
			return "dismiss";
		},
		notifyError: () => {
			errors += 1;
		},
	});

	assert.equal(shows, 0);
	assert.equal(errors, 1);
});
