import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import {
  buildPasswordResetEmailHandoff,
  PasswordResetEmailHandoffError,
  passwordResetEmailHandoffDownloadResponse,
} from "@/lib/server/auth/passwordResetEmailHandoff";
import { shouldExposePasswordResetUrl } from "@/lib/server/auth/passwordReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!shouldExposePasswordResetUrl()) {
    return NextResponse.json<ActionResult<null>>({
      ok: false,
      error: {
        code: "password_reset_handoff_unavailable",
        message: "비밀번호 재설정 메일 파일은 운영 이메일 provider 설정 전 검증 환경에서만 사용할 수 있습니다.",
      },
    }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const handoff = buildPasswordResetEmailHandoff({
      email: body.email,
      resetUrl: body.resetUrl,
      expiresInMinutes: body.expiresInMinutes,
      origin: requestOrigin(request),
    });
    return passwordResetEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof PasswordResetEmailHandoffError) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        },
      }, { status: error.status });
    }
    return NextResponse.json<ActionResult<null>>({
      ok: false,
      error: {
        code: "password_reset_email_handoff_failed",
        message: "비밀번호 재설정 메일 파일을 만들지 못했습니다.",
      },
    }, { status: 500 });
  }
}

function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return url.origin;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "") ?? "https";
  return `${proto}://${host}`;
}
