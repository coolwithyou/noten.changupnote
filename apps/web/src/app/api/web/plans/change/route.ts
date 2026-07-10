// POST /api/web/plans/change (설계 8.5 / 9.1) — 플랜 변경(업/다운 분기).
//
// no_subscription→409 / noop→409 / mismatch→409 / payment_failed→402 /
//   upgraded·downgrade_scheduled→CreditPlanChangeResultDto.
import type { ActionResult, CreditPlanChangeResultDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { changePlan } from "@/lib/server/payments/subscriptionService";
import { toSubscriptionDto } from "@/lib/server/payments/subscriptionDto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;

    const portone = getPortoneClient();
    if (!portone.isConfigured()) {
      return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => null)) as { planCode?: unknown } | null;
    const planCode = typeof body?.planCode === "string" ? body.planCode.trim() : "";
    if (!planCode) {
      return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>(
        { ok: false, error: { code: "invalid_request", message: "planCode 가 필요합니다.", field: "planCode" } },
        { status: 400 },
      );
    }

    const repositories = getServiceRepositories();
    const outcome = await changePlan(
      { userId, planCode },
      {
        subscription: repositories.creditsSubscription,
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
      },
    );

    switch (outcome.kind) {
      case "no_subscription":
        return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>(
          { ok: false, error: { code: "no_subscription", message: "변경할 활성 구독이 없습니다." } },
          { status: 409 },
        );
      case "noop":
        return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>(
          { ok: false, error: { code: "same_plan", message: "이미 해당 플랜을 사용 중입니다." } },
          { status: 409 },
        );
      case "mismatch":
        return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>(
          { ok: false, error: { code: "payment_mismatch", message: "결제 금액이 플랜과 일치하지 않습니다." } },
          { status: 409 },
        );
      case "payment_failed":
        return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>(
          { ok: false, error: { code: "plan_payment_failed", message: outcome.reason } },
          { status: 402 },
        );
      case "upgraded": {
        const currentPlan = await repositories.creditsSubscription.getPlanById(outcome.subscription.planId);
        const pendingPlan = outcome.subscription.pendingPlanId
          ? await repositories.creditsSubscription.getPlanById(outcome.subscription.pendingPlanId)
          : null;
        const data: CreditPlanChangeResultDto = {
          kind: "upgraded",
          subscription: toSubscriptionDto(outcome.subscription, currentPlan, pendingPlan),
          grantedCredits: outcome.grantedCredits,
        };
        return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>({ ok: true, data });
      }
      case "downgrade_scheduled": {
        const currentPlan = await repositories.creditsSubscription.getPlanById(outcome.subscription.planId);
        const pendingPlan = outcome.subscription.pendingPlanId
          ? await repositories.creditsSubscription.getPlanById(outcome.subscription.pendingPlanId)
          : null;
        const data: CreditPlanChangeResultDto = {
          kind: "downgrade_scheduled",
          subscription: toSubscriptionDto(outcome.subscription, currentPlan, pendingPlan),
        };
        return NextResponse.json<ActionResult<CreditPlanChangeResultDto>>({ ok: true, data });
      }
    }
  } catch (error) {
    return webActionError<CreditPlanChangeResultDto>(error, {
      code: "plan_change_failed",
      message: "플랜을 변경하지 못했습니다.",
    });
  }
}
