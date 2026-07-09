import type { NextRequest } from "next/server";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";

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

    await insertCreditAuditLog({
      action: frozen ? "wallet.frozen" : "wallet.unfrozen",
      actorSession: session,
      targetType: "wallet",
      targetId: walletId,
      before: { status: beforeWallet.status, frozen_reason: beforeWallet.frozen_reason },
      after: { status: nextStatus, reason },
      reason,
    });

    // TODO(P4): 지갑 동결 시 활성 구독의 다음 결제 예약 취소를 자동화한다.
    //           현재는 P3/P4 미구현이라 운영자가 수동으로 확인해야 한다.
    return adminData({
      walletId,
      status: nextStatus,
      warning: "활성 구독의 다음 결제 예약 취소는 P4 이후 지원됩니다(수동 확인 필요).",
    });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
