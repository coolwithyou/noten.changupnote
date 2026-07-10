// GET /api/web/plans (설계 9.1 / 10.1) — 활성 플랜 + 내 구독(세션 있으면) + 충전 상품 비교표.
//
// ★ 공개 라우트(PUBLIC): requireWebSession 하지 않는다. 구독 상태는 getOptionalWebSession 로
//    로그인 시에만 읽는다. 원시 요율은 노출하지 않고 파생 예시 소모량만 내려준다(4.13).
import type { ActionResult, CreditPlanDto, CreditPlansDto, CreditProductDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { computeExampleUsages, toPlanDto, toSubscriptionDto } from "@/lib/server/payments/subscriptionDto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const repositories = getServiceRepositories();
    const now = new Date();

    // 요율 룰(예시 소모량 계산용, 시스템 신뢰 경로). model=null → model_token 기본값 룰.
    const rules = await repositories.creditsSystem.listEffectivePricingRules(now);

    const plans = await repositories.creditsSubscription.listActivePlans();
    const planDtos: CreditPlanDto[] = plans.map((plan) =>
      toPlanDto(plan, computeExampleUsages(rules, plan.monthlyCredits, now, null)),
    );

    // 활성 충전 상품(비교표용).
    const products = await repositories.creditsPayment.listActiveProducts();
    const productDtos: CreditProductDto[] = products.map((p) => ({
      code: p.code,
      name: p.name,
      amountKrw: p.amountKrw,
      credits: p.credits,
      bonusCredits: p.bonusCredits,
      totalCredits: p.credits + p.bonusCredits,
    }));

    // 로그인 시에만 구독 상태.
    let subscriptionDto: CreditPlansDto["subscription"] = null;
    const session = await getOptionalWebSession();
    if (session) {
      const sub = await repositories.creditsSubscription.getSubscriptionForUser(session.user.id);
      if (sub) {
        const currentPlan = await repositories.creditsSubscription.getPlanById(sub.planId);
        const pendingPlan = sub.pendingPlanId
          ? await repositories.creditsSubscription.getPlanById(sub.pendingPlanId)
          : null;
        subscriptionDto = toSubscriptionDto(sub, currentPlan, pendingPlan);
      }
    }

    const data: CreditPlansDto = {
      plans: planDtos,
      subscription: subscriptionDto,
      products: productDtos,
    };
    return NextResponse.json<ActionResult<CreditPlansDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditPlansDto>(error, {
      code: "credit_plans_failed",
      message: "플랜 정보를 불러오지 못했습니다.",
    });
  }
}
