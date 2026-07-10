import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { getAdminSql } from "@/lib/server/db/client";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { callWebInternal, WebInternalUnavailableError } from "@/lib/server/credits/webInternalClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "admin"); // 12.3: 강제 해지는 admin+.

    const [{ id }, body] = await Promise.all([context.params, readJson(request)]);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return adminError("reason_required", "강제 해지 사유가 필요합니다.", 400, "reason");

    const sql = getAdminSql();
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM credit_plan_subscriptions WHERE id = ${id}
    `;
    const existing = rows[0];
    if (!existing) return adminError("subscription_not_found", "구독을 찾을 수 없습니다.", 404);

    // 8.5: 웹앱 내부 엔드포인트로 위임 — cancelSchedules 선행 후 즉시 canceled 전이.
    const result = await callWebInternal<{ kind: string; previousStatus?: string; status?: string }>(
      `/api/internal/credits/subscriptions/${encodeURIComponent(id)}/force-cancel`,
      { reason, adminActor: session.user.id },
    );

    if (!result.ok) {
      return adminError(result.error?.code ?? "force_cancel_failed", result.error?.message ?? "강제 해지 실패", result.status || 502);
    }

    // 감사(subscription.forced_cancel — 웹 트랜잭션에서도 남지만 admin 개시 기록).
    await insertCreditAuditLog({
      action: "subscription.forced_cancel",
      actorSession: session,
      targetType: "subscription",
      targetId: id,
      before: { status: existing.status },
      after: { kind: result.data?.kind ?? null, status: result.data?.status ?? "canceled" },
      reason,
    });

    return adminData({ canceled: result.data?.kind === "canceled" || result.data?.kind === "already_terminal", ...(result.data ?? {}) });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof WebInternalUnavailableError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
