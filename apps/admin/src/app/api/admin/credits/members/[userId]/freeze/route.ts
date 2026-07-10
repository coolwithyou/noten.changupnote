import type { NextRequest } from "next/server";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { callWebInternal, WebInternalUnavailableError } from "@/lib/server/credits/webInternalClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ userId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "admin");

    const { userId } = await context.params;
    if (!userId) return adminError("invalid_route_param", "요청 경로를 확인해주세요.", 400);

    const body = await readJson(request);
    const frozen = body.frozen === true;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    // 4.1: 동결 시 활성 구독의 다음 예약결제 취소 여부. 기본 true(취소하지 않으면 plan_grant 지급이
    //      freeze 예외 목록에 없어 지급되므로 — 동결 시 예약 취소를 기본값으로 한다).
    const cancelSchedules = frozen && body.cancelSchedules !== false;

    if (!reason) return adminError("reason_required", "사유를 입력해주세요.", 400, "reason");

    const sql = getAdminSql();

    const beforeRows = await sql<{ id: string; status: string; frozen_reason: string | null }[]>`
      SELECT id, status, frozen_reason FROM credit_wallets WHERE user_id = ${userId}
    `;
    const beforeWallet = beforeRows[0];
    if (!beforeWallet) return adminError("wallet_not_found", "지갑을 찾을 수 없습니다.", 404);

    const walletId = beforeWallet.id;
    const nextStatus = frozen ? "frozen" : "active";
    const nextFrozenReason = frozen ? reason : null;

    await sql`
      UPDATE credit_wallets
      SET status = ${nextStatus}, frozen_reason = ${nextFrozenReason}, updated_at = now()
      WHERE user_id = ${userId}
    `;

    // 4.1: 동결 시 활성 구독의 예약 전부 취소(구독은 유지 — 예약만 제거). 웹앱 내부 엔드포인트로 위임.
    let schedulesCanceled = false;
    let scheduleCancelWarning: string | null = null;
    if (cancelSchedules) {
      try {
        const result = await callWebInternal<{ kind: string; canceledSchedules: boolean; subscriptionId?: string }>(
          "/api/internal/credits/subscriptions/cancel-schedules-for-user",
          { userId },
        );
        if (result.ok) {
          schedulesCanceled = result.data?.canceledSchedules === true;
        } else {
          // 예약 취소 실패는 동결 자체를 되돌리지 않는다(동결은 이미 반영). 경고로 노출해 수동 확인 유도.
          scheduleCancelWarning = result.error?.message ?? "예약 취소에 실패했습니다(수동 확인 필요).";
        }
      } catch (error) {
        if (error instanceof WebInternalUnavailableError) {
          scheduleCancelWarning = error.message;
        } else {
          scheduleCancelWarning = error instanceof Error ? error.message : "예약 취소 중 오류(수동 확인 필요).";
        }
      }
    }

    await insertCreditAuditLog({
      action: frozen ? "wallet.frozen" : "wallet.unfrozen",
      actorSession: session,
      targetType: "wallet",
      targetId: walletId,
      before: { status: beforeWallet.status, frozen_reason: beforeWallet.frozen_reason },
      after: { status: nextStatus, reason, cancelSchedules, schedulesCanceled },
      reason,
    });

    return adminData({
      walletId,
      status: nextStatus,
      cancelSchedules,
      schedulesCanceled,
      ...(scheduleCancelWarning ? { warning: scheduleCancelWarning } : {}),
    });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
