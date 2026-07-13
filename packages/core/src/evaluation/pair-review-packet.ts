import { createHash } from "node:crypto";
import type { Grant, GrantCriterion, NormalizedGrant, RuleTraceEntry } from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import type { V3CompanyAnnotation, V3EligibilityPairAnnotation, V3GrantAnnotation } from "./v3-annotations.js";

export interface MatchingV3PairReviewTask {
  recordType: "eligibility_pair_review_task";
  schemaVersion: "matching-v3-pair-review-task-v1";
  pairId: string;
  grantId: string;
  companyId: string;
  businessKind: V3CompanyAnnotation["businessKind"];
  grantSourceRevision: string | null;
  rulesetVer: string;
  scoringVer: string;
  inputFingerprint: string;
  predictedEligibility: V3EligibilityPairAnnotation["expectedEligibility"];
  predictedTrace: Array<Pick<RuleTraceEntry, "criterion_id" | "dimension" | "kind" | "operator" | "result">>;
  profileDimensionsPresent: string[];
  annotationTemplate: V3EligibilityPairAnnotation;
}

export function buildMatchingV3PairReviewTasks(input: {
  grants: V3GrantAnnotation[];
  companies: V3CompanyAnnotation[];
}): MatchingV3PairReviewTask[] {
  return input.grants.flatMap((grant) => input.companies.map((company) => buildTask(grant, company)));
}

function buildTask(grant: V3GrantAnnotation, company: V3CompanyAnnotation): MatchingV3PairReviewTask {
  if (grant.labelStatus === "legacy") throw new Error(`${grant.grantId}: legacy grant cannot seed v3 pair review`);
  const normalized = normalizedGrant(grant);
  const match = matchNormalizedGrant(normalized, company.profile);
  const inputFingerprint = buildMatchingV3PairInputFingerprint({ grant, company });
  const pairId = `${grant.grantId}::${company.companyId}`;
  const hardFailCriterionIds = match.rule_trace
    .filter((entry) => entry.result === "fail" && (entry.kind === "required" || entry.kind === "exclusion"))
    .map((entry) => entry.criterion_id)
    .filter((value): value is string => Boolean(value));
  const unknownCriterionIds = match.rule_trace
    .filter((entry) => entry.result === "unknown")
    .map((entry) => entry.criterion_id)
    .filter((value): value is string => Boolean(value));
  return {
    recordType: "eligibility_pair_review_task",
    schemaVersion: "matching-v3-pair-review-task-v1",
    pairId,
    grantId: grant.grantId,
    companyId: company.companyId,
    businessKind: company.businessKind,
    grantSourceRevision: grant.sourceRevision ?? null,
    rulesetVer: match.ruleset_ver,
    scoringVer: match.scoring_ver,
    inputFingerprint,
    predictedEligibility: match.eligibility,
    predictedTrace: match.rule_trace.map((entry) => ({
      ...(entry.criterion_id ? { criterion_id: entry.criterion_id } : {}),
      dimension: entry.dimension,
      kind: entry.kind,
      operator: entry.operator,
      result: entry.result,
    })),
    profileDimensionsPresent: Object.keys(company.profile.confidence ?? {}).sort(),
    annotationTemplate: {
      recordType: "eligibility_pair",
      schemaVersion: "matching-v3",
      pairId,
      grantId: grant.grantId,
      companyId: company.companyId,
      expectedEligibility: match.eligibility,
      split: "development",
      hardFailCriterionIds,
      unknownCriterionIds,
      resolvableByProfileInput: null,
      note: "ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW",
      rulesetVer: match.ruleset_ver,
      scoringVer: match.scoring_ver,
      inputFingerprint,
      labelStatus: "draft",
      annotatorId: null,
      reviewerId: null,
      annotatedAt: null,
      reviewedAt: null,
    },
  };
}

export function buildMatchingV3PairInputFingerprint(input: {
  grant: V3GrantAnnotation;
  company: V3CompanyAnnotation;
}): string {
  const normalized = normalizedGrant(input.grant);
  const evaluationInput = {
    grantId: input.grant.grantId,
    companyId: input.company.companyId,
    businessKind: input.company.businessKind,
    grant: normalized.grant,
    raw: normalized.raw,
    criteria: normalized.criteria,
    companyProfile: input.company.profile,
  };
  return createHash("sha256").update(stableJson(evaluationInput)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

function normalizedGrant(annotation: V3GrantAnnotation): NormalizedGrant {
  if (annotation.source !== "kstartup" && annotation.source !== "bizinfo" && annotation.source !== "bizinfo_event") {
    throw new Error(`${annotation.grantId}: unsupported grant source ${annotation.source}`);
  }
  const criteria = annotation.criteria.map((criterion): GrantCriterion => ({
    id: criterion.criterionId,
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value as GrantCriterion["value"],
    confidence: criterion.annotationConfidence,
    ...(criterion.sourceSpan ? { source_span: criterion.sourceSpan } : {}),
    ...(criterion.sourceField ? { source_field: criterion.sourceField } : {}),
    needs_review: true,
    parser_version: "matching-v3-pair-draft",
  }));
  const grant: Grant = {
    source: annotation.source,
    source_id: annotation.sourceId,
    title: annotation.title,
    status: "open",
    audience: annotation.audience,
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0,
    parser_version: "matching-v3-pair-draft",
  };
  return {
    raw: {
      source: grant.source,
      source_id: grant.source_id,
      payload: {},
      ...(annotation.sourceRevision ? { raw_hash: annotation.sourceRevision } : {}),
      status: "normalized",
    },
    grant,
    criteria,
  };
}
