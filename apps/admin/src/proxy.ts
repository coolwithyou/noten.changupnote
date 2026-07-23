import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import {
  canAccessAdminPath,
  defaultAdminPath,
} from "@/lib/auth/routeAccess";
import type { AdminRole } from "@/lib/server/auth/adminUsers";

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

  if (token?.sub && token.role) {
    const role = token.role as AdminRole;
    // 보조 방어다. 모든 API는 requireAdminRole/requireAnyAdminRole을 별도로 호출한다.
    if (canAccessAdminPath(role, pathname)) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: { code: "insufficient_role", message: "이 경로에 접근할 권한이 없습니다." } },
        { status: 403 },
      );
    }
    const fallback = request.nextUrl.clone();
    fallback.pathname = defaultAdminPath(role);
    fallback.search = "";
    return NextResponse.redirect(fallback);
  }

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
