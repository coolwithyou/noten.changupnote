import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import {
  compareDeepAnalysisValidations,
  DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION,
  resolveSemanticAuditVerdict,
  shouldRunSemanticAuditAdjudication,
} from "./audit";
import { sealDeepAnalysisInput } from "./inputManifest";
import { validateDeepAnalysisResult } from "./validator";

const span = "서울 소재 기업만 신청 가능";
const seal = sealDeepAnalysisInput({
  grantId: "audit-grant",
  sourceRevisionSha256: "d".repeat(64),
  structuredText: span,
  attachments: [],
});

assert.match(
  DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION,
  /criteria와 정확히 22개의 axis_assessments를 가장 먼저 완성/,
);
assert.match(DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION, /전체 1,200자 이내/);

function makeResult(criteria: DeepAnalysisCriterion[]): DeepAnalysisModelResult {
  const found = new Set(criteria.map((criterion) => criterion.dimension));
  const axisAssessments: DeepAnalysisAxisAssessment[] = CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: found.has(dimension) ? "condition_found" : "inspected_no_condition",
    confidence: 0.9,
    comment: "검사",
  }));
  return {
    model: "test",
    analysisMarkdown: "# 분석",
    programIntent: null,
    criteria,
    axisAssessments,
    taxonomyProposals: [],
    usage: null,
    costUsd: null,
    rawToolInput: {
      criteria: criteria.map((criterion) => ({
        dimension: criterion.dimension,
        operator: criterion.operator,
        kind: criterion.kind,
        value: criterion.value,
        confidence: criterion.confidence,
        source_span: criterion.sourceSpan,
      })),
      axis_assessments: axisAssessments.map((axis) => ({
        dimension: axis.dimension,
        status: axis.status,
        confidence: axis.confidence,
        comment: axis.comment,
      })),
    },
    rawResponseText: "{}",
    stopReason: "tool_use",
  };
}

function region(value = "11"): DeepAnalysisCriterion {
  return {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: [value] },
    confidence: 0.9,
    sourceSpan: span,
    spanVerified: true,
    note: null,
  };
}

const primaryResult = makeResult([region()]);
const primary = validateDeepAnalysisResult({ seal, result: primaryResult });
const sameResult = makeResult([region()]);
const same = validateDeepAnalysisResult({ seal, result: sameResult });
const concurrence = compareDeepAnalysisValidations({
  primary,
  primaryResult,
  audit: same,
  auditResult: sameResult,
});
assert.equal(concurrence.verdict, "concur");
assert.equal(concurrence.itemResults.every((item) => item.verdict === "concur"), true);

const differentResult = makeResult([region("26")]);
const different = validateDeepAnalysisResult({ seal, result: differentResult });
const disagreement = compareDeepAnalysisValidations({
  primary,
  primaryResult,
  audit: different,
  auditResult: differentResult,
});
assert.equal(disagreement.verdict, "disagree");
assert.equal(
  disagreement.itemResults.filter((item) => item.kind === "criterion" && item.verdict === "disagree").length,
  2,
);

const emptyResult = makeResult([]);
const empty = validateDeepAnalysisResult({ seal, result: emptyResult });
const missed = compareDeepAnalysisValidations({
  primary,
  primaryResult,
  audit: empty,
  auditResult: emptyResult,
});
assert.equal(missed.verdict, "disagree");
assert.equal(
  missed.itemResults.some((item) => item.kind === "axis" && item.dimension === "region" && item.verdict === "disagree"),
  true,
);

assert.equal(shouldRunSemanticAuditAdjudication({
  primaryValid: true,
  auditValid: false,
  comparisonVerdict: "disagree",
}), false);
assert.equal(shouldRunSemanticAuditAdjudication({
  primaryValid: true,
  auditValid: true,
  comparisonVerdict: "concur",
}), false);
assert.equal(resolveSemanticAuditVerdict({
  auditValid: false,
  comparisonVerdict: "disagree",
  adjudicationVerdict: "concur",
}), "unsure");
assert.equal(resolveSemanticAuditVerdict({
  auditValid: false,
  comparisonVerdict: "disagree",
  adjudicationVerdict: null,
}), "unsure");

console.log("deep-analysis blind audit tests passed");
