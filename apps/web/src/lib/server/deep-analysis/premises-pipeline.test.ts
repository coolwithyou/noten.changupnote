import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type CompanyProfile,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { matchGrantCriteria } from "@cunote/core";
import { assessDeepAnalysisMatcherRepresentability } from "./matcherRepresentability";
import { sealDeepAnalysisInput } from "./inputManifest";
import { normalizeCriteria } from "./extractor";
import {
  buildDeepAnalysisPromotionPlan,
  type DeepAnalysisNormalizedOutput,
} from "./promotion";
import { validateDeepAnalysisResult } from "./validator";

const sourceSpan = "2026년 9월 9일 현재 서울특별시에 등록된 본사 또는 공장을 둔 기업";
const rawCriterion = {
  dimension: "premises",
  kind: "required",
  operator: "exists",
  value: {
    schemaVersion: "premises-v1",
    state: "registered_current_site",
    sidoCodes: ["11"],
    facilityTypes: ["headquarters", "factory"],
    facilitySemantics: "any",
    basisDate: "2026-09-09",
  },
  confidence: 0.98,
  source_span: sourceSpan,
};
const criteria = normalizeCriteria([rawCriterion], sourceSpan);
assert.equal(criteria.length, 1);

const axisAssessments: DeepAnalysisAxisAssessment[] = CRITERION_DIMENSIONS.map((dimension) => ({
  dimension,
  status: dimension === "premises" ? "condition_found" : "inspected_no_condition",
  confidence: dimension === "premises" ? 0.98 : 1,
  comment: null,
}));
const result: DeepAnalysisModelResult = {
  model: "claude-opus-4-8",
  analysisMarkdown: "# 현재 등록 사업장 조건",
  programIntent: null,
  criteria,
  axisAssessments,
  taxonomyProposals: [],
  usage: null,
  costUsd: null,
  rawToolInput: {
    criteria: [rawCriterion],
    axis_assessments: axisAssessments,
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
};
const seal = sealDeepAnalysisInput({
  grantId: "grant-premises-pipeline",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: sourceSpan,
  attachments: [],
});
const validation = validateDeepAnalysisResult({ seal, result });
assert.equal(validation.valid, true, JSON.stringify(validation.issues));
assert.equal(validation.criteria[0]?.canonicalCriterion.needs_review, false);

const normalizedOutput: DeepAnalysisNormalizedOutput = {
  schema: "deep-analysis-normalized-output-v2",
  result: {
    model: result.model,
    analysisMarkdown: result.analysisMarkdown,
    programIntent: result.programIntent,
    criteria: result.criteria,
    axisAssessments: result.axisAssessments,
    taxonomyProposals: result.taxonomyProposals,
    usage: result.usage,
    costUsd: result.costUsd,
    stopReason: result.stopReason,
  },
  validation: {
    valid: validation.valid,
    responseContractValid: validation.responseContractValid,
    axisCoverageComplete: validation.axisCoverageComplete,
    evidenceGrounded: validation.evidenceGrounded,
  },
  matcherRepresentability: assessDeepAnalysisMatcherRepresentability(result.criteria),
};
assert.equal(normalizedOutput.matcherRepresentability.items[0]?.status, "direct");

const promotion = buildDeepAnalysisPromotionPlan({
  run: {
    runId: "run-premises-pipeline",
    grantId: "12121212-1212-4212-8212-121212121212",
    source: "bizinfo",
    sourceId: "PBLN_PREMISES_PIPELINE",
    title: "사업장 조건 공고",
    model: result.model,
    promptVersion: "lab-deep-v22",
    startedAt: new Date("2026-09-09T00:00:00.000Z"),
    completedAt: new Date("2026-09-09T00:01:00.000Z"),
    inputChars: sourceSpan.length,
    inputSha256: seal.inputSha256,
    sourceRevisionSha256: seal.sourceRevisionSha256,
    costUsd: null,
  },
  output: normalizedOutput,
  currentCriteria: [],
  audit: {
    model: "claude-sonnet-5",
    promptVersion: "deep-analysis-blind-audit-v25",
    completedAt: new Date("2026-09-09T00:01:00.000Z"),
    verdict: "concur",
  },
});
const projected = promotion.plan.criteria[0]!;
assert.equal(projected.dimension, "premises");
assert.equal(projected.needs_review, false);
assert.equal(promotion.plan.conversion.downgraded, 0);

const company: CompanyProfile = {
  confidence: { premises: 0.6 },
  premises: {
    schemaVersion: "premises-v1",
    locations: [{
      locationId: "00000000-0000-4000-8000-000000000001",
      facilityType: "headquarters",
      sidoCode: "11",
      validFrom: "2026-09-01",
      validTo: null,
    }],
    coverage: {
      facilityTypes: ["headquarters", "factory"],
      validFrom: "2026-09-01",
      validTo: "2026-09-09",
      asOf: "2026-09-09T03:00:00.000Z",
      completeness: "complete",
    },
  },
  profile_evidence: {
    premises: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: "2026-09-09T03:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.6,
      scope: "user",
      persistenceClass: "portable_user_answer",
    },
  },
};
const matched = matchGrantCriteria([projected], company, {
  asOf: new Date("2026-09-09T03:00:00.000Z"),
});
assert.equal(matched.eligibility, "eligible");
assert.equal(matched.rule_trace[0]?.result, "pass");

console.log("premises analysis-to-matcher pipeline tests passed");
