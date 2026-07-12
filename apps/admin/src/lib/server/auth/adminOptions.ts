import type { NextAuthOptions, Profile, User } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import {
  authenticateAdminPassword,
  findAdminUserById,
  findOrLinkGoogleAdminUser,
  isAllowedAdminEmail,
  type AdminRole,
} from "./adminUsers";
import { normalizeEmail, validateAdminPassword } from "./password";

ensureAdminAuthEnv();

const adminCookieSecure =
  process.env.NODE_ENV === "production"
  || isHttpsUrl(process.env.NEXTAUTH_URL)
  || isHttpsUrl(process.env.ADMIN_AUTH_URL);

type AdminUserShape = User & {
  role?: AdminRole;
};

interface GoogleProfile extends Profile {
  email?: string;
  email_verified?: boolean;
  hd?: string;
}

export const adminAuthOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  cookies: {
    sessionToken: {
      name: process.env.ADMIN_SESSION_COOKIE_NAME ?? "__Secure-cunote-admin.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: adminCookieSecure,
      },
    },
    csrfToken: {
      name: process.env.ADMIN_CSRF_COOKIE_NAME ?? "__Host-cunote-admin.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: adminCookieSecure,
      },
    },
    callbackUrl: {
      name: process.env.ADMIN_CALLBACK_COOKIE_NAME ?? "__Secure-cunote-admin.callback-url",
      options: {
        sameSite: "lax",
        path: "/",
        secure: adminCookieSecure,
      },
    },
  },
  providers: createAdminProviders(),
  callbacks: {
    async signIn({ account, profile, user }) {
      if (account?.provider !== "google") return true;
      const googleProfile = profile as GoogleProfile | undefined;
      const email = normalizeEmail(googleProfile?.email ?? user.email ?? "");
      if (!email || !isAllowedGoogleDomain(email, googleProfile)) return false;
      if (googleProfile?.email_verified === false) return false;
      if (!isAllowedAdminEmail(email)) return false;

      const adminUser = await findOrLinkGoogleAdminUser({
        email,
        name: user.name ?? googleProfile?.name ?? null,
        providerAccountId: account.providerAccountId,
      });
      if (!adminUser) return false;
      (user as AdminUserShape).id = adminUser.id;
      (user as AdminUserShape).role = adminUser.role;
      user.email = adminUser.email;
      user.name = adminUser.name;
      return true;
    },
    async jwt({ token, user }) {
      const adminUser = user as AdminUserShape | undefined;
      if (adminUser?.id) {
        token.sub = adminUser.id;
        if (adminUser.role) token.role = adminUser.role;
      }
      if (!token.role && token.sub) {
        const current = await findAdminUserById(token.sub);
        if (!current || current.status !== "active") return {};
        token.role = current.role;
        token.email = current.email;
        token.name = current.name;
      }
      return token;
    },
    session({ session, token }) {
      if (!session.user || !token.sub || !token.role) return session;
      session.user = {
        ...session.user,
        id: token.sub,
        role: token.role as AdminRole,
      } as typeof session.user & { id: string; role: AdminRole };
      return session;
    },
  },
};

const secret = process.env.ADMIN_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
if (secret) adminAuthOptions.secret = secret;

function createAdminProviders(): NextAuthOptions["providers"] {
  const providers: NextAuthOptions["providers"] = [];

  providers.push(CredentialsProvider({
    id: "password",
    name: "이메일",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) return null;
      const email = normalizeEmail(credentials.email);
      if (!isAllowedAdminEmail(email) || !validateAdminPassword(credentials.password)) return null;
      const user = await authenticateAdminPassword(email, credentials.password);
      if (!user) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      } as AdminUserShape;
    },
  }));

  // changupnote.com 사용자 프론트와 동일한 Google OAuth 클라이언트를 재사용한다.
  // 로그인 허용 범위는 클라이언트가 아니라 아래 signIn 콜백의 도메인·admin_users 등록 여부로 제한한다.
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (googleClientId && googleClientSecret) {
    providers.push(GoogleProvider({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      authorization: {
        params: {
          hd: allowedGoogleDomain(),
        },
      },
    }));
  }

  return providers;
}

function isAllowedGoogleDomain(email: string, profile: GoogleProfile | undefined): boolean {
  const domain = allowedGoogleDomain();
  if (!email.endsWith(`@${domain}`)) return false;
  return !profile?.hd || profile.hd === domain;
}

function allowedGoogleDomain(): string {
  return normalizeEmail(process.env.ADMIN_ALLOWED_GOOGLE_DOMAIN ?? "noten.im").replace(/^@/, "");
}

function ensureAdminAuthEnv() {
  if (!process.env.NEXTAUTH_URL && process.env.ADMIN_AUTH_URL) {
    process.env.NEXTAUTH_URL = process.env.ADMIN_AUTH_URL;
  }
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
