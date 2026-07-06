import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
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

export function isAuthEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CUNOTE_AUTH_REQUIRED === "true";
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

  let session: Session | null;
  try {
    session = await getServerSession(authOptions);
  } catch (error) {
    console.warn(`NextAuth optional session lookup failed: ${errorMessage(error)}`);
    return null;
  }

  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session?.user || !userId || !isUuid(userId)) return null;
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

export interface HeaderUser {
  name?: string | null;
  email?: string | null;
}

export function fallbackHeaderUserForDemoAccess(access: { mode: string }): HeaderUser | null {
  if (access.mode !== "demo") return null;
  return {
    name: mockUserName(),
    email: mockUserEmail(),
  };
}

/**
 * 헤더 계정 영역에 필요한 최소 사용자 정보. 로그인(또는 mock) 세션이 없으면 null.
 * 서버 컴포넌트에서 호출해 공유 헤더에 전달한다.
 */
export async function getOptionalHeaderUser(): Promise<HeaderUser | null> {
  const session = await getOptionalWebSession();
  if (!session) return null;
  return { name: session.user.name ?? null, email: session.user.email ?? null };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
