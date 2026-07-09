import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { getAdminSql } from "@/lib/server/db/client";
import { adminData, adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const params = new URL(request.url).searchParams;
    const actor = params.get("actor");
    const action = params.get("action");
    const targetType = params.get("targetType");
    const targetId = params.get("targetId");
    const from = params.get("from");
    const to = params.get("to");
    const cursor = params.get("cursor");
    const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const sql = getAdminSql();
    const logs = await sql`
      SELECT * FROM credit_audit_logs
      WHERE (${actor ?? null}::text IS NULL OR actor_id = ${actor ?? null})
        AND (${action ?? null}::text IS NULL OR action = ${action ?? null})
        AND (${targetType ?? null}::text IS NULL OR target_type = ${targetType ?? null})
        AND (${targetId ?? null}::text IS NULL OR target_id = ${targetId ?? null})
        AND (${from ?? null}::timestamptz IS NULL OR created_at >= ${from ?? null}::timestamptz)
        AND (${to ?? null}::timestamptz IS NULL OR created_at <= ${to ?? null}::timestamptz)
        AND (${cursor ?? null}::timestamptz IS NULL OR created_at < ${cursor ?? null}::timestamptz)
      ORDER BY created_at DESC LIMIT ${limit}
    `;

    const last = logs[logs.length - 1];
    const nextCursor =
      logs.length === limit && last ? new Date(last.created_at as string).toISOString() : null;

    // 감사 로그 화면 접근 자체를 감사 로그로 기록 (조회 결과 반환 후 기록)
    await insertCreditAuditLog({
      action: "audit.viewed",
      actorSession: session,
      targetType: "audit_log",
      targetId: "list",
      after: {
        filters: {
          actor: actor ?? null,
          action: action ?? null,
          targetType: targetType ?? null,
          targetId: targetId ?? null,
          from: from ?? null,
          to: to ?? null,
          cursor: cursor ?? null,
          limit,
        },
      },
    });

    return adminData({ logs, nextCursor });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
