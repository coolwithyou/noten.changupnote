import type {
  DeepAnalysisCriterion,
  GrantCriterion,
} from "@cunote/contracts";
import { isProfileResolvableCriterion } from "@cunote/core";

export const DEEP_ANALYSIS_MATCHER_REPRESENTABILITY_SCHEMA =
  "deep-analysis-matcher-representability-v1" as const;

export type DeepAnalysisMatcherRepresentabilityStatus =
  | "direct"
  | "conditional_only"
  | "unsupported_relation";

export type DeepAnalysisMatcherRepresentabilityReason =
  | "profile_resolvable"
  | "matcher_returns_unknown"
  | "cross_dimension_alternative"
  | "future_premises_alternative"
  | "post_selection_timing"
  | "unstructured_exception";

export interface DeepAnalysisMatcherRepresentabilityItem {
  criterionIndex: number;
  dimension: DeepAnalysisCriterion["dimension"];
  kind: DeepAnalysisCriterion["kind"];
  status: DeepAnalysisMatcherRepresentabilityStatus;
  hardEligibility: boolean;
  reasonCode: DeepAnalysisMatcherRepresentabilityReason;
}

export interface DeepAnalysisMatcherRepresentabilityAssessment {
  schema: typeof DEEP_ANALYSIS_MATCHER_REPRESENTABILITY_SCHEMA;
  items: DeepAnalysisMatcherRepresentabilityItem[];
  counts: Record<DeepAnalysisMatcherRepresentabilityStatus, number>;
  hardUnsupportedRelationCount: number;
}

const ALTERNATIVE_PATTERN = /(?:또는|혹은|OR|중\s*(?:하나|택일))/iu;
const FUTURE_PREMISES_PATTERN =
  /(?:(?:사업\s*기간\s*)?종료(?:일|시점)?|협약\s*종료).{0,40}(?:입주|이전|소재)|(?:입주|이전|소재).{0,40}(?:(?:사업\s*기간\s*)?종료(?:일|시점)?|협약\s*종료)/u;
const OUTSIDE_REGION_PATTERN = /(?:이외|타|외부|관외)\s*지역/u;
const POST_SELECTION_PHASE_PATTERN =
  /(?:선정|협약\s*(?:체결)?|지원\s*결정|사업\s*수행)\s*(?:후|이후|중)/u;
const POST_SELECTION_CONSEQUENCE_PATTERN =
  /(?:지원|선정|협약)\s*(?:취소|중단|해지)|(?:지원금|보조금|사업비)\s*환수/u;
const EXCEPTION_PATTERN = /(?:다만|단\s*,|예외적으로).{0,80}(?:가능|허용|인정|제외)/u;

/**
 * validated primary criteria를 현재 matcher가 안전하게 소비할 수 있는 형태로 분류한다.
 *
 * conditional_only는 criterion을 버리는 상태가 아니다. 기존 adapter가 needs_review
 * criterion으로 보존하고 matcher가 unknown으로 처리할 수 있다는 뜻이다.
 * unsupported_relation만 hard eligibility와 결합될 때 자동 승격을 막는다.
 */
export function assessDeepAnalysisMatcherRepresentability(
  criteria: DeepAnalysisCriterion[],
): DeepAnalysisMatcherRepresentabilityAssessment {
  const items: DeepAnalysisMatcherRepresentabilityItem[] = criteria.map(
    (criterion, criterionIndex): DeepAnalysisMatcherRepresentabilityItem => {
      const direct = isProfileResolvableCriterion(toGrantCriterion(criterion));
      return {
        criterionIndex,
        dimension: criterion.dimension,
        kind: criterion.kind,
        status: direct ? "direct" : "conditional_only",
        hardEligibility: isHardEligibility(criterion),
        reasonCode: direct ? "profile_resolvable" : "matcher_returns_unknown",
      };
    },
  );

  const hardCriteria = criteria
    .map((criterion, criterionIndex) => ({ criterion, criterionIndex }))
    .filter(({ criterion }) => isHardEligibility(criterion));

  for (const { criterion, criterionIndex } of hardCriteria) {
    const material = criterionMaterial(criterion);
    if (
      POST_SELECTION_PHASE_PATTERN.test(material)
      && POST_SELECTION_CONSEQUENCE_PATTERN.test(material)
    ) {
      markUnsupported(items, criterionIndex, "post_selection_timing");
      continue;
    }
    if (EXCEPTION_PATTERN.test(material) && !hasStructuredExceptions(criterion.value)) {
      markUnsupported(items, criterionIndex, "unstructured_exception");
    }
  }

  for (let left = 0; left < hardCriteria.length; left += 1) {
    for (let right = left + 1; right < hardCriteria.length; right += 1) {
      const leftEntry = hardCriteria[left]!;
      const rightEntry = hardCriteria[right]!;
      if (leftEntry.criterion.dimension === rightEntry.criterion.dimension) continue;
      const leftSpan = normalizedSpan(leftEntry.criterion.sourceSpan);
      const rightSpan = normalizedSpan(rightEntry.criterion.sourceSpan);
      if (
        !leftSpan
        || !rightSpan
        || (!leftSpan.includes(rightSpan) && !rightSpan.includes(leftSpan))
        || !ALTERNATIVE_PATTERN.test(leftSpan.length >= rightSpan.length ? leftSpan : rightSpan)
      ) continue;
      markUnsupported(items, leftEntry.criterionIndex, "cross_dimension_alternative");
      markUnsupported(items, rightEntry.criterionIndex, "cross_dimension_alternative");
    }
  }

  const futurePremises = hardCriteria.find(({ criterion }) => {
    if (criterion.dimension !== "premises") return false;
    const material = criterionMaterial(criterion);
    return FUTURE_PREMISES_PATTERN.test(material) && OUTSIDE_REGION_PATTERN.test(material);
  });
  const hardRegion = hardCriteria.find(({ criterion }) => criterion.dimension === "region");
  if (futurePremises && hardRegion) {
    markUnsupported(items, futurePremises.criterionIndex, "future_premises_alternative");
    markUnsupported(items, hardRegion.criterionIndex, "future_premises_alternative");
  }

  const counts = {
    direct: items.filter((item) => item.status === "direct").length,
    conditional_only: items.filter((item) => item.status === "conditional_only").length,
    unsupported_relation: items.filter((item) => item.status === "unsupported_relation").length,
  };
  return {
    schema: DEEP_ANALYSIS_MATCHER_REPRESENTABILITY_SCHEMA,
    items,
    counts,
    hardUnsupportedRelationCount: items.filter(
      (item) => item.hardEligibility && item.status === "unsupported_relation",
    ).length,
  };
}

export function isDeepAnalysisMatcherRepresentabilityAssessment(
  value: unknown,
  criterionCount: number,
): value is DeepAnalysisMatcherRepresentabilityAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assessment = value as Partial<DeepAnalysisMatcherRepresentabilityAssessment>;
  if (
    assessment.schema !== DEEP_ANALYSIS_MATCHER_REPRESENTABILITY_SCHEMA
    || !Array.isArray(assessment.items)
    || assessment.items.length !== criterionCount
    || !assessment.counts
    || !Number.isInteger(assessment.hardUnsupportedRelationCount)
  ) return false;
  const statuses: DeepAnalysisMatcherRepresentabilityStatus[] = [
    "direct",
    "conditional_only",
    "unsupported_relation",
  ];
  return assessment.items.every((item, index) =>
    item?.criterionIndex === index
    && statuses.includes(item.status)
    && typeof item.hardEligibility === "boolean")
    && statuses.every((status) =>
      assessment.counts?.[status] === assessment.items?.filter((item) => item.status === status).length)
    && assessment.hardUnsupportedRelationCount === assessment.items.filter(
      (item) => item.hardEligibility && item.status === "unsupported_relation",
    ).length;
}

function toGrantCriterion(criterion: DeepAnalysisCriterion): GrantCriterion {
  return {
    dimension: criterion.dimension,
    operator: criterion.operator as GrantCriterion["operator"],
    value: criterion.value as GrantCriterion["value"],
    kind: criterion.kind,
    confidence: criterion.confidence,
    ...(criterion.sourceSpan ? { source_span: criterion.sourceSpan } : {}),
    needs_review: false,
  };
}

function isHardEligibility(criterion: DeepAnalysisCriterion): boolean {
  return criterion.kind === "required" || criterion.kind === "exclusion";
}

function criterionMaterial(criterion: DeepAnalysisCriterion): string {
  return [
    criterion.sourceSpan ?? "",
    criterion.note ?? "",
    JSON.stringify(criterion.value),
  ].join(" ").normalize("NFC").replace(/\s+/g, " ").trim();
}

function normalizedSpan(span: string | null): string {
  return (span ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function hasStructuredExceptions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const exceptions = (value as { exceptions?: unknown }).exceptions;
  return Array.isArray(exceptions) && exceptions.length > 0;
}

function markUnsupported(
  items: DeepAnalysisMatcherRepresentabilityItem[],
  criterionIndex: number,
  reasonCode: DeepAnalysisMatcherRepresentabilityReason,
): void {
  const item = items[criterionIndex];
  if (!item) return;
  item.status = "unsupported_relation";
  item.reasonCode = reasonCode;
}
