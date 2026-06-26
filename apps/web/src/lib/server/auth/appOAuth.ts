import type { AppTokenResponse } from "./appIssueToken";
import { issueAppTokens } from "./appIssueToken";
import { mockUserEmail, mockUserId } from "./mockIdentity";

export const SUPPORTED_APP_OAUTH_PROVIDERS = ["google", "kakao"] as const;
export type AppOAuthProvider = typeof SUPPORTED_APP_OAUTH_PROVIDERS[number];

export interface AppOAuthExchangeInput {
  provider: string;
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  deviceId?: string;
}

export class AppOAuthExchangeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export function isAppOAuthExchangeAllowed(): boolean {
  return (
    process.env.CUNOTE_AUTH_MODE === "mock" ||
    process.env.CUNOTE_APP_AUTH_ALLOW_DEV_OAUTH === "true" ||
    process.env.CUNOTE_APP_AUTH_ALLOW_DEV_LOGIN === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

export function normalizeAppOAuthProvider(provider: string): AppOAuthProvider | null {
  const normalized = provider.trim().toLowerCase();
  return isAppOAuthProvider(normalized) ? normalized : null;
}

export async function issueDevAppOAuthTokens(input: AppOAuthExchangeInput): Promise<AppTokenResponse> {
  const provider = normalizeAppOAuthProvider(input.provider);
  if (!provider) {
    throw new AppOAuthExchangeError(
      "invalid_auth_request",
      "지원하지 않는 OAuth provider입니다.",
      400,
      "provider",
    );
  }

  if (!input.code?.trim()) {
    throw new AppOAuthExchangeError("invalid_auth_request", "code가 필요합니다.", 400, "code");
  }

  const tokenInput: Parameters<typeof issueAppTokens>[0] = {
    userId: mockUserId(),
    email: mockUserEmail(),
  };
  if (input.deviceId?.trim()) tokenInput.deviceId = input.deviceId.trim();

  return issueAppTokens(tokenInput);
}

function isAppOAuthProvider(value: string): value is AppOAuthProvider {
  return SUPPORTED_APP_OAUTH_PROVIDERS.includes(value as AppOAuthProvider);
}
