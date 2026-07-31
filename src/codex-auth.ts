type ProviderAuthResult = {
	auth?: {
		apiKey?: unknown;
	};
};

export type CodexStatusAuth = {
	token: string;
	accountId: string;
	email?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwt(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function resolveCodexStatusAuth(
	getProviderAuth: () => Promise<ProviderAuthResult | undefined>,
): Promise<CodexStatusAuth | null> {
	const providerAuth = await getProviderAuth();
	const token = providerAuth?.auth?.apiKey;
	if (typeof token !== "string" || token.length === 0) return null;

	const payload = decodeJwt(token);
	const authClaims = payload?.["https://api.openai.com/auth"];
	if (
		!isRecord(authClaims) ||
		typeof authClaims.chatgpt_account_id !== "string" ||
		authClaims.chatgpt_account_id.length === 0
	) {
		return null;
	}

	const profileClaims = payload?.["https://api.openai.com/profile"];
	let email: string | undefined;
	if (typeof payload?.email === "string") {
		email = payload.email;
	} else if (isRecord(profileClaims) && typeof profileClaims.email === "string") {
		email = profileClaims.email;
	}

	return {
		token,
		accountId: authClaims.chatgpt_account_id,
		email,
	};
}
