import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SettingRow {
  key: string;
  value: unknown;
  updated_by_admin_id: string | null;
  updated_at: string;
}

export async function GET() {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");
    const sql = getAdminSql();
    const settings = await sql<SettingRow[]>`
      SELECT key, value, updated_by_admin_id, updated_at
      FROM credit_settings
      ORDER BY key
    `;
    return adminData({ settings });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "owner");

    const body = await readJson(request);

    const key = typeof body.key === "string" ? body.key : null;
    const reason = typeof body.reason === "string" ? body.reason : null;

    if (!key) {
      return adminError("invalid_request", "key는 필수입니다.", 400, "key");
    }
    if (!reason) {
      return adminError("invalid_request", "reason은 필수입니다.", 400, "reason");
    }
    // value 누락 방어: JSON.stringify(undefined) === undefined 라 ::jsonb 바인딩이 깨진다.
    if (!("value" in body)) {
      return adminError("invalid_request", "value는 필수입니다.", 400, "value");
    }
    const value = body.value;

    const sql = getAdminSql();

    const beforeRows = await sql<{ value: unknown }[]>`
      SELECT value FROM credit_settings WHERE key = ${key}
    `;
    const before = beforeRows[0] ?? null;
    if (!before) {
      return adminError("setting_not_found", "해당 설정 키를 찾을 수 없습니다.", 404, "key");
    }

    await sql`
      UPDATE credit_settings
      SET value = ${JSON.stringify(value)}::jsonb,
          updated_by_admin_id = ${session.user.id},
          updated_at = now()
      WHERE key = ${key}
    `;

    await insertCreditAuditLog({
      action: "setting.updated",
      actorSession: session,
      targetType: "setting",
      targetId: key,
      before: { value: before.value },
      after: { value },
      reason,
    });

    return adminData({ ok: true });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
