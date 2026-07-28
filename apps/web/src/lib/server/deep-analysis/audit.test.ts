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
import {
  buildDeepAnalysisAuditToolSchema,
  DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION,
  DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT,
  normalizeDeepAnalysisAuditCandidateResult,
  runDeepGrantAuditAnalysis,
} from "./auditExtractor";
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
  /criterion 후보만 반환/,
);
assert.match(DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION, /axis_assessments.*출력하지 마라/);
assert.match(DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT, /조건이 없는 축을 표현하는 행을 만들지 마라/);
assert.equal(DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION, "deep-analysis-audit-candidates-v1");

const auditToolSchema = buildDeepAnalysisAuditToolSchema();
assert.deepEqual(
  Object.keys(auditToolSchema.input_schema.properties),
  ["criteria"],
);
assert.equal(
  "axis_assessments" in auditToolSchema.input_schema.properties,
  false,
);
assert.equal(
  "analysis_markdown" in auditToolSchema.input_schema.properties,
  false,
);

const candidateResult = normalizeDeepAnalysisAuditCandidateResult({
  model: "claude-haiku-4-5-20251001",
  effort: null,
  evidenceText: span,
  rawToolInput: {
    criteria: [{
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["11"] },
      confidence: 0.9,
      source_span: span,
    }],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
assert.equal(candidateResult.axisAssessments.length, CRITERION_DIMENSIONS.length);
assert.equal(
  candidateResult.axisAssessments.find((axis) => axis.dimension === "region")?.status,
  "condition_found",
);
assert.equal(
  candidateResult.axisAssessments.find((axis) => axis.dimension === "revenue")?.status,
  "inspected_no_condition",
);
assert.equal(
  validateDeepAnalysisResult({ seal, result: candidateResult }).valid,
  true,
);

const invalidAbsenceRow = normalizeDeepAnalysisAuditCandidateResult({
  model: "claude-haiku-4-5-20251001",
  effort: null,
  evidenceText: span,
  rawToolInput: {
    criteria: [
      {
        dimension: "region",
        operator: "in",
        kind: "required",
        value: { regions: ["11"] },
        confidence: 0.9,
        source_span: span,
      },
      {
        dimension: "revenue",
        operator: "text_only",
        kind: "inspected_no_condition",
        value: {},
        confidence: 0,
        source_span: "",
      },
    ],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
const invalidAbsenceValidation = validateDeepAnalysisResult({
  seal,
  result: invalidAbsenceRow,
});
assert.equal(invalidAbsenceValidation.valid, false);
assert.equal(
  invalidAbsenceValidation.issues.some((issue) => issue.code === "normalization_drop"),
  true,
);
assert.equal(
  invalidAbsenceValidation.issues.some((issue) => issue.code === "raw_contract_invalid"),
  true,
);

let capturedAuditRequest: Record<string, unknown> = {};
const fetchedCandidateResult = await runDeepGrantAuditAnalysis({
  apiKey: "test-key",
  model: "claude-haiku-4-5-20251001",
  effort: null,
  inputText: span,
  fetchImpl: async (_url, init) => {
    capturedAuditRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      content: [{
        type: "tool_use",
        name: "emit_deep_analysis_audit_candidates",
        input: {
          criteria: [{
            dimension: "region",
            operator: "in",
            kind: "required",
            value: { regions: ["11"] },
            confidence: 0.9,
            source_span: span,
          }],
        },
      }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200 });
  },
});
const requestedTools = capturedAuditRequest.tools as Array<{
  name: string;
  input_schema: { properties: Record<string, unknown> };
}>;
assert.equal(requestedTools[0]?.name, "emit_deep_analysis_audit_candidates");
assert.deepEqual(Object.keys(requestedTools[0]?.input_schema.properties ?? {}), ["criteria"]);
assert.equal(fetchedCandidateResult.axisAssessments.length, CRITERION_DIMENSIONS.length);
assert.equal(
  validateDeepAnalysisResult({ seal, result: fetchedCandidateResult }).valid,
  true,
);

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
