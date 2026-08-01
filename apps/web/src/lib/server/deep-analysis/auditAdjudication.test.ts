import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import {
  adjudicateDeepAnalysisAudit,
  buildDeepAnalysisAuditCandidates,
  DEEP_ANALYSIS_AUDIT_DECISIVENESS_RULE,
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  normalizeDeepAnalysisAuditAdjudication,
} from "./auditAdjudication";
import { priceDeepAnalysisUsage } from "./costPolicy";
import {
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
} from "./extractor";
import { sealDeepAnalysisInput } from "./inputManifest";
import { validateDeepAnalysisResult } from "./validator";

const span = "부산 소재 기업만 신청 가능";
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
  /신청 시점의 필수조건·결격·결격 예외.*누락하거나 잘못 분류/,
);
assert.match(DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT, /preferred 조건은 이 감사의 범위가 아니다/);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /contract\/normalization 차이만으로 blocking finding을 만들지 마라/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /reviewed_candidate_keys에는 CRITERION_CANDIDATES의 key를 정확히 한 번씩 모두/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /candidateKind=audit_only.*candidate_key/,
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
    DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
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
for (const rule of [
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_AUDIT_DECISIVENESS_RULE,
]) {
  assert.equal(DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT.includes(rule), true);
}
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /value\.exceptions가 누락.*실질 오분류 finding/,
);
assert.match(
  DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
  /canonical 표현이 불완전.*uncertainties로 낮추지 마라/,
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

function resultWithCriteria(criteria: DeepAnalysisCriterion[]): DeepAnalysisModelResult {
  const found = new Set(criteria.map((criterion) => criterion.dimension));
  const axes = CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: found.has(dimension)
      ? "condition_found" as const
      : "inspected_no_condition" as const,
    confidence: 0.9,
    comment: "검사",
  }));
  return {
    model: "test",
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments: axes,
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

function result(regionCode: string): DeepAnalysisModelResult {
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
  return resultWithCriteria([criterion]);
}

const primaryResult = result("11");
const auditResult = result("26");
const primaryValidation = validateDeepAnalysisResult({ seal, result: primaryResult });
const auditValidation = validateDeepAnalysisResult({ seal, result: auditResult });
const auditOnlyRegionCandidate = buildDeepAnalysisAuditCandidates(
  primaryValidation,
  auditValidation,
).find((candidate) => (
  candidate.candidateKind === "audit_only" && candidate.dimension === "region"
));
assert.ok(auditOnlyRegionCandidate);
const adjudicationCandidateKeys = buildDeepAnalysisAuditCandidates(
  primaryValidation,
  auditValidation,
).map((candidate) => candidate.key);

const successResponseBody = JSON.stringify({
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 },
  content: [{
    type: "tool_use",
    name: "emit_deep_analysis_audit_adjudication",
    input: {
      reviewed_candidate_keys: adjudicationCandidateKeys,
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
  auditValidation,
  fetchImpl,
});
assert.equal(adjudicated.verdict, "concur");
assert.equal(adjudicated.model, "claude-sonnet-5");
assert.equal(adjudicated.effort, "high");
assert.equal(adjudicated.itemResults.length, adjudicationCandidateKeys.length);
assert.equal(adjudicated.itemResults.every((item) => item.verdict === "concur"), true);
assert.doesNotMatch(capturedRequestBody, /<<<PRIMARY_AXES>>>|<<<AUDIT_AXES>>>/);
assert.doesNotMatch(
  capturedRequestBody,
  /<<<PRIMARY_VALIDATION_ISSUES>>>|<<<AUDIT_VALIDATION_ISSUES>>>/,
);
assert.deepEqual(
  (JSON.parse(capturedRequestBody) as { output_config?: unknown }).output_config,
  { effort: "high" },
);
assert.deepEqual(adjudicated.usage, { inputTokens: 100, outputTokens: 50 });
assert.equal(adjudicated.costUsd, priceDeepAnalysisUsage({
  model: "claude-sonnet-5",
  usage: { inputTokens: 100, outputTokens: 50 },
}));

const blockingResponse = JSON.parse(successResponseBody) as {
  content: Array<{
    input: {
      blocking_findings: Array<{
        candidate_key: string;
        dimension: string;
        finding_type: string;
        reason: string;
      }>;
      uncertainties: Array<{
        candidate_key: string;
        dimension: string;
        reason: string;
      }>;
      reviewed_candidate_keys: string[];
    };
  }>;
};
blockingResponse.content[0]!.input.blocking_findings = [{
  candidate_key: auditOnlyRegionCandidate.key,
  dimension: "region",
  finding_type: "misclassified_eligibility",
  reason: "부산 조건이 서울 지역 코드로 분류됨",
}];
const explicitChange = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(blockingResponse),
    { status: 200 },
  ),
});
assert.equal(
  explicitChange.verdict,
  "disagree",
  JSON.stringify(explicitChange.findingValidation),
);
assert.equal(
  explicitChange.itemResults.find((item) => item.dimension === "region")?.verdict,
  "disagree",
);
assert.equal(explicitChange.findingValidation.acceptedCount, 1);
assert.deepEqual(explicitChange.findingValidation.accepted, [{
  candidateKey: auditOnlyRegionCandidate.key,
  dimension: "region",
  findingType: "misclassified_eligibility",
  reason: "부산 조건이 서울 지역 코드로 분류됨",
  criterion: auditOnlyRegionCandidate.audit,
}]);
assert.deepEqual(explicitChange.findingValidation.rejected, []);

const decisiveBlockerResponse = structuredClone(blockingResponse);
decisiveBlockerResponse.content[0]!.input.blocking_findings.push({
  candidate_key: "f".repeat(64),
  dimension: "business_status",
  finding_type: "missing_eligibility",
  reason: "별도 진단 행은 후보를 찾지 못함",
});
decisiveBlockerResponse.content[0]!.input.uncertainties = [{
  candidate_key: auditOnlyRegionCandidate.key,
  dimension: "region",
  reason: "별도 축의 적용 범위를 확정할 수 없음",
}];
const decisiveBlocker = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(decisiveBlockerResponse),
    { status: 200 },
  ),
});
assert.equal(decisiveBlocker.verdict, "disagree");
assert.equal(decisiveBlocker.findingValidation.acceptedCount, 1);
assert.equal(decisiveBlocker.findingValidation.accepted.length, 1);
assert.equal(
  decisiveBlocker.findingValidation.rejected[0]?.code,
  "candidate_not_found",
);
assert.equal(decisiveBlocker.uncertaintyValidation.retainedCount, 1);

const uncertaintyResponse = structuredClone(blockingResponse);
uncertaintyResponse.content[0]!.input.blocking_findings = [];
uncertaintyResponse.content[0]!.input.uncertainties = [{
  candidate_key: auditOnlyRegionCandidate.key,
  dimension: "region",
  reason: "원문이 서로 충돌해 지역 자격을 확정할 수 없음",
}];
const uncertain = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(uncertaintyResponse),
    { status: 200 },
  ),
});
assert.equal(uncertain.verdict, "unsure");

const incompleteReviewResponse = structuredClone(blockingResponse);
incompleteReviewResponse.content[0]!.input.blocking_findings = [];
incompleteReviewResponse.content[0]!.input.reviewed_candidate_keys =
  incompleteReviewResponse.content[0]!.input.reviewed_candidate_keys.slice(1);
const incompleteReview = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(incompleteReviewResponse),
    { status: 200 },
  ),
});
assert.equal(incompleteReview.verdict, "unsure");

const unknownCandidateResponse = structuredClone(blockingResponse);
unknownCandidateResponse.content[0]!.input.blocking_findings[0]!.candidate_key =
  "f".repeat(64);
const unknownCandidate = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
  auditValidation,
  fetchImpl: async () => new Response(
    JSON.stringify(unknownCandidateResponse),
    { status: 200 },
  ),
});
assert.equal(unknownCandidate.verdict, "unsure");
assert.equal(
  unknownCandidate.findingValidation.rejected[0]?.code,
  "candidate_not_found",
);

let invalidAuditFetchCalls = 0;
await assert.rejects(
  () => adjudicateDeepAnalysisAudit({
    apiKey: "test",
    model: "claude-sonnet-5",
    evidenceText: span,
    primaryResult,
    primaryValidation,
    auditValidation: { ...auditValidation, valid: false },
    fetchImpl: async () => {
      invalidAuditFetchCalls += 1;
      return new Response(successResponseBody, { status: 200 });
    },
  }),
  /refuses an invalid blind audit result/,
);
assert.equal(invalidAuditFetchCalls, 0);

function replayFinding(input: {
  source: string;
  primaryCriteria: DeepAnalysisCriterion[];
  auditCriteria: DeepAnalysisCriterion[];
  dimension: DeepAnalysisCriterion["dimension"];
  findingType: "missing_eligibility" | "misclassified_eligibility";
}) {
  const replaySeal = sealDeepAnalysisInput({
    grantId: `audit-replay-${input.dimension}`,
    sourceRevisionSha256: "9".repeat(64),
    structuredText: input.source,
    attachments: [],
  });
  const replayPrimary = validateDeepAnalysisResult({
    seal: replaySeal,
    result: resultWithCriteria(input.primaryCriteria),
  });
  const replayAudit = validateDeepAnalysisResult({
    seal: replaySeal,
    result: resultWithCriteria(input.auditCriteria),
  });
  assert.equal(replayPrimary.valid, true, JSON.stringify(replayPrimary.issues));
  assert.equal(replayAudit.valid, true, JSON.stringify(replayAudit.issues));
  const candidates = buildDeepAnalysisAuditCandidates(replayPrimary, replayAudit);
  const candidate = candidates.find((row) => (
    row.candidateKind === "audit_only" && row.dimension === input.dimension
  ));
  assert.ok(candidate);
  return normalizeDeepAnalysisAuditAdjudication({
    evidenceText: input.source,
    primaryCriteria: input.primaryCriteria,
    primaryValidation: replayPrimary,
    candidates,
    reviewedCandidateKeys: candidates.map((row) => row.key),
    findingRows: [{
      candidate_key: candidate.key,
      dimension: input.dimension,
      finding_type: input.findingType,
      reason: "offline replay finding",
    }],
    uncertaintyRows: [],
  });
}

function replayUncertainty(input: {
  source: string;
  primaryCriteria: DeepAnalysisCriterion[];
  auditCriteria: DeepAnalysisCriterion[];
  dimension: DeepAnalysisCriterion["dimension"];
}) {
  const replaySeal = sealDeepAnalysisInput({
    grantId: `audit-uncertainty-${input.dimension}`,
    sourceRevisionSha256: "7".repeat(64),
    structuredText: input.source,
    attachments: [],
  });
  const replayPrimary = validateDeepAnalysisResult({
    seal: replaySeal,
    result: resultWithCriteria(input.primaryCriteria),
  });
  const replayAudit = validateDeepAnalysisResult({
    seal: replaySeal,
    result: resultWithCriteria(input.auditCriteria),
  });
  assert.equal(replayPrimary.valid, true, JSON.stringify(replayPrimary.issues));
  assert.equal(replayAudit.valid, true, JSON.stringify(replayAudit.issues));
  const candidates = buildDeepAnalysisAuditCandidates(replayPrimary, replayAudit);
  const uncertaintyCandidate = candidates.find((candidate) => (
    candidate.dimension === input.dimension
  ));
  assert.ok(uncertaintyCandidate);
  return normalizeDeepAnalysisAuditAdjudication({
    evidenceText: input.source,
    primaryCriteria: input.primaryCriteria,
    primaryValidation: replayPrimary,
    candidates,
    reviewedCandidateKeys: candidates.map((row) => row.key),
    findingRows: [],
    uncertaintyRows: [{
      candidate_key: uncertaintyCandidate.key,
      dimension: input.dimension,
      reason: "offline replay uncertainty",
    }],
  });
}

const taxSpan =
  "국세 또는 지방세 체납 중인 기업은 제외하되 특수채무 변제 후 증빙이 가능한 자는 예외로 한다.";
const taxPrimary: DeepAnalysisCriterion = {
  dimension: "tax_compliance",
  operator: "in",
  kind: "exclusion",
  value: {
    flags: ["national_tax_delinquent", "local_tax_delinquent"],
    exceptions: ["payment_deferral_approved"],
  },
  confidence: 0.95,
  sourceSpan: taxSpan,
  spanVerified: true,
  note: null,
};
const knownTaxMiss = replayFinding({
  source: taxSpan,
  primaryCriteria: [taxPrimary],
  auditCriteria: [{
    ...taxPrimary,
    value: {
      flags: ["national_tax_delinquent", "local_tax_delinquent"],
      exceptions: ["payment_deferral_approved", "tax_debt_repaid_with_proof"],
    },
  }],
  dimension: "tax_compliance",
  findingType: "misclassified_eligibility",
});
assert.equal(knownTaxMiss.verdict, "disagree");
assert.equal(knownTaxMiss.findingValidation.acceptedCount, 1);

const creditSpan =
  "채무불이행 규제 중인 기업은 제외하되 파산절차에서 면책결정이 확정된 자는 예외로 한다.";
const creditPrimary: DeepAnalysisCriterion = {
  dimension: "credit_status",
  operator: "in",
  kind: "exclusion",
  value: {
    flags: ["loan_default"],
    exceptions: ["retry_guarantee_recipient"],
  },
  confidence: 0.95,
  sourceSpan: creditSpan,
  spanVerified: true,
  note: null,
};
const knownBankruptcyMiss = replayFinding({
  source: creditSpan,
  primaryCriteria: [creditPrimary],
  auditCriteria: [{
    ...creditPrimary,
    value: {
      flags: ["loan_default"],
      exceptions: ["retry_guarantee_recipient", "bankruptcy_discharge_confirmed"],
    },
  }],
  dimension: "credit_status",
  findingType: "misclassified_eligibility",
});
assert.equal(knownBankruptcyMiss.verdict, "disagree");
assert.equal(knownBankruptcyMiss.findingValidation.acceptedCount, 1);

const premisesSpan = "하남시 관내에 주된 사무소(본사) 또는 제조시설(공장)을 둔 기업";
const knownPremisesMiss = replayFinding({
  source: premisesSpan,
  primaryCriteria: [],
  auditCriteria: [{
    dimension: "premises",
    operator: "text_only",
    kind: "required",
    value: { note: premisesSpan },
    confidence: 0.95,
    sourceSpan: premisesSpan,
    spanVerified: true,
    note: null,
  }],
  dimension: "premises",
  findingType: "missing_eligibility",
});
assert.equal(knownPremisesMiss.verdict, "disagree");
assert.equal(knownPremisesMiss.findingValidation.acceptedCount, 1);

const falseRegion = replayFinding({
  source: span,
  primaryCriteria: result("26").criteria,
  auditCriteria: result("48").criteria,
  dimension: "region",
  findingType: "misclassified_eligibility",
});
assert.equal(falseRegion.verdict, "unsure");
assert.equal(falseRegion.findingValidation.rejected[0]?.code, "region_value_conflict");

const certificationSpan = "경기도 유망중소기업, 벤처기업, 여성기업 인증은 1점/건 가점";
const certificationPrimary: DeepAnalysisCriterion = {
  dimension: "certification",
  operator: "text_only",
  kind: "preferred",
  value: { note: "인증별 1점 가점" },
  confidence: 0.9,
  sourceSpan: certificationSpan,
  spanVerified: true,
  note: null,
};
const certificationSeal = sealDeepAnalysisInput({
  grantId: "audit-replay-certification",
  sourceRevisionSha256: "8".repeat(64),
  structuredText: certificationSpan,
  attachments: [],
});
const certificationPrimaryValidation = validateDeepAnalysisResult({
  seal: certificationSeal,
  result: resultWithCriteria([certificationPrimary]),
});
const certificationAuditValidation = validateDeepAnalysisResult({
  seal: certificationSeal,
  result: resultWithCriteria([{
    ...certificationPrimary,
    value: { note: "경기도 유망중소기업·벤처기업·여성기업 인증 1점/건" },
  }]),
});
const certificationCandidates = buildDeepAnalysisAuditCandidates(
  certificationPrimaryValidation,
  certificationAuditValidation,
);
assert.equal(
  certificationCandidates.some((candidate) => (
    candidate.candidateKind === "audit_only" && candidate.dimension === "certification"
  )),
  false,
);
const alreadyRepresentedCertification = normalizeDeepAnalysisAuditAdjudication({
  evidenceText: certificationSpan,
  primaryCriteria: [certificationPrimary],
  primaryValidation: certificationPrimaryValidation,
  candidates: certificationCandidates,
  reviewedCandidateKeys: [],
  findingRows: [{
    candidate_key: "e".repeat(64),
    dimension: "certification",
    finding_type: "misclassified_eligibility",
    reason: "이미 보존된 인증 가점이 누락되었다고 주장",
  }],
  uncertaintyRows: [],
});
assert.equal(alreadyRepresentedCertification.verdict, "unsure");
assert.equal(
  alreadyRepresentedCertification.findingValidation.rejected[0]?.code,
  "candidate_not_found",
);

const crossDimensionScoringSpan =
  "▲ 경기도 유망중소기업, ▲ 하남시 일자리창출 우수기업, ▲ 이노(메인)비즈 인증기업, ▲ 벤처기업, ▲ 경기가족친화 일하기 좋은기업, ▲ 장애인기업, ▲ 여성기업 ▲ 사회적기업 ▲ 경기도일자리우수기업 ( 1 점/건)";
const preferredOnlySeal = sealDeepAnalysisInput({
  grantId: "audit-preferred-only",
  sourceRevisionSha256: "6".repeat(64),
  structuredText: crossDimensionScoringSpan,
  attachments: [],
});
const preferredOnlyPrimary = validateDeepAnalysisResult({
  seal: preferredOnlySeal,
  result: resultWithCriteria([{
    dimension: "certification",
    operator: "text_only",
    kind: "preferred",
    value: { note: crossDimensionScoringSpan },
    confidence: 0.85,
    sourceSpan: crossDimensionScoringSpan,
    spanVerified: true,
    note: null,
  }]),
});
const preferredOnlyAudit = validateDeepAnalysisResult({
  seal: preferredOnlySeal,
  result: resultWithCriteria([{
    dimension: "prior_award",
    operator: "text_only",
    kind: "preferred",
    value: { note: crossDimensionScoringSpan },
    confidence: 0.85,
    sourceSpan: crossDimensionScoringSpan,
    spanVerified: true,
    note: null,
  }]),
});
assert.deepEqual(
  buildDeepAnalysisAuditCandidates(preferredOnlyPrimary, preferredOnlyAudit),
  [],
);

const crossDimensionRequiredText = replayFinding({
  source: crossDimensionScoringSpan,
  primaryCriteria: [{
    dimension: "certification",
    operator: "text_only",
    kind: "required",
    value: { note: "인증 보유 필수" },
    confidence: 0.85,
    sourceSpan: crossDimensionScoringSpan,
    spanVerified: true,
    note: null,
  }],
  auditCriteria: [{
    dimension: "prior_award",
    operator: "text_only",
    kind: "required",
    value: { note: "선정 이력 필수" },
    confidence: 0.85,
    sourceSpan: crossDimensionScoringSpan,
    spanVerified: true,
    note: null,
  }],
  dimension: "prior_award",
  findingType: "missing_eligibility",
});
assert.equal(crossDimensionRequiredText.verdict, "disagree");
assert.equal(crossDimensionRequiredText.findingValidation.acceptedCount, 1);

const unsupportedBizAgeSpan =
  "□ 지원대상 : 부산지역 예비 · 초기 창업패키지 및 창업중심대학 선정된 예비창업자 및 초기창업자 중 17개 팀";
const unsupportedBizAgeUncertainty = replayUncertainty({
  source: unsupportedBizAgeSpan,
  primaryCriteria: [],
  auditCriteria: [{
    dimension: "biz_age",
    operator: "between",
    kind: "required",
    value: {
      include_preliminary: true,
      min_months: 0,
      max_months: 36,
    },
    confidence: 0.92,
    sourceSpan: unsupportedBizAgeSpan,
    spanVerified: true,
    note: "초기창업자는 일반적으로 창업 후 3년 이내",
  }],
  dimension: "biz_age",
});
assert.equal(unsupportedBizAgeUncertainty.verdict, "concur");
assert.equal(unsupportedBizAgeUncertainty.uncertaintyValidation.retainedCount, 0);
assert.equal(unsupportedBizAgeUncertainty.uncertaintyValidation.dismissed.length, 1);
assert.equal(
  unsupportedBizAgeUncertainty.uncertaintyValidation.dismissed[0]?.code,
  "unsupported_biz_age_bound",
);

for (const explicitBizAgeSpan of [
  "신청일 기준 창업 3년 이내인 기업",
  "신청일 기준 창업 삼년 이내인 기업",
  "2023년 1월 1일 이후 설립된 기업",
]) {
  const explicitBizAgeUncertainty = replayUncertainty({
    source: explicitBizAgeSpan,
    primaryCriteria: [],
    auditCriteria: [{
      dimension: "biz_age",
      operator: "between",
      kind: "required",
      value: {
        min_months: 0,
        max_months: 36,
      },
      confidence: 0.9,
      sourceSpan: explicitBizAgeSpan,
      spanVerified: true,
      note: null,
    }],
    dimension: "biz_age",
  });
  assert.equal(explicitBizAgeUncertainty.verdict, "unsure", explicitBizAgeSpan);
  assert.equal(explicitBizAgeUncertainty.uncertaintyValidation.retainedCount, 1);
  assert.deepEqual(explicitBizAgeUncertainty.uncertaintyValidation.dismissed, []);
}

const multipleBizAgeCandidates = replayUncertainty({
  source: unsupportedBizAgeSpan,
  primaryCriteria: [],
  auditCriteria: [
    {
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      value: { max_months: 36 },
      confidence: 0.8,
      sourceSpan: unsupportedBizAgeSpan,
      spanVerified: true,
      note: null,
    },
    {
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      value: { max_months: 60 },
      confidence: 0.8,
      sourceSpan: unsupportedBizAgeSpan,
      spanVerified: true,
      note: null,
    },
  ],
  dimension: "biz_age",
});
assert.equal(multipleBizAgeCandidates.verdict, "unsure");
assert.equal(multipleBizAgeCandidates.uncertaintyValidation.retainedCount, 1);
assert.deepEqual(multipleBizAgeCandidates.uncertaintyValidation.dismissed, []);

const primaryBizAgeRemainsFailClosed = replayUncertainty({
  source: `업력 7년 이내 기업\n${unsupportedBizAgeSpan}`,
  primaryCriteria: [{
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    value: { max_months: 84 },
    confidence: 0.9,
    sourceSpan: "업력 7년 이내 기업",
    spanVerified: true,
    note: null,
  }],
  auditCriteria: [{
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    value: { max_months: 36 },
    confidence: 0.9,
    sourceSpan: unsupportedBizAgeSpan,
    spanVerified: true,
    note: null,
  }],
  dimension: "biz_age",
});
assert.equal(primaryBizAgeRemainsFailClosed.verdict, "unsure");
assert.equal(primaryBizAgeRemainsFailClosed.uncertaintyValidation.retainedCount, 1);
assert.deepEqual(primaryBizAgeRemainsFailClosed.uncertaintyValidation.dismissed, []);

const nonBizAgeUncertainty = replayUncertainty({
  source: span,
  primaryCriteria: [],
  auditCriteria: result("26").criteria,
  dimension: "region",
});
assert.equal(nonBizAgeUncertainty.verdict, "unsure");
assert.equal(nonBizAgeUncertainty.uncertaintyValidation.retainedCount, 1);
assert.deepEqual(nonBizAgeUncertainty.uncertaintyValidation.dismissed, []);

const earlyFounderSpan = "예비창업자 및 초기창업자를 모집한다.";
const unboundedBizAge = replayFinding({
  source: earlyFounderSpan,
  primaryCriteria: [],
  auditCriteria: [{
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    value: { include_preliminary: true },
    confidence: 0.8,
    sourceSpan: earlyFounderSpan,
    spanVerified: true,
    note: null,
  }],
  dimension: "biz_age",
  findingType: "missing_eligibility",
});
assert.equal(unboundedBizAge.verdict, "unsure");
assert.equal(unboundedBizAge.findingValidation.rejected[0]?.code, "biz_age_bound_missing");

const discretionarySpan =
  "기타 주최·주관기관장이 참여를 제한할 정당한 사유가 있다고 인정하는 자";
const discretionarySanction = replayFinding({
  source: discretionarySpan,
  primaryCriteria: [{
    dimension: "other",
    operator: "text_only",
    kind: "exclusion",
    value: { note: discretionarySpan },
    confidence: 0.8,
    sourceSpan: discretionarySpan,
    spanVerified: true,
    note: null,
  }],
  auditCriteria: [{
    dimension: "sanction",
    operator: "in",
    kind: "exclusion",
    value: { flags: ["participation_restricted"] },
    confidence: 0.8,
    sourceSpan: discretionarySpan,
    spanVerified: true,
    note: null,
  }],
  dimension: "sanction",
  findingType: "missing_eligibility",
});
assert.equal(discretionarySanction.verdict, "unsure");
assert.equal(
  discretionarySanction.findingValidation.rejected[0]?.code,
  "discretionary_sanction",
);

let retryCalls = 0;
const retried = await adjudicateDeepAnalysisAudit({
  apiKey: "test",
  model: "claude-sonnet-5",
  evidenceText: span,
  primaryResult,
  primaryValidation,
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
