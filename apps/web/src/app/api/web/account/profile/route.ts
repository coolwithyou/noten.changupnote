import type { ActionResult } from "@cunote/contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getCunoteDb } from "@/lib/server/db/client";
import { users } from "@/lib/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DISPLAY_NAME_MAX_LENGTH = 80;

export interface AccountProfileUpdateResult {
  id: string;
  email: string | null;
  name: string | null;
}

export async function PUT(request: Request) {
  try {
    const [session, body] = await Promise.all([
      requireWebSession(),
      readBody(request),
    ]);
    const name = normalizeDisplayName(body.name);
    if (!name.ok) {
      return actionError("invalid_name", name.error, "name", 400);
    }

    const db = getCunoteDb();
    const [updated] = await db
      .update(users)
      .set({ name: name.value })
      .where(eq(users.id, session.user.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
      });

    if (!updated) return actionError("user_not_found", "계정을 찾지 못했습니다.", undefined, 404);

    return NextResponse.json<ActionResult<AccountProfileUpdateResult>>({
      ok: true,
      data: {
        id: updated.id,
        email: updated.email,
        name: updated.name ?? null,
      },
    });
  } catch (error) {
    return webActionError<AccountProfileUpdateResult>(error, {
      code: "account_profile_update_failed",
      message: "프로필을 저장하지 못했습니다.",
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

function normalizeDisplayName(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "이름을 문자열로 입력해주세요." };

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return { ok: true, value: null };
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, error: `이름은 ${DISPLAY_NAME_MAX_LENGTH}자 이하로 입력해주세요.` };
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return { ok: false, error: "이름에 제어 문자를 포함할 수 없습니다." };
  }
  return { ok: true, value: normalized };
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
