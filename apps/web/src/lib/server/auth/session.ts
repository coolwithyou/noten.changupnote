import { getServerSession } from "next-auth";
import { authOptions } from "./options";
import { mockUserEmail, mockUserId, mockUserName } from "./mockIdentity";

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
        id: mockUserId(),
        email: mockUserEmail(),
        name: mockUserName(),
      },
      provider: "mock",
    };
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session?.user || !userId) return null;
  return {
    user: {
      id: userId,
      email: session.user.email ?? null,
      name: session.user.name ?? null,
    },
    provider: "nextauth",
  };
}

export async function requireWebSession(): Promise<WebSession> {
  const session = await getOptionalWebSession();
  if (session) return session;
  throw new AuthRequiredError();
}
