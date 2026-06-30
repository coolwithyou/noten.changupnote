import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import {
  completePasswordReset,
  PasswordResetError,
  type PasswordResetCompleteResult,
} from "@/lib/server/auth/passwordReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await completePasswordReset({
      token: body.token,
      password: body.password,
    });

    return NextResponse.json<ActionResult<PasswordResetCompleteResult>>({
      ok: true,
      data: result,
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
      error: { code: "password_reset_failed", message: "비밀번호를 변경하지 못했습니다." },
    }, { status: 500 });
  }
}
