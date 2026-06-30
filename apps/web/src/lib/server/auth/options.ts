import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter } from "next-auth/adapters";
import type { Account, NextAuthOptions, Session } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import KakaoProvider from "next-auth/providers/kakao";
import { eq, sql } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { mockUserEmail, mockUserId, mockUserName } from "./mockIdentity";
import { normalizeEmail, verifyPassword } from "./password";

ensureAuthEnv();

export interface WebAuthProviderSummary {
  id: string;
  name: string;
  kind: "credentials" | "oauth";
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
  },
  providers: createProviders(),
  callbacks: {
    async jwt({ token, user, account }) {
      const userId = await resolveSessionUserId({
        tokenSub: token.sub,
        email: user?.email ?? token.email,
        name: user?.name ?? token.name,
        image: user?.image ?? token.picture,
        account,
      });
      if (userId) token.sub = userId;
      return token;
    },
    session({ session, token }) {
      return attachSessionUserId(session, token.sub);
    },
  },
};

const adapter = createAuthAdapter();
if (adapter) authOptions.adapter = adapter;

const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
if (secret) authOptions.secret = secret;

export function getWebAuthProviderSummaries(env: NodeJS.ProcessEnv = process.env): WebAuthProviderSummary[] {
  const providers: WebAuthProviderSummary[] = [];
  if (env.CUNOTE_AUTH_MODE === "mock") {
    providers.push({ id: "demo", name: "Demo", kind: "credentials" });
  }
  providers.push({ id: "password", name: "이메일", kind: "credentials" });
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push({ id: "google", name: "Google", kind: "oauth" });
  }
  if (env.KAKAO_CLIENT_ID && env.KAKAO_CLIENT_SECRET) {
    providers.push({ id: "kakao", name: "Kakao", kind: "oauth" });
  }
  return providers;
}

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
    CredentialsProvider({
      id: "password",
      name: "이메일",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const email = normalizeEmail(credentials.email);
        const db = getCunoteDb();
        const [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);
        if (!user?.passwordHash) return null;
        const valid = await verifyPassword(credentials.password, user.passwordHash);
        if (!valid) return null;
        return { id: user.id, email: user.email, name: user.name ?? null };
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

async function resolveSessionUserId(input: {
  tokenSub?: string | undefined;
  email?: string | null | undefined;
  name?: string | null | undefined;
  image?: string | null | undefined;
  account?: Account | null | undefined;
}): Promise<string | undefined> {
  if (input.tokenSub && isUuid(input.tokenSub)) return input.tokenSub;
  if (!input.email) return input.tokenSub;

  const email = normalizeEmail(input.email);
  const db = getCunoteDb();
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) {
    await linkOAuthAccount(existing.id, input.account);
    return existing.id;
  }

  const userId = await createOAuthUser({
    email,
    name: input.name ?? null,
    image: input.image ?? null,
  }) ?? await resolveUserIdByEmail(email);
  if (userId) await linkOAuthAccount(userId, input.account);
  return userId ?? input.tokenSub;
}

async function createOAuthUser(input: {
  email: string;
  name: string | null;
  image: string | null;
}): Promise<string | undefined> {
  const rows = await getCunoteDb().execute<{ id: string }>(sql`
    insert into users (email, name, image)
    values (${input.email}, ${input.name}, ${input.image})
    on conflict (email) do nothing
    returning id
  `);
  return rows[0]?.id;
}

async function resolveUserIdByEmail(email: string): Promise<string | undefined> {
  const [user] = await getCunoteDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return user?.id;
}

async function linkOAuthAccount(userId: string, account: Account | null | undefined) {
  if (!account || account.type !== "oauth") return;
  await getCunoteDb()
    .insert(schema.accounts)
    .values({
      userId,
      type: account.type,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      refresh_token: account.refresh_token,
      access_token: account.access_token,
      expires_at: account.expires_at,
      token_type: account.token_type,
      scope: account.scope,
      id_token: account.id_token,
      session_state: account.session_state,
    })
    .onConflictDoUpdate({
      target: [schema.accounts.provider, schema.accounts.providerAccountId],
      set: { userId },
    });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function ensureAuthEnv() {
  if (!process.env.NEXTAUTH_URL && process.env.NODE_ENV !== "production") {
    process.env.NEXTAUTH_URL = "https://dev.changupnote.com";
  }
}
