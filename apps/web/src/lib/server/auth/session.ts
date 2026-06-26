export interface WebSession {
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
  };
  provider: "nextauth" | "mock";
}

export class AuthRequiredError extends Error {
  readonly status = 401;
  readonly code = "auth_required";

  constructor(message = "로그인이 필요합니다.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export function isAuthEnforced(): boolean {
  return process.env.CUNOTE_AUTH_REQUIRED === "true";
}

export async function getOptionalWebSession(): Promise<WebSession | null> {
  if (process.env.CUNOTE_AUTH_MODE === "mock") {
    return {
      user: {
        id: process.env.CUNOTE_MOCK_USER_ID ?? "demo-user",
        email: process.env.CUNOTE_MOCK_USER_EMAIL ?? null,
        name: process.env.CUNOTE_MOCK_USER_NAME ?? "Demo User",
      },
      provider: "mock",
    };
  }

  return null;
}

export async function requireWebSession(): Promise<WebSession> {
  const session = await getOptionalWebSession();
  if (session) return session;
  throw new AuthRequiredError();
}
