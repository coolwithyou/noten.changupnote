import type {
  LabCriterionVerdict,
  LabReview,
  LabRun,
} from "@/lib/server/analysis-lab/lab-contract";

export const PROMOTION_REVIEW_RISK_SCHEMA = "promotion-review-risk-v1" as const;

export type PromotionReviewDisposition = "verified" | "conditional" | "blocked";

export type PromotionReviewRiskCode =
  | "hard_criterion_not_confirmed"
  | "missed_eligibility_condition"
  | "missed_condition_impact_unknown"
  | "ranking_criterion_suppressed"
  | "ranking_condition_unmodeled";

export interface PromotionReviewRiskItem {
  code: PromotionReviewRiskCode;
  criterionIndex?: number;
  dimension?: string;
  verdict?: LabCriterionVerdict;
  detail: string;
}

export interface PromotionReviewRisk {
  schema: typeof PROMOTION_REVIEW_RISK_SCHEMA;
  disposition: PromotionReviewDisposition;
  blockers: PromotionReviewRiskItem[];
  deferrals: PromotionReviewRiskItem[];
  /** 비정확 preferred criterion은 잘못된 점수 신호가 되지 않도록 발행에서 제외한다. */
  suppressedCriterionIndexes: number[];
  /** aggregate 정밀도 분모에서 제외할 ranking-only 판정 수. */
  suppressedVerdicts: {
    needsEdit: number;
    wrong: number;
    unsure: number;
  };
  /** aggregate 누락률에서 제외하되 manifest에는 deferral로 남길 ranking 누락 수. */
  deferredMissedConditions: number;
}

/**
 * 검수 결과가 실제 신청 가능 여부를 바꾸는지 한 곳에서 판정한다.
 *
 * - required/exclusion의 비정확 판정과 영향도 미확정 누락은 차단한다.
 * - preferred의 비정확 판정은 해당 criterion만 억제한다.
 * - 두 독립 모델이 ranking으로 합의한 누락은 점수 신호만 미반영한 조건부 승격이다.
 */
export function assessPromotionReviewRisk(input: {
  run: LabRun;
  review: Pick<LabReview, "criterionReviews" | "axisReviews">;
}): PromotionReviewRisk {
  const blockers: PromotionReviewRiskItem[] = [];
  const deferrals: PromotionReviewRiskItem[] = [];
  const suppressedCriterionIndexes = new Set<number>();
  const suppressedVerdicts = { needsEdit: 0, wrong: 0, unsure: 0 };

  for (const item of input.review.criterionReviews) {
    if (item.verdict === "correct") continue;
    const criterion = input.run.criteria[item.criterionIndex];
    if (!criterion || criterion.kind !== "preferred") {
      blockers.push({
        code: "hard_criterion_not_confirmed",
        criterionIndex: item.criterionIndex,
        verdict: item.verdict,
        detail: criterion
          ? `${criterion.kind} criterion이 ${item.verdict} 판정이라 신청 가능 여부를 안전하게 확정할 수 없습니다.`
          : `존재하지 않는 criterion index ${item.criterionIndex}의 ${item.verdict} 판정입니다.`,
      });
      suppressedCriterionIndexes.add(item.criterionIndex);
      continue;
    }

    suppressedCriterionIndexes.add(item.criterionIndex);
    if (item.verdict === "needs_edit") suppressedVerdicts.needsEdit += 1;
    else if (item.verdict === "wrong") suppressedVerdicts.wrong += 1;
    else suppressedVerdicts.unsure += 1;
    deferrals.push({
      code: "ranking_criterion_suppressed",
      criterionIndex: item.criterionIndex,
      verdict: item.verdict,
      detail: `우대·가점 criterion ${item.criterionIndex}을 매칭 점수에서 제외했습니다.`,
    });
  }

  let deferredMissedConditions = 0;
  for (const item of input.review.axisReviews) {
    if (item.verdict !== "missed_condition") continue;
    if (item.matchImpact === "ranking") {
      deferredMissedConditions += 1;
      deferrals.push({
        code: "ranking_condition_unmodeled",
        dimension: item.dimension,
        detail: `${item.dimension} 축의 우대·가점 조건은 점수에 반영하지 않고 조건부로 서빙합니다.`,
      });
      continue;
    }
    blockers.push({
      code: item.matchImpact === "eligibility"
        ? "missed_eligibility_condition"
        : "missed_condition_impact_unknown",
      dimension: item.dimension,
      detail: item.matchImpact === "eligibility"
        ? `${item.dimension} 축의 신청자격·배제 조건이 누락됐습니다.`
        : `${item.dimension} 축 누락 조건의 매칭 영향도가 독립 검수로 확정되지 않았습니다.`,
    });
  }

  const disposition: PromotionReviewDisposition = blockers.length > 0
    ? "blocked"
    : deferrals.length > 0
      ? "conditional"
      : "verified";
  return {
    schema: PROMOTION_REVIEW_RISK_SCHEMA,
    disposition,
    blockers,
    deferrals,
    suppressedCriterionIndexes: [...suppressedCriterionIndexes].sort((a, b) => a - b),
    suppressedVerdicts,
    deferredMissedConditions,
  };
}
