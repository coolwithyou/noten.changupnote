// POST /api/internal/credits/refunds/preview (설계 9.3 / 11.5 "서버가 계산해 표시")
//
// { orderId } → 7.4 정책 계산 결과(환불 종류·환불 가능액·회수 크레딧·불가 사유)만 반환. 실행 없음.
// admin(apps/admin) 이 서버 간 시크릿으로만 호출한다.
import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/server/auth/internalAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { previewRefund } from "@/lib/server/payments/paymentService";

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
  if (!orderId) {
    return NextResponse.json({ ok: false, error: { code: "order_id_required", message: "orderId가 필요합니다." } }, { status: 400 });
  }

  const repositories = getServiceRepositories();
  // 미리보기는 포트원 호출이 없다(정책 계산만). getPayment 를 부르지 않으므로 미설정이어도 동작.
  const deps = { payment: repositories.creditsPayment, system: repositories.creditsSystem, portone: getPortoneClient() };

  const preview = await previewRefund(orderId, deps);
  if (preview.kind === "unknown_order") {
    return NextResponse.json({ ok: false, error: { code: "unknown_order", message: "주문을 찾을 수 없습니다." } }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    data: {
      kind: preview.kind,
      order: preview.order ?? null,
      calc: preview.calc ?? null,
      reason: preview.reason ?? null,
    },
  });
}
