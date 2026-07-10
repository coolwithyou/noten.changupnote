// POST /api/web/credits/checkout/complete (설계 7.2 / 9.1)
//
// ★ 소유권 검증(레드팀 M2/m4): order.userId === session.userId 불일치 시 404(주문 존재 은닉).
//    verifyAndGrant 자체는 세션 없는 내부 함수 — balance 는 이 세션 검증을 통과한 경로만 반환한다.
// ★ 금액·통화 불일치 → 409 payment_mismatch. READY/PENDING/VA → 대기(폴링). paid 재호출 → no-op.
import type { ActionResult, CreditCheckoutCompleteDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { verifyAndGrant } from "@/lib/server/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;

    const body = (await request.json().catch(() => null)) as { paymentId?: unknown } | null;
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId.trim() : "";
    if (!paymentId) {
      return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>(
        { ok: false, error: { code: "invalid_request", message: "paymentId 가 필요합니다.", field: "paymentId" } },
        { status: 400 },
      );
    }

    const repositories = getServiceRepositories();

    // 소유권 검증(레드팀 M2). 불일치·부재 모두 404 로 주문 존재를 은닉한다.
    const order = await repositories.creditsPayment.getOrderByPaymentId(paymentId);
    if (!order || order.userId !== userId) {
      return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>(
        { ok: false, error: { code: "order_not_found", message: "주문을 찾을 수 없습니다." } },
        { status: 404 },
      );
    }

    const outcome = await verifyAndGrant(paymentId, {
      payment: repositories.creditsPayment,
      system: repositories.creditsSystem,
      portone: getPortoneClient(),
    });

    switch (outcome.kind) {
      case "granted": {
        const data: CreditCheckoutCompleteDto = {
          status: "paid",
          grantedCredits: outcome.grantedCredits,
          balance: outcome.balance,
        };
        return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>({ ok: true, data });
      }
      case "already": {
        // 세션 통과 경로이므로 balance 를 조회해 채운다(재조회).
        // paid(이미 지급 완료)면 "paid", 그 외(refunded/partial_refunded)면 "already" 로 표기.
        const wallet = await repositories.credits.getWalletForUser(userId);
        const balance = wallet ? wallet.balanceCredits : null;
        const data: CreditCheckoutCompleteDto = {
          status: outcome.status === "paid" ? "paid" : "already",
          grantedCredits: outcome.grantedCredits,
          balance,
        };
        return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>({ ok: true, data });
      }
      case "pending": {
        const data: CreditCheckoutCompleteDto = { status: "pending", grantedCredits: 0, balance: null };
        return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>({ ok: true, data });
      }
      case "failed": {
        const data: CreditCheckoutCompleteDto = {
          status: "failed",
          grantedCredits: 0,
          balance: null,
          reason: outcome.reason,
        };
        return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>({ ok: true, data });
      }
      case "mismatch":
        return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>(
          {
            ok: false,
            error: { code: "payment_mismatch", message: "결제 금액이 주문과 일치하지 않습니다." },
          },
          { status: 409 },
        );
      case "unknown_order":
        // 소유권 검증에서 이미 걸러졌으므로 방어적 404.
        return NextResponse.json<ActionResult<CreditCheckoutCompleteDto>>(
          { ok: false, error: { code: "order_not_found", message: "주문을 찾을 수 없습니다." } },
          { status: 404 },
        );
    }
  } catch (error) {
    return webActionError<CreditCheckoutCompleteDto>(error, {
      code: "credit_checkout_complete_failed",
      message: "결제 확인에 실패했습니다.",
    });
  }
}
