// POST /api/internal/credits/orders/[orderId]/sync (설계 9.3 "admin 결제 실행 경로")
//
// admin(apps/admin) 이 서버 간 시크릿으로만 호출하는 내부 엔드포인트. 포트원 능동 조회로 주문 상태를
// 동기화한다 — verifyAndGrant(7.2) 재사용(지연 지급 구제 + PAID 확정). 취소 상태면 환불 동기화로 위임.
//
// 인증: authorizeInternalRequest(INTERNAL_API_SECRET). 미설정·불일치 시 401.
import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/server/auth/internalAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient, PortoneNotConfiguredError } from "@/lib/server/payments/portone";
import { verifyAndGrant, syncRefundFromPortone } from "@/lib/server/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const auth = authorizeInternalRequest(request);
  if (!auth.ok) return auth.response;

  const { orderId } = await context.params;
  if (!orderId) {
    return NextResponse.json({ ok: false, error: { code: "order_id_required", message: "orderId가 필요합니다." } }, { status: 400 });
  }

  const repositories = getServiceRepositories();
  const portone = getPortoneClient();
  if (!portone.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
      { status: 503 },
    );
  }

  const order = await repositories.creditsPayment.getOrderById(orderId);
  if (!order) {
    return NextResponse.json({ ok: false, error: { code: "unknown_order", message: "주문을 찾을 수 없습니다." } }, { status: 404 });
  }

  const deps = { payment: repositories.creditsPayment, system: repositories.creditsSystem, portone };

  try {
    // 지급 계열(PAID/대기/실패/불일치) 동기화 — verifyAndGrant.
    const outcome = await verifyAndGrant(order.paymentId, deps);

    // 이미 지급됐거나(paid) 확정 상태에서 취소 이력이 있으면 환불 동기화도 시도(콘솔 발 취소 구제).
    let refundSync: Awaited<ReturnType<typeof syncRefundFromPortone>> | null = null;
    if (outcome.kind === "already" || outcome.kind === "granted") {
      refundSync = await syncRefundFromPortone(order.paymentId, deps);
    }

    const refreshed = await repositories.creditsPayment.getOrderById(orderId);
    return NextResponse.json({
      ok: true,
      data: {
        outcome: outcome.kind,
        status: refreshed?.status ?? order.status,
        ...(refundSync && refundSync.kind === "synced"
          ? { refund: { recovered: refundSync.recovered, shortfall: refundSync.shortfall, frozen: refundSync.frozen } }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof PortoneNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "sync_failed", message: error instanceof Error ? error.message : "동기화 실패" } },
      { status: 502 },
    );
  }
}
