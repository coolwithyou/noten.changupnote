import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/_next",
  "/favicon.ico",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }

  const secret = process.env.ADMIN_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  const token = secret
    ? await getToken({
      req: request,
      secret,
      cookieName: process.env.ADMIN_SESSION_COOKIE_NAME ?? "__Secure-cunote-admin.session-token",
    })
    : null;

  if (token?.sub && token.role) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "admin_auth_required", message: "어드민 로그인이 필요합니다." } },
      { status: 401 },
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)"],
};
