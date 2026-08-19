import type { StatusProvider } from "./status-target.ts";

export type StatusAction = "switch" | "dismiss";

export type StatusModalDependencies<T> = {
	load: (provider: StatusProvider) => Promise<T | null>;
	show: (provider: StatusProvider, data: T) => Promise<StatusAction>;
	notifyError: (provider: StatusProvider, error: unknown) => void;
};

function otherProvider(provider: StatusProvider): StatusProvider {
	return provider === "codex" ? "opencode-go" : "codex";
}

export async function runStatusModal<T>(
	initialProvider: StatusProvider,
	dependencies: StatusModalDependencies<T>,
): Promise<void> {
	const cache = new Map<StatusProvider, T>();
	let activeProvider = initialProvider;
	let previousProvider: StatusProvider | null = null;

	while (true) {
		let data: T;
		if (cache.has(activeProvider)) {
			data = cache.get(activeProvider)!;
		} else {
			try {
				const loaded = await dependencies.load(activeProvider);
				if (loaded === null) return;
				data = loaded;
				cache.set(activeProvider, loaded);
			} catch (error) {
				dependencies.notifyError(activeProvider, error);
				if (!previousProvider) return;
				activeProvider = previousProvider;
				previousProvider = null;
				continue;
			}
		}

		const action = await dependencies.show(activeProvider, data);
		if (action === "dismiss") return;
		previousProvider = activeProvider;
		activeProvider = otherProvider(activeProvider);
	}
}
