import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import {
  PasswordResetError,
  requestPasswordReset,
  type PasswordResetRequestReceipt,
} from "@/lib/server/auth/passwordReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const origin = new URL(request.url).origin;
    const receipt = await requestPasswordReset({
      email: body.email,
      origin,
      callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : null,
    });

    return NextResponse.json<ActionResult<PasswordResetRequestReceipt>>({
      ok: true,
      data: receipt,
    });
  } catch (error) {
    if (error instanceof PasswordResetError) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: { code: error.code, message: error.message },
      }, { status: error.status });
    }

    return NextResponse.json<ActionResult<null>>({
      ok: false,
      error: { code: "password_reset_request_failed", message: "비밀번호 재설정 요청을 처리하지 못했습니다." },
    }, { status: 500 });
  }
}
