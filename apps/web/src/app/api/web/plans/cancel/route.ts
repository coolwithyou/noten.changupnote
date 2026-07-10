// POST /api/web/plans/cancel (설계 8.5 / 9.1) — 해지 예약(주기 종료 시 canceled).
//
// no_subscription→409 / canceled→CreditPlanCancelResultDto{cancelAtPeriodEnd:true, periodEnd}.
import type { ActionResult, CreditPlanCancelResultDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { cancelSubscription } from "@/lib/server/payments/subscriptionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;

    const portone = getPortoneClient();
    if (!portone.isConfigured()) {
      return NextResponse.json<ActionResult<CreditPlanCancelResultDto>>(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }

    const repositories = getServiceRepositories();
    const outcome = await cancelSubscription(
      { userId },
      {
        subscription: repositories.creditsSubscription,
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
      },
    );

    if (outcome.kind === "no_subscription") {
      return NextResponse.json<ActionResult<CreditPlanCancelResultDto>>(
        { ok: false, error: { code: "no_subscription", message: "해지할 활성 구독이 없습니다." } },
        { status: 409 },
      );
    }

    const data: CreditPlanCancelResultDto = {
      cancelAtPeriodEnd: true,
      periodEnd: outcome.periodEnd.toISOString(),
    };
    return NextResponse.json<ActionResult<CreditPlanCancelResultDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditPlanCancelResultDto>(error, {
      code: "plan_cancel_failed",
      message: "구독을 해지하지 못했습니다.",
    });
  }
}
