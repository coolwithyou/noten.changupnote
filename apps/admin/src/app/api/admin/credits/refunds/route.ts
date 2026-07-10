import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { callWebInternal, WebInternalUnavailableError } from "@/lib/server/credits/webInternalClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/credits/refunds
//   { action: "preview", orderId }            → viewer+ : 7.4 정책 계산 결과만(실행 없음, 11.5).
//   { orderId, reason } (action 생략/"execute") → admin+  : 환불 실행 + audit refund.executed/failed.
export async function POST(request: Request) {
  try {
    const session = await requireAdminSession();

    const body = await readJson(request);
    const action = typeof body.action === "string" ? body.action : "execute";
    const orderId = typeof body.orderId === "string" ? body.orderId : null;
    if (!orderId) return adminError("order_id_required", "orderId가 필요합니다.", 400, "orderId");

    // ── preview (조회 계열, viewer+) ──────────────────────────────────────
    if (action === "preview") {
      requireAdminRole(session, "viewer");
      const result = await callWebInternal<{ kind: string; order: unknown; calc: unknown; reason: string | null }>(
        "/api/internal/credits/refunds/preview",
        { orderId },
      );
      if (!result.ok) {
        return adminError(result.error?.code ?? "preview_failed", result.error?.message ?? "미리보기 실패", result.status || 502);
      }
      return adminData(result.data ?? {});
    }

    // ── execute (admin+) ──────────────────────────────────────────────────
    requireAdminRole(session, "admin"); // 12.3: 환불 실행은 admin+.
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return adminError("reason_required", "환불 사유가 필요합니다.", 400, "reason");

    const result = await callWebInternal<{
      kind: string;
      cancellation?: Record<string, unknown>;
      recovered?: number;
      shortfall?: number;
      frozen?: boolean;
      refundKrw?: number;
      refundKind?: string;
      message?: string;
    }>("/api/internal/credits/refunds", { orderId, reason, adminActor: session.user.id });

    if (!result.ok) {
      // 실패도 감사(refund.failed 는 웹 트랜잭션에서도 남지만, admin 개시 실패를 별도 기록).
      await insertCreditAuditLog({
        action: "refund.failed",
        actorSession: session,
        targetType: "payment_order",
        targetId: orderId,
        after: { code: result.error?.code ?? null, message: result.error?.message ?? null },
        reason,
      });
      return adminError(result.error?.code ?? "refund_failed", result.error?.message ?? "환불 실행 실패", result.status || 502);
    }

    // 성공(executed/pending) 감사(원장 완결 audit 은 웹 쪽 refund.executed — 여기는 admin 개시 기록).
    await insertCreditAuditLog({
      action: "refund.executed",
      actorSession: session,
      targetType: "payment_order",
      targetId: orderId,
      after: {
        kind: result.data?.kind ?? null,
        refundKrw: result.data?.refundKrw ?? null,
        refundKind: result.data?.refundKind ?? null,
        recovered: result.data?.recovered ?? null,
        shortfall: result.data?.shortfall ?? null,
        frozen: result.data?.frozen ?? null,
        cancellation: result.data?.cancellation ?? null,
      },
      reason,
    });

    return adminData(result.data ?? {});
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof WebInternalUnavailableError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
