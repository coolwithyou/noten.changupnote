import {
  isPromotableAnalysisRelease,
  type PromotionReleasePlanItem,
} from "./promotion-release";

export type PromotionAggregateGateId =
  | "sealed_evidence_acceptance"
  | "strict_precision"
  | "wrong_rate"
  | "missed_per_notice"
  | "coverage_ratio"
  | "cost_per_notice_usd"
  | "structured_ratio";

export interface PromotionAggregateThresholds {
  strictPrecisionMin: number;
  wrongRateMax: number;
  missedPerNoticeMax: number;
  coverageRatioMin: number;
  costPerNoticeMaxUsd: number;
  structuredRatioMin: number;
}

export interface PromotionAggregateApiCostGate {
  actualUsd: number;
  maxUsd: number;
  pass: boolean;
}

export interface PromotionAggregateGate {
  id: PromotionAggregateGateId;
  threshold: { operator: "eq" | "gte" | "lte"; value: number };
  actual: number | null;
  pass: boolean;
  blocking: boolean;
  applicability: "applicable" | "not_applicable";
}

export interface PromotionAggregateReviewCounts {
  correct: number;
  needsEdit: number;
  wrong: number;
  unsure: number;
  missed: number;
}

export interface PromotionAggregateEvidence {
  mode: "reviewed" | "sealed" | "mixed";
  reviewedNoticeCount: number;
  sealedNoticeCount: number;
  sealedAcceptedNoticeCount: number;
  publishedCriteriaCount: number;
  structuredCriteriaCount: number;
  currentCriteriaCount: number;
  reviewTotals: PromotionAggregateReviewCounts;
  effectiveReviewTotals: PromotionAggregateReviewCounts;
  decidedReviewCount: number;
  gates: PromotionAggregateGate[];
}

function claimsSealedEvidence(item: PromotionReleasePlanItem): boolean {
  return item.deepAnalysisReadiness !== undefined
    || item.promotionPlan.origin === "deep_repair"
    || item.promotionPlan.auditState === "deep_repair_receipt";
}

function acceptsSealedEvidence(item: PromotionReleasePlanItem): boolean {
  return isPromotableAnalysisRelease([item]);
}

function subtractDeferredReviewRisk(
  plans: readonly PromotionReleasePlanItem[],
  counts: PromotionAggregateReviewCounts,
): PromotionAggregateReviewCounts {
  const deferred = plans.reduce((total, item) => {
    const risk = item.promotionPlan.reviewRisk;
    if (!risk || risk.disposition !== "conditional") return total;
    return {
      needsEdit: total.needsEdit + risk.suppressedVerdicts.needsEdit,
      wrong: total.wrong + risk.suppressedVerdicts.wrong,
      unsure: total.unsure + risk.suppressedVerdicts.unsure,
      missed: total.missed + risk.deferredMissedConditions,
    };
  }, { needsEdit: 0, wrong: 0, unsure: 0, missed: 0 });
  return {
    correct: counts.correct,
    needsEdit: Math.max(0, counts.needsEdit - deferred.needsEdit),
    wrong: Math.max(0, counts.wrong - deferred.wrong),
    unsure: Math.max(0, counts.unsure - deferred.unsure),
    missed: Math.max(0, counts.missed - deferred.missed),
  };
}

function reviewGate(input: {
  id: "strict_precision" | "wrong_rate" | "missed_per_notice";
  operator: "gte" | "lte";
  threshold: number;
  actual: number;
  applicable: boolean;
}): PromotionAggregateGate {
  const pass = !input.applicable
    || (input.operator === "gte"
      ? input.actual >= input.threshold
      : input.actual <= input.threshold);
  return {
    id: input.id,
    threshold: { operator: input.operator, value: input.threshold },
    actual: input.applicable ? input.actual : null,
    pass,
    blocking: input.applicable,
    applicability: input.applicable ? "applicable" : "not_applicable",
  };
}

/**
 * release plan을 출처별 내부 표현과 무관한 aggregate 품질 증거로 투영한다.
 *
 * 사람/AI 검수 plan만 verdict 기반 precision·wrong·missed 표본을 제공한다. sealed
 * production/deep-repair plan은 검수 verdict를 가장하지 않고, readiness/receipt 계약이
 * 완전한지를 별도 blocking gate로 증명한다. coverage와 structured는 실제 발행될
 * criteria를 기준으로 계산한다.
 */
export function evaluatePromotionAggregateEvidence(input: {
  plans: readonly PromotionReleasePlanItem[];
  thresholds: PromotionAggregateThresholds;
  apiCostGate: PromotionAggregateApiCostGate | null;
}): PromotionAggregateEvidence {
  if (input.plans.length === 0) throw new Error("aggregate evidence plan이 0건입니다.");

  const sealedPlans = input.plans.filter(claimsSealedEvidence);
  const reviewedPlans = input.plans.filter((item) => !claimsSealedEvidence(item));
  const reviewTotals = reviewedPlans.reduce<PromotionAggregateReviewCounts>((total, item) => ({
    correct: total.correct + item.promotionPlan.conversion.verdicts.correct,
    needsEdit: total.needsEdit + item.promotionPlan.conversion.verdicts.needs_edit,
    wrong: total.wrong + item.promotionPlan.conversion.verdicts.wrong,
    unsure: total.unsure + item.promotionPlan.conversion.verdicts.unsure,
    missed: total.missed + item.promotionPlan.conversion.missedConditions,
  }), { correct: 0, needsEdit: 0, wrong: 0, unsure: 0, missed: 0 });
  const effectiveReviewTotals = subtractDeferredReviewRisk(reviewedPlans, reviewTotals);
  const deferReviewedUnsure = reviewedPlans.length > 0 && isPromotableAnalysisRelease(input.plans);
  const decidedReviewCount = effectiveReviewTotals.correct
    + effectiveReviewTotals.needsEdit
    + effectiveReviewTotals.wrong
    + (deferReviewedUnsure ? 0 : effectiveReviewTotals.unsure);
  const reviewApplicable = reviewedPlans.length > 0;
  const strictPrecision = decidedReviewCount > 0
    ? effectiveReviewTotals.correct / decidedReviewCount
    : 0;
  const wrongRate = decidedReviewCount > 0
    ? effectiveReviewTotals.wrong / decidedReviewCount
    : 0;
  const missedPerNotice = reviewedPlans.length > 0
    ? effectiveReviewTotals.missed / reviewedPlans.length
    : 0;

  const sealedAcceptedNoticeCount = sealedPlans.filter(acceptsSealedEvidence).length;
  const sealedAcceptance = sealedPlans.length > 0
    ? sealedAcceptedNoticeCount / sealedPlans.length
    : 1;
  const publishedCriteriaCount = input.plans.reduce(
    (sum, item) => sum + item.promotionPlan.criteria.length,
    0,
  );
  const structuredCriteriaCount = input.plans.reduce(
    (sum, item) => sum + item.promotionPlan.criteria
      .filter((criterion) => criterion.operator !== "text_only").length,
    0,
  );
  const currentCriteriaCount = input.plans.reduce(
    (sum, item) => sum + item.criteriaCountBefore,
    0,
  );
  const coverageRatio = currentCriteriaCount > 0
    ? publishedCriteriaCount / currentCriteriaCount
    : Number.POSITIVE_INFINITY;
  const structuredRatio = publishedCriteriaCount > 0
    ? structuredCriteriaCount / publishedCriteriaCount
    : 0;
  const releaseReady = isPromotableAnalysisRelease(input.plans);
  const costApplicable = input.apiCostGate !== null;

  const gates: PromotionAggregateGate[] = [
    {
      id: "sealed_evidence_acceptance",
      threshold: { operator: "eq", value: 1 },
      actual: sealedPlans.length > 0 ? sealedAcceptance : null,
      pass: sealedPlans.length === 0 || sealedAcceptance === 1,
      blocking: sealedPlans.length > 0,
      applicability: sealedPlans.length > 0 ? "applicable" : "not_applicable",
    },
    reviewGate({
      id: "strict_precision",
      operator: "gte",
      threshold: input.thresholds.strictPrecisionMin,
      actual: strictPrecision,
      applicable: reviewApplicable,
    }),
    reviewGate({
      id: "wrong_rate",
      operator: "lte",
      threshold: input.thresholds.wrongRateMax,
      actual: wrongRate,
      applicable: reviewApplicable,
    }),
    reviewGate({
      id: "missed_per_notice",
      operator: "lte",
      threshold: input.thresholds.missedPerNoticeMax,
      actual: missedPerNotice,
      applicable: reviewApplicable,
    }),
    {
      id: "coverage_ratio",
      threshold: { operator: "gte", value: input.thresholds.coverageRatioMin },
      actual: Number.isFinite(coverageRatio) ? coverageRatio : null,
      pass: coverageRatio >= input.thresholds.coverageRatioMin,
      blocking: !releaseReady,
      applicability: "applicable",
    },
    {
      id: "cost_per_notice_usd",
      threshold: {
        operator: "lte",
        value: input.apiCostGate?.maxUsd ?? input.thresholds.costPerNoticeMaxUsd,
      },
      actual: input.apiCostGate?.actualUsd ?? null,
      pass: input.apiCostGate?.pass ?? true,
      blocking: costApplicable,
      applicability: costApplicable ? "applicable" : "not_applicable",
    },
    {
      id: "structured_ratio",
      threshold: { operator: "gte", value: input.thresholds.structuredRatioMin },
      actual: structuredRatio,
      pass: structuredRatio >= input.thresholds.structuredRatioMin,
      blocking: !releaseReady,
      applicability: "applicable",
    },
  ];

  return {
    mode: sealedPlans.length === 0
      ? "reviewed"
      : reviewedPlans.length === 0
        ? "sealed"
        : "mixed",
    reviewedNoticeCount: reviewedPlans.length,
    sealedNoticeCount: sealedPlans.length,
    sealedAcceptedNoticeCount,
    publishedCriteriaCount,
    structuredCriteriaCount,
    currentCriteriaCount,
    reviewTotals,
    effectiveReviewTotals,
    decidedReviewCount,
    gates,
  };
}
