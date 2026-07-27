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
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
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
  /blocking_findings에는 원문으로 입증된 primary의 실질 누락 또는 오분류만/,
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
  /contract\/normalization 차이만으로 blocking finding을 만들지 마라/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /reviewed_dimensions에는 22축을 정확히 한 번씩 모두/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /실제 blocker와 uncertainty가 모두 없으면 두 배열을 비워/,
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
    DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  ),
  true,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /납세증명서·사업자등록증·보험서류.*제출 요구만으로.*ambiguous 후보를 만들지 마라/,
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
  /value\.exceptions가 누락.*실질 오분류 finding/,
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

const successResponseBody = JSON.stringify({
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 },
  content: [{
    type: "tool_use",
    name: "emit_deep_analysis_audit_adjudication",
    input: {
      reviewed_dimensions: [...CRITERION_DIMENSIONS],
      blocking_findings: [],
      uncertainties: [],
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
assert.equal(adjudicated.itemResults.length, CRITERION_DIMENSIONS.length);
assert.equal(adjudicated.itemResults.every((item) => item.verdict === "concur"), true);
assert.match(capturedRequestBody, /<<<PRIMARY_VALIDATION_ISSUES>>>/);
assert.match(capturedRequestBody, /<<<AUDIT_VALIDATION_ISSUES>>>/);
assert.deepEqual(adjudicated.usage, { inputTokens: 100, outputTokens: 50 });
assert.equal(adjudicated.costUsd, priceDeepAnalysisUsage({
  model: "claude-sonnet-5",
  usage: { inputTokens: 100, outputTokens: 50 },
}));

const blockingResponse = JSON.parse(successResponseBody) as {
  content: Array<{
    input: {
      blocking_findings: Array<{
        dimension: string;
        finding_type: string;
        source_span: string;
        reason: string;
      }>;
      uncertainties: Array<{ dimension: string; reason: string }>;
      reviewed_dimensions: string[];
    };
  }>;
};
blockingResponse.content[0]!.input.blocking_findings = [{
  dimension: "region",
  finding_type: "misclassified_eligibility",
  source_span: span,
  reason: "서울 조건이 다른 지역 코드로 분류됨",
}];
const explicitChange = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(blockingResponse),
    { status: 200 },
  ),
});
assert.equal(explicitChange.verdict, "disagree");
assert.equal(
  explicitChange.itemResults.find((item) => item.dimension === "region")?.verdict,
  "disagree",
);

const uncertaintyResponse = structuredClone(blockingResponse);
uncertaintyResponse.content[0]!.input.blocking_findings = [];
uncertaintyResponse.content[0]!.input.uncertainties = [{
  dimension: "region",
  reason: "원문이 서로 충돌해 지역 자격을 확정할 수 없음",
}];
const uncertain = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(uncertaintyResponse),
    { status: 200 },
  ),
});
assert.equal(uncertain.verdict, "unsure");

const incompleteReviewResponse = structuredClone(blockingResponse);
incompleteReviewResponse.content[0]!.input.blocking_findings = [];
incompleteReviewResponse.content[0]!.input.reviewed_dimensions =
  incompleteReviewResponse.content[0]!.input.reviewed_dimensions.slice(1);
const incompleteReview = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(incompleteReviewResponse),
    { status: 200 },
  ),
});
assert.equal(incompleteReview.verdict, "unsure");

const ungroundedResponse = structuredClone(blockingResponse);
ungroundedResponse.content[0]!.input.blocking_findings[0]!.source_span =
  "원문에 없는 지역 제한";
const ungrounded = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditResult,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(ungroundedResponse),
    { status: 200 },
  ),
});
assert.equal(ungrounded.verdict, "unsure");

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
