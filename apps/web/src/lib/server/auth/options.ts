import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter } from "next-auth/adapters";
import type { NextAuthOptions, Session } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import KakaoProvider from "next-auth/providers/kakao";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { mockUserEmail, mockUserId, mockUserName } from "./mockIdentity";

ensureAuthEnv();

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
  },
  providers: createProviders(),
  callbacks: {
    session({ session, token }) {
      return attachSessionUserId(session, token.sub);
    },
  },
};

const adapter = createAuthAdapter();
if (adapter) authOptions.adapter = adapter;

const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
if (secret) authOptions.secret = secret;

function createProviders(): NextAuthOptions["providers"] {
  const providers: NextAuthOptions["providers"] = [
    CredentialsProvider({
      id: "demo",
      name: "Demo",
      credentials: {
        email: { label: "Email", type: "email" },
      },
      async authorize(credentials) {
        if (process.env.CUNOTE_AUTH_MODE !== "mock") return null;
        return {
          id: mockUserId(),
          email: credentials?.email ?? mockUserEmail(),
          name: mockUserName(),
        };
      },
    }),
  ];

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (googleClientId && googleClientSecret) {
    providers.push(GoogleProvider({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    }));
  }

  const kakaoClientId = process.env.KAKAO_CLIENT_ID;
  const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET;
  if (kakaoClientId && kakaoClientSecret) {
    providers.push(KakaoProvider({
      clientId: kakaoClientId,
      clientSecret: kakaoClientSecret,
    }));
  }

  return providers;
}

function createAuthAdapter(): NextAuthOptions["adapter"] {
  if (process.env.CUNOTE_AUTH_DB_ADAPTER !== "drizzle") return undefined;
  return DrizzleAdapter(getCunoteDb(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }) as unknown as Adapter;
}

function attachSessionUserId(session: Session, userId: string | undefined): Session {
  if (!userId || !session.user) return session;
  return {
    ...session,
    user: {
      ...session.user,
      id: userId,
    } as Session["user"] & { id: string },
  };
}

function ensureAuthEnv() {
  if (!process.env.NEXTAUTH_URL && process.env.NODE_ENV !== "production") {
    process.env.NEXTAUTH_URL = "https://dev.changupnote.com";
  }
}
