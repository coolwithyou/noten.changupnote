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
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
} from "./extractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import { validateDeepAnalysisResult } from "./validator";

const span = "서울 소재 기업만 신청 가능";
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /이미 primary에 반영됐거나 중복.*accept_primary.*change_required를 반환하지 마라/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /같은 criterion 배열.*재생성할 필요가 없다/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /신청 시점의 자격·결격·우대·평가점수.*22축.*누락하거나 잘못 분류/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /contract\/normalization 차이만으로 change_required를 반환하지 마라/,
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
assert.equal(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(
    DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  ),
  true,
);
assert.equal(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(
    DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  ),
  true,
);
assert.equal(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(
    DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  ),
  true,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /value\.exceptions가 누락.*change_required/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /지원 취소.*협약서 등 관련 문서에서 명시한 사항을 2회 이상 위반.*sanction\/other criterion이 아니다/,
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
let capturedRequestBody = "";
const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  capturedRequestBody = String(init?.body ?? "");
  return new Response(successResponseBody, { status: 200 });
};

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
assert.match(capturedRequestBody, /<<<PRIMARY_VALIDATION_ISSUES>>>/);
assert.match(capturedRequestBody, /<<<AUDIT_VALIDATION_ISSUES>>>/);
assert.deepEqual(adjudicated.usage, { inputTokens: 100, outputTokens: 50 });
assert.equal(adjudicated.costUsd, priceDeepAnalysisUsage({
  model: "claude-sonnet-5",
  usage: { inputTokens: 100, outputTokens: 50 },
}));

const contradictoryAcceptResponse = JSON.parse(successResponseBody) as {
  content: Array<{
    input: {
      criterion_verdicts: Array<{
        key: string;
        verdict: string;
        reason: string;
      }>;
    };
  }>;
};
const contradictoryAcceptRow =
  contradictoryAcceptResponse.content[0]!.input.criterion_verdicts
    .find((row) => row.key === auditKey)!;
contradictoryAcceptRow.verdict = "change_required";
contradictoryAcceptRow.reason =
  "primary에 이미 반영된 중복이므로 accept_primary로 재조정.";
const contradictoryChange = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(contradictoryAcceptResponse),
    { status: 200 },
  ),
});
assert.equal(contradictoryChange.verdict, "disagree");
assert.equal(
  contradictoryChange.itemResults.find((item) => item.key === auditKey)?.verdict,
  "disagree",
);

const explicitChangeResponse = structuredClone(contradictoryAcceptResponse);
const explicitChangeRow =
  explicitChangeResponse.content[0]!.input.criterion_verdicts
    .find((row) => row.key === auditKey)!;
explicitChangeRow.reason =
  "accept_primary가 아니라 원문의 실질 누락이므로 change_required.";
const explicitChange = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(explicitChangeResponse),
    { status: 200 },
  ),
});
assert.equal(explicitChange.verdict, "disagree");

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
