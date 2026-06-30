import type { ActionResult } from "@cunote/contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getCunoteDb } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/server/auth/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AccountPasswordChangeResult {
  changed: true;
  mode: "changed" | "created";
}

export async function PUT(request: Request) {
  try {
    const [session, body] = await Promise.all([
      requireWebSession(),
      readBody(request),
    ]);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = validatePassword(body.newPassword);
    if (!newPassword.ok || !newPassword.password) {
      return actionError("invalid_password", newPassword.error ?? "새 비밀번호를 확인해주세요.", "newPassword", 400);
    }

    const db = getCunoteDb();
    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (!user) return actionError("user_not_found", "계정을 찾지 못했습니다.", undefined, 404);

    const mode: AccountPasswordChangeResult["mode"] = user.passwordHash ? "changed" : "created";
    if (user.passwordHash) {
      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) return actionError("current_password_invalid", "현재 비밀번호가 올바르지 않습니다.", "currentPassword", 400);
    }

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword.password) })
      .where(eq(users.id, user.id));

    return NextResponse.json<ActionResult<AccountPasswordChangeResult>>({
      ok: true,
      data: { changed: true, mode },
    });
  } catch (error) {
    return webActionError<AccountPasswordChangeResult>(error, {
      code: "account_password_change_failed",
      message: "비밀번호를 변경하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function actionError(code: string, message: string, field?: string, status = 400) {
  return NextResponse.json<ActionResult<null>>({
    ok: false,
    error: {
      code,
      message,
      ...(field ? { field } : {}),
    },
  }, { status });
}
