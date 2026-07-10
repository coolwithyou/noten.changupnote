// POST /api/internal/credits/refunds (설계 9.3 / 7.4 executeRefund)
//
// { orderId, reason, adminActor } → executeRefund:
//   정책 계산 → portone.cancelPayment(Idempotency-Key: refund:{orderId}:{n차}) →
//     SUCCEEDED → 트랜잭션(refund_deduct targetLotIds + lot revoke + order refunded/partial_refunded)
//                 + refund.executed audit
//     REQUESTED → 대기(분개 없음 — Transaction.Cancelled 웹훅이 syncRefundFromPortone 로 완결·멱등)
//     FAILED    → 오류 + refund.failed audit
// admin(apps/admin) 이 서버 간 시크릿으로만 호출한다. audit 은 admin 쪽에서도 남기지만, 원장 완결
// 시점의 refund.executed/failed 는 7.4대로 웹(리포지토리)이 트랜잭션 내부에서 기록한다.
import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/server/auth/internalAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient, PortoneNotConfiguredError } from "@/lib/server/payments/portone";
import { executeRefund } from "@/lib/server/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const orderId = typeof body.orderId === "string" ? body.orderId : null;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  // adminActor: 감사 로그 actorId(admin_users.id). 웹 쪽 refund.executed/failed audit 의 actor.
  const adminActor = typeof body.adminActor === "string" && body.adminActor.trim() ? body.adminActor.trim() : "system:admin-refund";

  if (!orderId) {
    return NextResponse.json({ ok: false, error: { code: "order_id_required", message: "orderId가 필요합니다." } }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ ok: false, error: { code: "reason_required", message: "환불 사유가 필요합니다." } }, { status: 400 });
  }

  const repositories = getServiceRepositories();
  const portone = getPortoneClient();
  if (!portone.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
      { status: 503 },
    );
  }

  try {
    const outcome = await executeRefund(
      orderId,
      { reason },
      {
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
        actorId: adminActor,
        actorType: "admin",
      },
    );

    switch (outcome.kind) {
      case "unknown_order":
        return NextResponse.json({ ok: false, error: { code: "unknown_order", message: "주문을 찾을 수 없습니다." } }, { status: 404 });
      case "not_refundable_status":
        return NextResponse.json(
          { ok: false, error: { code: "not_refundable_status", message: `환불 가능한 주문 상태가 아닙니다(현재: ${outcome.status}).` } },
          { status: 409 },
        );
      case "not_refundable":
        return NextResponse.json({ ok: false, error: { code: "not_refundable", message: outcome.reason } }, { status: 422 });
      case "failed":
        return NextResponse.json({ ok: false, error: { code: "refund_failed", message: outcome.reason } }, { status: 502 });
      case "pending":
        return NextResponse.json({
          ok: true,
          data: {
            kind: "pending",
            cancellation: outcome.cancellation,
            refundKrw: outcome.refundKrw,
            refundKind: outcome.refundKind,
            message: "환불 요청이 접수되었습니다(비동기). 취소 완료 웹훅으로 최종 반영됩니다.",
          },
        });
      case "executed":
        return NextResponse.json({
          ok: true,
          data: {
            kind: "executed",
            cancellation: outcome.cancellation,
            recovered: outcome.recovered,
            shortfall: outcome.shortfall,
            frozen: outcome.frozen,
            refundKrw: outcome.refundKrw,
            refundKind: outcome.refundKind,
          },
        });
    }
  } catch (error) {
    if (error instanceof PortoneNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "refund_error", message: error instanceof Error ? error.message : "환불 실행 실패" } },
      { status: 502 },
    );
  }
}
