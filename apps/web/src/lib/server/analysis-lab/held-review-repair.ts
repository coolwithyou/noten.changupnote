import type { LabReview, LabRun } from "@/features/dev/analysis-lab/contract";
import { assessPromotionReviewRisk } from "./promotion-review-risk";
import { stableJson } from "@/lib/server/deep-analysis/sourceRevision";

export const LAB_HELD_REVIEW_REPAIR_VERSION = "lab-held-review-repair-v1";

export interface HeldReviewRepairPlan {
  blockingCount: number;
  taskInstruction: string;
}

/** 완료된 독립 검수의 신청자격 blocker만 원문 재분석 피드백으로 만든다. */
export function buildHeldReviewRepairPlan(input: {
  run: LabRun;
  review: Pick<LabReview, "criterionReviews" | "axisReviews">;
}): HeldReviewRepairPlan | null {
  const risk = assessPromotionReviewRisk(input);
  if (risk.disposition !== "blocked" || risk.blockers.length === 0) return null;
  const criterionByIndex = new Map(input.review.criterionReviews.map((item) => [item.criterionIndex, item]));
  const axisByDimension = new Map(input.review.axisReviews.map((item) => [item.dimension, item]));
  const findings = risk.blockers.map((blocker) => blocker.criterionIndex !== undefined
    ? {
        type: "criterion" as const,
        previousCriterionIndex: blocker.criterionIndex,
        previousCriterion: input.run.criteria[blocker.criterionIndex] ?? null,
        finalReview: criterionByIndex.get(blocker.criterionIndex) ?? null,
        risk: blocker,
      }
    : {
        type: "axis" as const,
        dimension: blocker.dimension ?? null,
        finalReview: blocker.dimension ? axisByDimension.get(blocker.dimension as never) ?? null : null,
        risk: blocker,
      });
  return {
    blockingCount: findings.length,
    taskInstruction: [
      "아래 공고 입력을 22축 전체에 대해 처음부터 다시 분석하라.",
      "직전 추출 결과를 그대로 고치는 작업이 아니라, 봉인 원문을 다시 읽어 완전한 새 결과를 반환하는 작업이다.",
      "서로 다른 독립 모델의 검수·감사로 아래 신청자격 blocker가 종결되었다.",
      "각 finding의 previousCriterion과 finalReview.note를 원문에서 직접 다시 확인하고, 지적이 원문에 부합하면 같은 기계판정 오류가 새 결과에 남지 않게 수정하라.",
      "검수 지적만 처리하고 다른 22축·근거·프로그램 의도를 생략하지 마라. 원문 밖 사실은 추가하지 마라.",
      `feedback_version=${LAB_HELD_REVIEW_REPAIR_VERSION}`,
      "<<<VERIFIED_REVIEW_BLOCKERS>>>",
      stableJson(findings),
      "<<<END_VERIFIED_REVIEW_BLOCKERS>>>",
    ].join("\n"),
  };
}
