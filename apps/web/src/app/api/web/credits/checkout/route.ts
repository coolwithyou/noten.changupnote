// POST /api/web/credits/checkout (설계 7.2 / 9.1) — 주문 생성 + 브라우저 SDK 파라미터 반환.
//
// 흐름: requireWebSession → 지갑(frozen 403) → 상품(is_active) 검증 →
//   레이트리밋(user당 분당 10회) + 동시 미결제 5개 상한(7.2) →
//   paymentId=`cnord_`+uuid hex, creditsToGrant=credits+bonus 스냅샷, 주문 INSERT →
//   { paymentId, storeId, channelKey, orderName, totalAmount }.
import type { ActionResult, CreditCheckoutDto } from "@cunote/contracts";
import { paymentIdForOrder } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_PER_MINUTE = 10;
const MAX_OPEN_ORDERS = 5;
const KRW_PER_CREDIT_FALLBACK = 1;
const ORDER_TTL_MINUTES_FALLBACK = 90;

export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;

    // 결제 채널 미설정이면 결제 경로만 503(나머지 앱 무관).
    const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID?.trim();
    const channelKey = process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSS?.trim();
    if (!storeId || !channelKey || !getPortoneClient().isConfigured()) {
      return NextResponse.json<ActionResult<CreditCheckoutDto>>(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => null)) as { productCode?: unknown } | null;
    const productCode = typeof body?.productCode === "string" ? body.productCode.trim() : "";
    if (!productCode) {
      return NextResponse.json<ActionResult<CreditCheckoutDto>>(
        { ok: false, error: { code: "invalid_request", message: "productCode 가 필요합니다.", field: "productCode" } },
        { status: 400 },
      );
    }

    const repositories = getServiceRepositories();

    // 지갑(없으면 생성 + 보너스). frozen 이면 403.
    const wallet = await repositories.credits.ensureWalletWithSignupBonus(userId);
    if (wallet.status === "frozen") {
      return NextResponse.json<ActionResult<CreditCheckoutDto>>(
        { ok: false, error: { code: "wallet_frozen", message: "동결된 지갑은 충전할 수 없습니다." } },
        { status: 403 },
      );
    }

    // 상품(활성만).
    const product = await repositories.creditsPayment.getActiveProductByCode(productCode);
    if (!product) {
      return NextResponse.json<ActionResult<CreditCheckoutDto>>(
        { ok: false, error: { code: "product_not_found", message: "존재하지 않는 상품입니다.", field: "productCode" } },
        { status: 404 },
      );
    }

    // 레이트리밋(분당 10회) + 동시 미결제 상한(5개) — 주문 생성 남용 방어(7.2).
    const recent = await repositories.creditsPayment.countRecentOrdersForUser(userId, 60_000);
    if (recent >= RATE_LIMIT_PER_MINUTE) {
      return NextResponse.json<ActionResult<CreditCheckoutDto>>(
        { ok: false, error: { code: "rate_limited", message: "잠시 후 다시 시도해 주세요." } },
        { status: 429 },
      );
    }
    const open = await repositories.creditsPayment.countOpenOrdersForUser(userId);
    if (open >= MAX_OPEN_ORDERS) {
      return NextResponse.json<ActionResult<CreditCheckoutDto>>(
        {
          ok: false,
          error: { code: "too_many_open_orders", message: "미결제 주문이 많습니다. 기존 결제를 완료하거나 잠시 후 시도해 주세요." },
        },
        { status: 429 },
      );
    }

    // 스냅샷 계산.
    const krwPerCredit = await repositories.creditsSystem.readNumericSetting(
      "krw_per_credit",
      KRW_PER_CREDIT_FALLBACK,
    );
    const ttlMinutes = await repositories.creditsSystem.readNumericSetting(
      "payment_order_ttl_minutes",
      ORDER_TTL_MINUTES_FALLBACK,
    );
    const creditsToGrant = product.credits + product.bonusCredits;

    // 주문 id 를 서버가 생성 → paymentId 파생(cnord_+hex).
    const orderId = crypto.randomUUID();
    const paymentId = paymentIdForOrder(orderId);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await repositories.creditsPayment.createOrder({
      id: orderId,
      paymentId,
      walletId: wallet.id,
      userId,
      orderType: "credit_topup",
      productId: product.id,
      amountKrw: product.amountKrw,
      creditsToGrant,
      krwPerCreditSnapshot: krwPerCredit,
      expiresAt,
    });

    const data: CreditCheckoutDto = {
      paymentId,
      storeId,
      channelKey,
      orderName: product.name,
      totalAmount: product.amountKrw,
    };
    return NextResponse.json<ActionResult<CreditCheckoutDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditCheckoutDto>(error, {
      code: "credit_checkout_failed",
      message: "결제를 시작하지 못했습니다.",
    });
  }
}
