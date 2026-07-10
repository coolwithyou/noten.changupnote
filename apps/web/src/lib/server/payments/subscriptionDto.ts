/**
 * 플랜 구독 DTO 매퍼 (설계 9.1 / 10.1 / 10.4). 라우트 간 공유.
 *
 * ★ 4.13 노출 규약: 원시 요율(input_millicredits_per_1k 등)은 클라이언트로 내보내지 않는다.
 *   "지원서 초안 1회 약 ○○○ 크레딧" 형태의 파생 예시 소모량(exampleUsages)만 서버가 계산해 내려준다.
 */
import {
  creditsFor,
  resolvePricingRule,
  PricingRuleMissingError,
  type CreditPlanRecord,
  type CreditSubscriptionRecord,
  type PricingRule,
} from "@cunote/core";
import type { CreditPlanDto, CreditSubscriptionDto } from "@cunote/contracts";

/** 보너스율 = (monthlyCredits - monthlyPriceKrw) / monthlyPriceKrw (1cr=1krw 앵커). */
function bonusRate(plan: CreditPlanRecord): number {
  if (plan.monthlyPriceKrw <= 0) return 0;
  return (plan.monthlyCredits - plan.monthlyPriceKrw) / plan.monthlyPriceKrw;
}

/**
 * 예시 소모량 대표 시나리오(5.5 예: 지원서 초안 input 20k + output 8k).
 * featureCode·라벨·대표 토큰량을 2~3개 기능으로 한정. 원시 요율 미노출.
 */
const EXAMPLE_SCENARIOS: Array<{
  featureCode: string;
  featureLabel: string;
  inputTokens: number;
  outputTokens: number;
}> = [
  { featureCode: "application_draft", featureLabel: "지원서 초안 생성", inputTokens: 20_000, outputTokens: 8_000 },
  { featureCode: "application_review", featureLabel: "지원서 첨삭", inputTokens: 12_000, outputTokens: 4_000 },
  { featureCode: "business_plan_section", featureLabel: "사업계획서 섹션 작성", inputTokens: 15_000, outputTokens: 6_000 },
];

/**
 * 요율 룰 목록으로 대표 기능별 예상 소모량을 계산한다(원시 요율 미노출).
 * @param model 대표 모델(요율 resolver 입력). null 이면 model_token 기본값 룰 사용.
 */
export function computeExampleUsages(
  rules: readonly PricingRule[],
  monthlyCredits: number,
  at: Date,
  model: string | null = null,
): CreditPlanDto["exampleUsages"] {
  const out: CreditPlanDto["exampleUsages"] = [];
  for (const s of EXAMPLE_SCENARIOS) {
    let approxCredits: number;
    try {
      const rule = resolvePricingRule(rules, s.featureCode, model, at);
      approxCredits = creditsFor(
        { inputTokens: s.inputTokens, outputTokens: s.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rule,
      );
    } catch (error) {
      // 요율 미정의 기능은 예시에서 제외(추정 불가). 다른 기능은 계속.
      if (error instanceof PricingRuleMissingError) continue;
      throw error;
    }
    const approxCount = approxCredits > 0 ? Math.floor(monthlyCredits / approxCredits) : 0;
    out.push({ featureLabel: s.featureLabel, approxCredits, approxCount });
  }
  return out;
}

/** CreditPlanRecord → CreditPlanDto. exampleUsages 는 호출측이 요율로 계산해 주입. */
export function toPlanDto(
  plan: CreditPlanRecord,
  exampleUsages: CreditPlanDto["exampleUsages"],
): CreditPlanDto {
  return {
    code: plan.code,
    name: plan.name,
    monthlyPriceKrw: plan.monthlyPriceKrw,
    monthlyCredits: plan.monthlyCredits,
    bonusRate: bonusRate(plan),
    features: plan.features,
    exampleUsages,
  };
}

/**
 * CreditSubscriptionRecord → CreditSubscriptionDto.
 *  - planName·nextBillingAmountKrw = 현재 플랜(다운그레이드 예약 시 다음 결제 금액은 pending 플랜 금액).
 *  - cardBrand/last4 = cardSummary.
 *  - pendingPlanCode = pendingPlanId → plan.code.
 * @param currentPlan 현재 planId 의 플랜.
 * @param pendingPlan pendingPlanId 의 플랜(없으면 null).
 */
export function toSubscriptionDto(
  sub: CreditSubscriptionRecord,
  currentPlan: CreditPlanRecord | null,
  pendingPlan: CreditPlanRecord | null,
): CreditSubscriptionDto {
  // 다음 결제 금액: 다운그레이드 예약이 있으면 하위 플랜 금액, 없으면 현재 플랜 금액.
  const nextBillingAmountKrw = pendingPlan
    ? pendingPlan.monthlyPriceKrw
    : (currentPlan?.monthlyPriceKrw ?? 0);
  return {
    planCode: currentPlan?.code ?? "",
    planName: currentPlan?.name ?? "",
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    nextBillingAmountKrw,
    cardBrand: sub.cardSummary?.brand ?? null,
    cardLast4: sub.cardSummary?.last4 ?? null,
    pendingPlanCode: pendingPlan?.code ?? null,
  };
}
