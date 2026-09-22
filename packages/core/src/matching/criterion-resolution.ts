import type { CriterionDimension, CriterionKind } from "@cunote/contracts";

export type CriterionResolutionAction =
  | "code_comparison"
  | "company_profile"
  | "user_confirmation"
  | "admin_source_review";

export interface CriterionResolutionInput {
  readonly dimension: CriterionDimension;
  readonly kind: CriterionKind;
  /** Lab의 역사 산출물은 string operator를 허용한다. text_only 외 값은 구조화 비교 후보로만 분류한다. */
  readonly operator: string;
  readonly value: unknown;
  readonly sourceSpan: string | null | undefined;
  readonly sourceVerified: boolean;
  /** 현재 company profile 계약과 matcher가 이 구조를 결정적으로 비교할 수 있는지 여부. */
  readonly companyProfileResolvable: boolean;
  readonly needsReview?: boolean;
}

export interface CriterionResolution {
  readonly sourceInterpretation: "verified" | "evidence_missing" | "review_required";
  readonly action: CriterionResolutionAction;
  readonly requiresEligibilityQuestion: boolean;
  readonly reuseScope: "company_fact" | "per_notice" | "none";
  readonly reason:
    | "structured_company_comparison"
    | "reviewed_notice_confirmation"
    | "criterion_not_eligibility_blocking"
    | "source_evidence_missing"
    | "criterion_review_required"
    | "unsafe_semantic_downgrade"
    | "unsupported_structured_criterion"
    | "unsupported_text_only_dimension";
}

const ADMIN_ONLY_DOWNGRADE_REASONS = new Set([
  "contract_validation_failed",
  "exclusive_upper_bound_mismatch",
  "sanction_cause_state_flattening",
  "source_semantic_contradiction",
]);

/** 조건의 표현 방식과 해소 주체를 추출·질문 작성·제품 준비도가 함께 쓰는 순수 계약이다. */
export function classifyCriterionResolution(input: CriterionResolutionInput): CriterionResolution {
  const hard = input.kind === "required" || input.kind === "exclusion";
  if (!nonEmpty(input.sourceSpan) || !input.sourceVerified) {
    return resolution(
      input.needsReview ? "review_required" : "evidence_missing",
      "admin_source_review",
      false,
      "none",
      input.needsReview ? "criterion_review_required" : "source_evidence_missing",
    );
  }
  if (input.needsReview) {
    return resolution("review_required", "admin_source_review", false, "none", "criterion_review_required");
  }
  if (input.operator !== "text_only") {
    if (!input.companyProfileResolvable) {
      return resolution(
        "review_required",
        "admin_source_review",
        false,
        "none",
        "unsupported_structured_criterion",
      );
    }
    return resolution(
      "verified",
      "company_profile",
      false,
      "company_fact",
      hard ? "structured_company_comparison" : "criterion_not_eligibility_blocking",
    );
  }

  const value = record(input.value);
  const downgradeReason = typeof value.downgrade_reason === "string" ? value.downgrade_reason : null;
  if (
    (downgradeReason && ADMIN_ONLY_DOWNGRADE_REASONS.has(downgradeReason))
    || typeof value.original_dimension === "string"
  ) {
    return resolution("review_required", "admin_source_review", false, "none", "unsafe_semantic_downgrade");
  }
  if (input.dimension !== "other" && input.dimension !== "industry") {
    return resolution("review_required", "admin_source_review", false, "none", "unsupported_text_only_dimension");
  }
  return resolution(
    "verified",
    "user_confirmation",
    hard,
    "per_notice",
    hard ? "reviewed_notice_confirmation" : "criterion_not_eligibility_blocking",
  );
}

function resolution(
  sourceInterpretation: CriterionResolution["sourceInterpretation"],
  action: CriterionResolutionAction,
  requiresEligibilityQuestion: boolean,
  reuseScope: CriterionResolution["reuseScope"],
  reason: CriterionResolution["reason"],
): CriterionResolution {
  return Object.freeze({ sourceInterpretation, action, requiresEligibilityQuestion, reuseScope, reason });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
