import { NextResponse, type NextRequest } from "next/server";

const OPS_ADMIN_ORIGIN = process.env.CUNOTE_OPS_ADMIN_ORIGIN ?? "https://ops.changupnote.com";
const CLOSED_ADMIN_API_PREFIXES = [
  "/api/admin",
  "/api/matches/live",
];
const CLOSED_ADMIN_PAGE_PREFIXES = [
  "/admin",
  "/internal/live-match",
];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (CLOSED_ADMIN_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.json({
      error: {
        code: "admin_moved_to_ops",
        message: "운영자 API는 ops.changupnote.com에서만 사용할 수 있습니다.",
      },
    }, { status: 404 });
  }

  if (CLOSED_ADMIN_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.redirect(new URL(`${pathname}${search}`, OPS_ADMIN_ORIGIN));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/internal/live-match/:path*",
    "/api/admin/:path*",
    "/api/matches/live",
  ],
};
