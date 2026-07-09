import type { NextRequest } from "next/server";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { applyAdminGrant } from "@/lib/server/credits/grantTx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ userId: string }>;
}

interface PendingAfter {
  direction?: string;
  credits?: number;
  reason?: string;
  nonce?: string;
  requestedBy?: string;
  expiryDays?: number;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "owner");

    // userId는 라우트 파라미터로 받되, 실제 대상은 pendingLog.target_id를 신뢰한다.
    await context.params;

    const body = await readJson(request);
    const auditLogId = typeof body.auditLogId === "string" ? body.auditLogId.trim() : "";
    const approve = body.approve === true;
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

    if (!auditLogId) return adminError("audit_log_id_required", "감사 로그 ID가 필요합니다.", 400, "auditLogId");

    const sql = getAdminSql();

    const pendingRows = await sql<
      { id: string; target_id: string; after: PendingAfter | null }[]
    >`
      SELECT id, target_id, after
      FROM credit_audit_logs
      WHERE id = ${auditLogId} AND action = 'ledger.grant_pending'
    `;
    const pending = pendingRows[0];
    if (!pending) return adminError("pending_not_found", "대기 중인 지급 요청을 찾을 수 없습니다.", 404);

    // 중복 처리 체크
    const processedRows = await sql<{ id: string }[]>`
      SELECT id FROM credit_audit_logs
      WHERE action IN ('ledger.grant_approved','ledger.grant_rejected')
        AND after->>'pendingLogId' = ${auditLogId}
    `;
    if (processedRows[0]) {
      return adminError("already_processed", "이미 처리된 지급 요청입니다.", 409);
    }

    const after = pending.after ?? {};
    const targetUserId = pending.target_id;
    const credits = typeof after.credits === "number" ? after.credits : NaN;
    const pendingReason = typeof after.reason === "string" ? after.reason : "";
    const nonce = typeof after.nonce === "string" ? after.nonce : "";

    // 반려
    if (!approve) {
      await insertCreditAuditLog({
        action: "ledger.grant_rejected",
        actorSession: session,
        targetType: "user",
        targetId: targetUserId,
        after: { pendingLogId: auditLogId },
        reason,
      });
      return adminData({ approved: false });
    }

    // 승인 — pending 페이로드 유효성 재확인
    if (!Number.isInteger(credits) || credits <= 0 || !nonce) {
      return adminError("invalid_pending_payload", "대기 요청 데이터가 올바르지 않습니다.", 400);
    }

    // pending 페이로드에 expiryDays가 있으면 존중, 없으면 90일 기본값
    const pendingExpiryDays =
      typeof after.expiryDays === "number" && Number.isInteger(after.expiryDays) && after.expiryDays > 0
        ? after.expiryDays
        : 90;

    const result = await sql.begin(async (tx) =>
      applyAdminGrant(tx, {
        userId: targetUserId,
        credits,
        reason: pendingReason,
        expiryDays: pendingExpiryDays,
        nonce,
        actorId: session.user.id,
      }),
    );

    await insertCreditAuditLog({
      action: "ledger.grant_approved",
      actorSession: session,
      targetType: "user",
      targetId: targetUserId,
      after: { pendingLogId: auditLogId, entryId: result.entryId, credits },
      reason,
    });

    return adminData({ approved: true, entryId: result.entryId });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
