import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import {
  adjudicateDeepAnalysisAudit,
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
} from "./auditAdjudication";
import { priceDeepAnalysisUsage } from "./costPolicy";
import {
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
} from "./extractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import { validateDeepAnalysisResult } from "./validator";

const span = "서울 소재 기업만 신청 가능";
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /이미 primary에 반영됐거나 중복.*accept_primary.*change_required를 반환하지 마라/,
);
assert.equal(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(
    DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  ),
  true,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /'부도 또는 파산기업\(예정 포함\)'.*credit_status의 bond_default\/bankruptcy_filed만.*business_status는 inspected_no_condition/,
);
assert.equal(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(
    DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  ),
  true,
);
assert.equal(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(
    DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  ),
  true,
);
const seal = sealDeepAnalysisInput({
  grantId: "audit-adjudication",
  sourceRevisionSha256: "1".repeat(64),
  structuredText: span,
  attachments: [],
});

function result(regionCode: string): DeepAnalysisModelResult {
  const axes = CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: dimension === "region" ? "condition_found" as const : "inspected_no_condition" as const,
    confidence: 0.9,
    comment: "검사",
  }));
  const criterion = {
    dimension: "region" as const,
    operator: "in",
    kind: "required" as const,
    value: { regions: [regionCode] },
    confidence: 0.9,
    sourceSpan: span,
    spanVerified: true,
    note: null,
  };
  return {
    model: "test",
    analysisMarkdown: "",
    programIntent: null,
    criteria: [criterion],
    axisAssessments: axes,
    taxonomyProposals: [],
    usage: null,
    costUsd: null,
    rawToolInput: {
      criteria: [{
        dimension: criterion.dimension,
        operator: criterion.operator,
        kind: criterion.kind,
        value: criterion.value,
        confidence: criterion.confidence,
        source_span: criterion.sourceSpan,
      }],
      axis_assessments: axes.map((axis) => ({
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

const primaryResult = result("11");
const auditResult = result("26");
const primaryValidation = validateDeepAnalysisResult({ seal, result: primaryResult });
const auditValidation = validateDeepAnalysisResult({ seal, result: auditResult });
const primaryKey = primaryValidation.criteria[0]!.semanticSha256;
const auditKey = auditValidation.criteria[0]!.semanticSha256;

const successResponseBody = JSON.stringify({
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 },
  content: [{
    type: "tool_use",
    name: "emit_deep_analysis_audit_adjudication",
    input: {
      criterion_verdicts: [
        {
          kind: "criterion",
          dimension: "region",
          candidate_kind: "primary",
          key: primaryKey,
          verdict: "accept_primary",
          reason: "원문과 일치",
        },
        {
          kind: "criterion",
          dimension: "region",
          candidate_kind: "audit_only",
          key: auditKey,
          verdict: "accept_primary",
          reason: "독립 분석의 코드 해석 오류",
        },
      ],
      axis_verdicts: CRITERION_DIMENSIONS.map((dimension) => ({
        dimension,
        verdict: "accept_primary",
        reason: "원문과 일치",
      })),
    },
  }],
});
const fetchImpl = async (): Promise<Response> => new Response(successResponseBody, { status: 200 });

const adjudicated = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl,
});
assert.equal(adjudicated.verdict, "concur");
assert.equal(adjudicated.itemResults.length, CRITERION_DIMENSIONS.length + 2);
assert.deepEqual(adjudicated.usage, { inputTokens: 100, outputTokens: 50 });
assert.equal(adjudicated.costUsd, priceDeepAnalysisUsage({
  model: "claude-sonnet-5",
  usage: { inputTokens: 100, outputTokens: 50 },
}));

let retryCalls = 0;
const retried = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  retryDelayMs: 0,
  fetchImpl: async () => {
    retryCalls += 1;
    return retryCalls === 1
      ? new Response("rate limited", { status: 429 })
      : new Response(successResponseBody, { status: 200 });
  },
});
assert.equal(retryCalls, 2);
assert.equal(retried.verdict, "concur");

console.log("deep-analysis audit adjudication tests passed");
