export type StatusProvider = "codex" | "opencode-go";

export const STATUS_ARGUMENTS = ["codex", "opencode-go", "ogo"] as const;

export function parseStatusTarget(args: string): StatusProvider | null {
	const target = args.trim().toLowerCase();
	if (target === "" || target === "codex") return "codex";
	if (target === "opencode-go" || target === "ogo") return "opencode-go";
	return null;
}
