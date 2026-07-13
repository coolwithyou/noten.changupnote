import type { GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { assertGrantCriteriaContract } from "../bizinfo/criteria-contract.js";
import { resolveGrantExtractionManifest } from "../extraction/manifest.js";
import type { V3GrantAnnotation } from "./v3-annotations.js";

export interface ReviewedGrantPublicationPlan {
  operationalReady: true;
  grantId: string;
  source: string;
  sourceId: string;
  reviewerId: string;
  reviewedAt: string;
  sourceRevision: string;
  criteria: GrantCriterion[];
  parserVersion: "reviewer:matching-v3";
}

export function planReviewedGrantPublication<TPayload>(
  annotation: V3GrantAnnotation,
  current: NormalizedGrant<TPayload>,
): ReviewedGrantPublicationPlan {
  if (annotation.labelStatus !== "reviewed") throw new Error(`${annotation.grantId}: labelStatus must be reviewed`);
  const annotatorId = nonEmpty(annotation.annotatorId);
  const annotatedAt = validIsoDate(annotation.annotatedAt);
  const reviewerId = nonEmpty(annotation.reviewerId);
  const reviewedAt = validIsoDate(annotation.reviewedAt);
  if (!annotatorId) throw new Error(`${annotation.grantId}: annotatorId is required`);
  if (!annotatedAt) throw new Error(`${annotation.grantId}: annotatedAt must be a valid ISO date`);
  if (!reviewerId) throw new Error(`${annotation.grantId}: reviewerId is required`);
  if (!reviewedAt) throw new Error(`${annotation.grantId}: reviewedAt must be a valid ISO date`);
  if (identityKey(annotatorId) === identityKey(reviewerId)) {
    throw new Error(`${annotation.grantId}: reviewerId must differ from annotatorId`);
  }
  if (isLikelyAiIdentity(reviewerId)) throw new Error(`${annotation.grantId}: reviewerId must identify a human reviewer`);
  if (new Date(reviewedAt).getTime() < new Date(annotatedAt).getTime()) {
    throw new Error(`${annotation.grantId}: reviewedAt must not precede annotatedAt`);
  }
  if (annotation.source !== current.grant.source || annotation.sourceId !== current.grant.source_id) {
    throw new Error(`${annotation.grantId}: annotation/current grant mismatch`);
  }
  if (annotation.title !== current.grant.title) throw new Error(`${annotation.grantId}: title mismatch`);
  const sourceRevision = nonEmpty(annotation.sourceRevision);
  const currentRevision = resolveGrantExtractionManifest(current).revision;
  if (!sourceRevision || sourceRevision === "unknown") {
    throw new Error(`${annotation.grantId}: sourceRevision is required for reviewed publication`);
  }
  if (sourceRevision !== currentRevision) {
    throw new Error(`${annotation.grantId}: stale sourceRevision (reviewed=${sourceRevision}, current=${currentRevision})`);
  }
  const criterionIds = new Set<string>();
  const criteria = annotation.criteria.map((criterion) => {
    if (criterionIds.has(criterion.criterionId)) throw new Error(`${annotation.grantId}: duplicate criterionId ${criterion.criterionId}`);
    criterionIds.add(criterion.criterionId);
    if (criterion.operator !== "text_only" && !nonEmpty(criterion.sourceSpan)) {
      throw new Error(`${annotation.grantId}:${criterion.criterionId}: structured criterion requires sourceSpan`);
    }
    const value: GrantCriterion = {
      id: criterion.criterionId,
      grant_id: current.grant.id ?? annotation.grantId,
      dimension: criterion.dimension,
      kind: criterion.kind,
      operator: criterion.operator,
      value: criterion.value as GrantCriterion["value"],
      confidence: criterion.annotationConfidence,
      needs_review: false,
      parser_version: "reviewer:matching-v3",
    };
    if (criterion.sourceSpan) value.source_span = criterion.sourceSpan;
    if (criterion.sourceField) value.source_field = criterion.sourceField;
    return value;
  });
  assertGrantCriteriaContract(criteria, `${annotation.grantId}:reviewed-publication`);
  return {
    operationalReady: true,
    grantId: annotation.grantId,
    source: annotation.source,
    sourceId: annotation.sourceId,
    reviewerId,
    reviewedAt,
    sourceRevision,
    criteria,
    parserVersion: "reviewer:matching-v3",
  };
}

function identityKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function isLikelyAiIdentity(value: string): boolean {
  return /(^|[^a-z])(ai|llm|gpt|claude|codex|gemini|anthropic|openai)([^a-z]|$)/i.test(value);
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validIsoDate(value: string | null | undefined): string | null {
  const text = nonEmpty(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
