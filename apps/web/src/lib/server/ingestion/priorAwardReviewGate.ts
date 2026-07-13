import type { GrantCriterion } from "@cunote/contracts";
import { parseV3AnnotationJsonl } from "@cunote/core";

export interface PriorAwardReviewCandidate {
  grantId: string;
  sourceId: string;
  sourceFixture: string;
  criterionId: string;
  operator: GrantCriterion["operator"];
  value: unknown;
  sourceSpan: string | null;
}

export interface PriorAwardReviewAssessment {
  acceptedCriterionCount: number;
  reviewedGrantCount: number;
  ready: boolean;
}

export function assessPriorAwardIndependentReview(
  candidates: PriorAwardReviewCandidate[],
  annotationsText: string | null,
  sourceName = "prior-award-reviewed-annotations.jsonl",
): PriorAwardReviewAssessment {
  if (!annotationsText) return { acceptedCriterionCount: 0, reviewedGrantCount: 0, ready: false };
  const dataset = parseV3AnnotationJsonl(annotationsText, sourceName);
  const reviewed = dataset.grants.filter((grant) => grant.labelStatus === "reviewed");
  let acceptedCriterionCount = 0;
  for (const candidate of candidates) {
    const grant = reviewed.find((item) =>
      item.grantId === candidate.grantId &&
      item.source === "kstartup" &&
      item.sourceId === candidate.sourceId &&
      item.sourceFixture === candidate.sourceFixture);
    const criterion = grant?.criteria.find((item) => item.criterionId === candidate.criterionId);
    if (!criterion) continue;
    if (
      criterion.dimension === "prior_award" &&
      criterion.kind === "exclusion" &&
      criterion.operator === candidate.operator &&
      criterion.sourceSpan === candidate.sourceSpan &&
      canonicalJson(criterion.value) === canonicalJson(candidate.value)
    ) acceptedCriterionCount += 1;
  }
  const reviewedGrantCount = new Set(reviewed.map((grant) => grant.grantId)).size;
  return {
    acceptedCriterionCount,
    reviewedGrantCount,
    ready: candidates.length > 0 && acceptedCriterionCount === candidates.length,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}
