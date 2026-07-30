import type {
  DeepAnalysisMatcherRepresentabilityAssessment,
  DeepAnalysisMatcherRepresentabilityReason,
} from "./matcherRepresentability";

export const DEEP_ANALYSIS_AUTOMATION_DECISION_SCHEMA =
  "deep-analysis-automation-decision-v1" as const;

export type DeepAnalysisAutomationTerminalRoute =
  | "auto_promotable"
  | "conditional_promotable"
  | "human_review_required";

export interface DeepAnalysisAutomationBlocker {
  code: "audit_not_concur" | "unsupported_relation";
  stage: "audit_complete" | "matcher_representable";
  count: number;
  detail: string;
}

export interface DeepAnalysisAutomationDeferral {
  code: "audit_uncertain" | "matcher_confirmation_required";
  stage: "audit_complete" | "matcher_representable";
  count: number;
  detail: string;
}

export interface DeepAnalysisAutomationDecision {
  schema: typeof DEEP_ANALYSIS_AUTOMATION_DECISION_SCHEMA;
  terminalRoute: DeepAnalysisAutomationTerminalRoute;
  deferredCriterionIndexes: number[];
  blockers: DeepAnalysisAutomationBlocker[];
  deferrals: DeepAnalysisAutomationDeferral[];
}

const HUMAN_REVIEW_MATCHER_REASONS = new Set<
  DeepAnalysisMatcherRepresentabilityReason
>([
  // 신청자격이 아니라 선정 뒤 의무일 가능성이 높다. 사용자 답변으로 해소할 수 없으므로
  // criterion을 제거하거나 고치는 검토가 필요하다.
  "post_selection_timing",
]);

/**
 * 자동 검수의 단일 운영 결정점.
 *
 * - 검증된 독립 감사 오류와 사용자 답변으로 해소할 수 없는 의미 오류만 사람에게 보낸다.
 * - 감사가 결론을 내리지 못했거나 matcher가 복합 관계를 직접 표현하지 못한 경우에는
 *   해당 criterion을 needs_review로 보존해 conditional 매칭으로 넘긴다.
 * - 나머지만 확정 criterion으로 자동 승격한다.
 */
export function decideDeepAnalysisAutomation(input: {
  auditVerdict: string | null;
  matcherRepresentability?: DeepAnalysisMatcherRepresentabilityAssessment | null;
}): DeepAnalysisAutomationDecision {
  const blockers: DeepAnalysisAutomationBlocker[] = [];
  const deferrals: DeepAnalysisAutomationDeferral[] = [];
  const deferredCriterionIndexes = new Set<number>();
  const assessment = input.matcherRepresentability ?? null;

  if (input.auditVerdict === "unsure") {
    const hardIndexes = assessment?.items
      .filter((item) => item.hardEligibility)
      .map((item) => item.criterionIndex) ?? [];
    const indexes = hardIndexes.length > 0
      ? hardIndexes
      : assessment?.items.map((item) => item.criterionIndex) ?? [];
    for (const index of indexes) deferredCriterionIndexes.add(index);
    deferrals.push({
      code: "audit_uncertain",
      stage: "audit_complete",
      count: Math.max(1, indexes.length),
      detail:
        "독립 감사에 검증된 반대 finding은 없지만 결론을 내리지 못해 hard criterion을 사용자 확인 대상으로 보존합니다.",
    });
  } else if (input.auditVerdict !== "concur") {
    blockers.push({
      code: "audit_not_concur",
      stage: "audit_complete",
      count: 1,
      detail: input.auditVerdict === "disagree"
        ? "독립 감사에서 검증된 match-impacting 오류가 확인됐습니다."
        : "독립 감사 결과가 없어 자동 또는 조건부 승격의 근거를 확인할 수 없습니다.",
    });
  }

  const unsupportedItems = assessment?.items.filter(
    (item) => item.hardEligibility && item.status === "unsupported_relation",
  ) ?? [];
  const blockingItems = unsupportedItems.filter((item) =>
    HUMAN_REVIEW_MATCHER_REASONS.has(item.reasonCode));
  if (blockingItems.length > 0) {
    blockers.push({
      code: "unsupported_relation",
      stage: "matcher_representable",
      count: blockingItems.length,
      detail:
        `사용자 답변으로 해소할 수 없는 hard eligibility 의미 오류 ${blockingItems.length}건`,
    });
  }
  const deferredItems = unsupportedItems.filter((item) =>
    !HUMAN_REVIEW_MATCHER_REASONS.has(item.reasonCode));
  if (deferredItems.length > 0) {
    for (const item of deferredItems) {
      deferredCriterionIndexes.add(item.criterionIndex);
    }
    deferrals.push({
      code: "matcher_confirmation_required",
      stage: "matcher_representable",
      count: deferredItems.length,
      detail:
        `현재 matcher가 직접 표현하지 못하는 hard eligibility 관계 ${deferredItems.length}건을 사용자 확인 대상으로 보존합니다.`,
    });
  }

  const terminalRoute: DeepAnalysisAutomationTerminalRoute =
    blockers.length > 0
      ? "human_review_required"
      : deferrals.length > 0
        ? "conditional_promotable"
        : "auto_promotable";
  return {
    schema: DEEP_ANALYSIS_AUTOMATION_DECISION_SCHEMA,
    terminalRoute,
    deferredCriterionIndexes: [...deferredCriterionIndexes].sort((left, right) => left - right),
    blockers,
    deferrals,
  };
}
