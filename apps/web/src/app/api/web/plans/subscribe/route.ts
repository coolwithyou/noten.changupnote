// POST /api/web/plans/subscribe (설계 8.2 / 9.1) — 구독 시작.
//
// 흐름: requireWebSession → 지갑(frozen 403) → 503(포트원 미설정) → startSubscription.
//   outcomes: conflict→409 plan_already_active / mismatch→409 payment_mismatch /
//   payment_failed→402 plan_payment_failed / active→CreditSubscribeResultDto.
import type { ActionResult, CreditSubscribeResultDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { startSubscription } from "@/lib/server/payments/subscriptionService";
import { toSubscriptionDto } from "@/lib/server/payments/subscriptionDto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;

    const portone = getPortoneClient();
    if (!portone.isConfigured()) {
      return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { planCode?: unknown; billingKey?: unknown; cardSummary?: unknown }
      | null;
    const planCode = typeof body?.planCode === "string" ? body.planCode.trim() : "";
    const billingKey = typeof body?.billingKey === "string" ? body.billingKey.trim() : "";
    if (!planCode) {
      return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
        { ok: false, error: { code: "invalid_request", message: "planCode 가 필요합니다.", field: "planCode" } },
        { status: 400 },
      );
    }
    if (!billingKey) {
      return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
        { ok: false, error: { code: "invalid_request", message: "billingKey 가 필요합니다.", field: "billingKey" } },
        { status: 400 },
      );
    }
    const cardSummary = parseCardSummary(body?.cardSummary);

    const repositories = getServiceRepositories();

    // 지갑(없으면 생성 + 보너스). frozen 이면 403.
    const wallet = await repositories.credits.ensureWalletWithSignupBonus(userId);
    if (wallet.status === "frozen") {
      return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
        { ok: false, error: { code: "wallet_frozen", message: "동결된 지갑은 구독할 수 없습니다." } },
        { status: 403 },
      );
    }

    const outcome = await startSubscription(
      { userId, wallet: { id: wallet.id }, planCode, billingKey, cardSummary },
      {
        subscription: repositories.creditsSubscription,
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
      },
    );

    switch (outcome.kind) {
      case "conflict":
        return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
          { ok: false, error: { code: "plan_already_active", message: "이미 활성 구독이 있습니다. 플랜 변경을 이용하세요." } },
          { status: 409 },
        );
      case "mismatch":
        return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
          { ok: false, error: { code: "payment_mismatch", message: "결제 금액이 플랜과 일치하지 않습니다." } },
          { status: 409 },
        );
      case "payment_failed":
        return NextResponse.json<ActionResult<CreditSubscribeResultDto>>(
          { ok: false, error: { code: "plan_payment_failed", message: outcome.reason } },
          { status: 402 },
        );
      case "active": {
        const currentPlan = await repositories.creditsSubscription.getPlanById(outcome.subscription.planId);
        const pendingPlan = outcome.subscription.pendingPlanId
          ? await repositories.creditsSubscription.getPlanById(outcome.subscription.pendingPlanId)
          : null;
        const data: CreditSubscribeResultDto = {
          subscription: toSubscriptionDto(outcome.subscription, currentPlan, pendingPlan),
          grantedCredits: outcome.grantedCredits,
        };
        return NextResponse.json<ActionResult<CreditSubscribeResultDto>>({ ok: true, data });
      }
    }
  } catch (error) {
    return webActionError<CreditSubscribeResultDto>(error, {
      code: "plan_subscribe_failed",
      message: "구독을 시작하지 못했습니다.",
    });
  }
}

function parseCardSummary(raw: unknown): { brand?: string; last4?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { brand?: unknown; last4?: unknown };
  const summary: { brand?: string; last4?: string } = {};
  if (typeof r.brand === "string") summary.brand = r.brand;
  if (typeof r.last4 === "string") summary.last4 = r.last4;
  return summary.brand || summary.last4 ? summary : null;
}
