import type {
  CriterionDimension,
  DeepAnalysisCriterionKind,
  GrantCriterion,
} from "@cunote/contracts";
import type {
  DeepAnalysisValidatedCriterion,
  DeepAnalysisValidationResult,
} from "./validator";

export const DEEP_ANALYSIS_AUDIT_SCOPE_VERSION =
  "deep-analysis-match-impacting-scope-v1" as const;

export const DEEP_ANALYSIS_MATCH_IMPACTING_CRITERION_KINDS = [
  "required",
  "exclusion",
] as const satisfies readonly DeepAnalysisCriterionKind[];

export interface DeepAnalysisAuditClaimReview {
  key: string;
  dimension: CriterionDimension;
  verdict: "supported" | "contradicted";
  primary: GrantCriterion;
  audit: GrantCriterion | null;
  evidenceRefs: DeepAnalysisValidatedCriterion["evidenceRefs"];
}

export interface DeepAnalysisAuditMissingCandidate {
  key: string;
  dimension: CriterionDimension;
  audit: GrantCriterion;
  evidenceRefs: DeepAnalysisValidatedCriterion["evidenceRefs"];
}

export interface DeepAnalysisMatchImpactingAuditScope {
  scopeVersion: typeof DEEP_ANALYSIS_AUDIT_SCOPE_VERSION;
  claimReviews: DeepAnalysisAuditClaimReview[];
  missingCandidates: DeepAnalysisAuditMissingCandidate[];
  ignoredPreferred: {
    primaryCount: number;
    auditCount: number;
  };
  requiresAdjudication: boolean;
}

/**
 * 독립 audit의 typed 결과를 eligibility를 바꿀 수 있는 작은 검수 인터페이스로
 * 투영한다. primary claim은 sealed evidence 위치를 유지하고, audit은 동일
 * semantic claim의 지지 여부와 누락 required/exclusion 후보만 제공한다.
 */
export function assessDeepAnalysisMatchImpactingAuditScope(input: {
  primary: DeepAnalysisValidationResult;
  audit: DeepAnalysisValidationResult;
}): DeepAnalysisMatchImpactingAuditScope {
  const primaryCriteria = input.primary.criteria.filter((item) => (
    isDeepAnalysisMatchImpactingCriterion(item.canonicalCriterion)
  ));
  const auditCriteria = input.audit.criteria.filter((item) => (
    isDeepAnalysisMatchImpactingCriterion(item.canonicalCriterion)
  ));
  const auditByHash = new Map(
    auditCriteria.map((item) => [item.semanticSha256, item]),
  );
  const primaryHashes = new Set(
    primaryCriteria.map((item) => item.semanticSha256),
  );
  const claimReviews = primaryCriteria.map((item): DeepAnalysisAuditClaimReview => {
    const supported = auditByHash.get(item.semanticSha256) ?? null;
    return {
      key: item.semanticSha256,
      dimension: item.canonicalCriterion.dimension,
      verdict: supported ? "supported" : "contradicted",
      primary: criterionWithEvidence(item),
      audit: supported ? criterionWithEvidence(supported) : null,
      evidenceRefs: item.evidenceRefs,
    };
  });
  const missingCandidates = auditCriteria
    .filter((item) => !primaryHashes.has(item.semanticSha256))
    .map((item): DeepAnalysisAuditMissingCandidate => ({
      key: item.semanticSha256,
      dimension: item.canonicalCriterion.dimension,
      audit: criterionWithEvidence(item),
      evidenceRefs: item.evidenceRefs,
    }));

  claimReviews.sort(compareScopedItems);
  missingCandidates.sort(compareScopedItems);
  return {
    scopeVersion: DEEP_ANALYSIS_AUDIT_SCOPE_VERSION,
    claimReviews,
    missingCandidates,
    ignoredPreferred: {
      primaryCount: input.primary.criteria.length - primaryCriteria.length,
      auditCount: input.audit.criteria.length - auditCriteria.length,
    },
    requiresAdjudication:
      claimReviews.some((claim) => claim.verdict === "contradicted")
      || missingCandidates.length > 0,
  };
}

export function isDeepAnalysisMatchImpactingCriterion(
  criterion: Pick<GrantCriterion, "kind">,
): boolean {
  return criterion.kind === "required" || criterion.kind === "exclusion";
}

function criterionWithEvidence(
  item: DeepAnalysisValidatedCriterion,
): GrantCriterion {
  return {
    ...item.canonicalCriterion,
    ...(item.criterion.sourceSpan
      ? { source_span: item.criterion.sourceSpan }
      : {}),
  };
}

function compareScopedItems(
  left: { dimension: CriterionDimension; key: string },
  right: { dimension: CriterionDimension; key: string },
): number {
  return `${left.dimension}:${left.key}`.localeCompare(
    `${right.dimension}:${right.key}`,
  );
}
