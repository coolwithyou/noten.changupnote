import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { getAdminSql } from "@/lib/server/db/client";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "admin");

    const [{ id }, body] = await Promise.all([context.params, readJson(request)]);
    const reason = typeof body.reason === "string" ? body.reason : null;

    if (!reason) {
      return adminError("reason_required", "강제 취소 사유가 필요합니다.", 400, "reason");
    }

    const sql = getAdminSql();
    const rows = await sql`
      SELECT status FROM credit_plan_subscriptions WHERE id = ${id}
    `;
    const existing = rows[0];
    if (!existing) {
      return adminError("subscription_not_found", "구독을 찾을 수 없습니다.", 404);
    }

    // TODO: P4 완료 후 cancelSchedules(포트원) 연결 — 다음 결제 예약이 남아있을 수 있음
    await sql`
      UPDATE credit_plan_subscriptions
      SET status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE id = ${id}
    `;

    await insertCreditAuditLog({
      action: "subscription.forced_cancel",
      actorSession: session,
      targetType: "subscription",
      targetId: id,
      before: { status: existing.status as string },
      after: { status: "canceled" },
      reason,
    });

    return adminData({
      canceled: true,
      warning: "포트원 예약 취소는 P4 이후 지원. 예약 결제가 남아있을 수 있어 수동 확인 필요.",
    });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
