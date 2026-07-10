import type { NextRequest } from "next/server";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { getNumericSetting } from "@/lib/server/credits/settings";
import { applyAdminGrant, applyAdminDeduct } from "@/lib/server/credits/grantTx";

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
    const direction = body.direction === "grant" || body.direction === "deduct" ? body.direction : null;
    const credits = typeof body.credits === "number" ? body.credits : NaN;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
    const expiryDays =
      typeof body.expiryDays === "number" && Number.isInteger(body.expiryDays) && body.expiryDays > 0
        ? body.expiryDays
        : 90;

    // 1. reason 필수
    if (!reason) return adminError("reason_required", "사유를 입력해주세요.", 400, "reason");
    // 2. nonce 필수
    if (!nonce) return adminError("nonce_required", "요청 식별자가 필요합니다.", 400, "nonce");
    // 3. direction / credits 양의 정수
    if (!direction) return adminError("invalid_direction", "지급 또는 차감을 선택해주세요.", 400, "direction");
    if (!Number.isInteger(credits) || credits <= 0) {
      return adminError("invalid_credits", "크레딧은 양의 정수여야 합니다.", 400, "credits");
    }

    const sql = getAdminSql();

    // 4. 자기계정 하드차단
    const selfRows = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${session.user.email}
    `;
    if (selfRows[0]?.id === userId) {
      return adminError("self_grant_forbidden", "본인 계정에는 지급/차감할 수 없습니다.", 403);
    }

    // 5. 임계 초과 grant → 대기(승인 필요)
    if (direction === "grant") {
      const threshold = await getNumericSetting("admin_grant_review_threshold", 50_000);
      if (credits > threshold) {
        await insertCreditAuditLog({
          action: "ledger.grant_pending",
          actorSession: session,
          targetType: "user",
          targetId: userId,
          after: { direction, credits, reason, nonce, requestedBy: session.user.id },
          reason,
        });
        return adminData(
          { pending: true, message: "지급 승인 대기 중입니다." },
          { status: 202 },
        );
      }
    }

    // 6. 차감인데 잔액이 없으면 트랜잭션 전에 막는다(amount_credits=0 금지).
    if (direction === "deduct") {
      const balRows = await sql<{ balance_credits: number }[]>`
        SELECT balance_credits FROM credit_wallets WHERE user_id = ${userId}
      `;
      if (!balRows[0]) return adminError("wallet_not_found", "지갑을 찾을 수 없습니다.", 404);
      if (Number(balRows[0].balance_credits) <= 0) {
        return adminError("no_balance_to_deduct", "차감할 잔액이 없습니다.", 400);
      }
    }

    // 5.2 트랜잭션
    const result = await sql.begin(async (tx) => {
      if (direction === "grant") {
        return applyAdminGrant(tx, {
          userId,
          credits,
          reason,
          expiryDays,
          nonce,
          actorId: session.user.id,
        });
      }
      const deduct = await applyAdminDeduct(tx, {
        userId,
        credits,
        reason,
        nonce,
        actorId: session.user.id,
      });
      return deduct;
    });

    if (!result.idempotent) {
      await insertCreditAuditLog({
        action: direction === "grant" ? "ledger.admin_grant" : "ledger.admin_deduct",
        actorSession: session,
        targetType: "user",
        targetId: userId,
        after: { credits, balanceAfter: result.balanceAfter, entryId: result.entryId },
        reason,
      });
    }

    return adminData(result);
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
