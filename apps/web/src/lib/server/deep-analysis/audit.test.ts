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
  validateDeepAnalysisAuditResult,
} from "./audit";
import {
  assessDeepAnalysisMatchImpactingAuditScope,
  DEEP_ANALYSIS_AUDIT_SCOPE_VERSION,
} from "./auditScope";
import {
  buildDeepAnalysisAuditToolSchema,
  DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION,
  DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT,
  normalizeDeepAnalysisAuditCandidateResult,
  repairDeepAnalysisAuditCriteriaContract,
  runDeepGrantAuditAnalysis,
} from "./auditExtractor";
import { createDeepAnalysisAuditEvidenceCatalog } from "./auditEvidence";
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
  /required·exclusion·결격 예외 criterion 후보만 반환/,
);
assert.match(DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION, /preferred 후보는 반환하지 마라/);
assert.match(DEEP_ANALYSIS_BLIND_AUDIT_TASK_INSTRUCTION, /axis_assessments.*출력하지 마라/);
assert.match(DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT, /조건이 없는 축을 표현하는 행을 만들지 마라/);
assert.match(DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT, /primary_source_ref/);
assert.match(DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT, /impairment_excluded는 반드시.*배열/);
assert.match(DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT, /prior_award exclusion은 범위를 반드시/);
assert.equal(DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION, "deep-analysis-audit-candidates-v5");
assert.equal(DEEP_ANALYSIS_AUDIT_SCOPE_VERSION, "deep-analysis-match-impacting-scope-v1");

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
const auditCriterionProperties =
  auditToolSchema.input_schema.properties.criteria.items.properties;
assert.equal("source_span" in auditCriterionProperties, false);
assert.equal("primary_source_ref" in auditCriterionProperties, true);
assert.deepEqual(auditCriterionProperties.kind.enum, ["required", "exclusion"]);

const auditEvidence = createDeepAnalysisAuditEvidenceCatalog(span);
const sourceRef = /\[(ev_[0-9a-f]{16})\]/.exec(auditEvidence.promptText)?.[1];
assert.ok(sourceRef);

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
      primary_source_ref: sourceRef,
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
        primary_source_ref: sourceRef,
      },
      {
        dimension: "revenue",
        operator: "text_only",
        kind: "inspected_no_condition",
        value: {},
        confidence: 0,
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

const unresolvedReferenceResult = normalizeDeepAnalysisAuditCandidateResult({
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
      primary_source_ref: "ev_0000000000000000",
    }],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
const unresolvedReferenceValidation = validateDeepAnalysisResult({
  seal,
  result: unresolvedReferenceResult,
});
assert.equal(unresolvedReferenceValidation.valid, false);
assert.deepEqual(
  unresolvedReferenceResult.rawToolInput.audit_source_reference_errors,
  ["ev_0000000000000000"],
);
assert.equal(
  unresolvedReferenceValidation.issues.some((issue) => issue.code === "evidence_not_grounded"),
  true,
);

const unresolvedSupportingReferenceResult = normalizeDeepAnalysisAuditCandidateResult({
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
      primary_source_ref: sourceRef,
      supporting_source_refs: ["ev_0000000000000000"],
    }],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
assert.equal(validateDeepAnalysisResult({
  seal,
  result: unresolvedSupportingReferenceResult,
}).valid, false);

const structuredEvidenceText = JSON.stringify({
  title: "서울 소재 기업 지원",
  condition: "본사 또는 공장이 하남시에 소재해야 한다.\n공장 소재 시 우대한다.",
});
const structuredCatalog = createDeepAnalysisAuditEvidenceCatalog(structuredEvidenceText);
const structuredRef = structuredCatalog.promptText
  .split("\n")
  .find((line) => line.includes("하남시에 소재"))?.match(/\[(ev_[0-9a-f]{16})\]/)?.[1];
assert.ok(structuredRef);
const structuredTextOnly = normalizeDeepAnalysisAuditCandidateResult({
  model: "claude-haiku-4-5-20251001",
  effort: null,
  evidenceText: structuredEvidenceText,
  rawToolInput: {
    criteria: [{
      dimension: "premises",
      operator: "text_only",
      kind: "required",
      value: { note: "모델이 재작성한 문장" },
      confidence: 0.9,
      primary_source_ref: structuredRef,
    }],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
assert.match(
  String((structuredTextOnly.criteria[0]?.value as Record<string, unknown>).note),
  /하남시에 소재/,
);
assert.equal(
  structuredEvidenceText.includes(structuredTextOnly.criteria[0]?.sourceSpan ?? ""),
  true,
);

const typedContractEvidence = [
  "재무제표 상, 부채비율이 마이너스(자본잠식)인 업체",
  "전국 지역센터에 기 입주경력이 있는 자 등",
  "해당연도 중앙부처 및 지자체 동일분야 자금 기 수혜기업",
  "중앙부처 및 시 정책자금 최근 5년간 100억 원 이상 지원받은 업체",
].join("\n");
const typedContractSeal = sealDeepAnalysisInput({
  grantId: "audit-typed-contract",
  sourceRevisionSha256: "e".repeat(64),
  structuredText: typedContractEvidence,
  attachments: [],
});
const typedContractCatalog = createDeepAnalysisAuditEvidenceCatalog(typedContractEvidence);
const typedContractRef = (needle: string) => typedContractCatalog.promptText
  .split("\n")
  .find((line) => line.includes(needle))
  ?.match(/\[(ev_[0-9a-f]{16})\]/)?.[1];
const impairmentRef = typedContractRef("자본잠식");
const incubationRef = typedContractRef("입주경력");
const sameYearRef = typedContractRef("해당연도");
const monetaryThresholdRef = typedContractRef("100억 원");
assert.ok(impairmentRef);
assert.ok(incubationRef);
assert.ok(sameYearRef);
assert.ok(monetaryThresholdRef);
const typedContractResult = normalizeDeepAnalysisAuditCandidateResult({
  model: "claude-haiku-4-5-20251001",
  effort: null,
  evidenceText: typedContractEvidence,
  rawToolInput: {
    criteria: [
      {
        dimension: "financial_health",
        operator: "in",
        kind: "exclusion",
        value: { impairment_excluded: "full" },
        confidence: 0.9,
        primary_source_ref: impairmentRef,
      },
      {
        dimension: "prior_award",
        operator: "in",
        kind: "exclusion",
        value: {
          program_names: ["센터입주"],
          states: ["completed"],
        },
        confidence: 0.9,
        primary_source_ref: incubationRef,
      },
      {
        dimension: "prior_award",
        operator: "in",
        kind: "exclusion",
        value: { states: ["completed"] },
        confidence: 0.9,
        primary_source_ref: sameYearRef,
      },
      {
        dimension: "prior_award",
        operator: "in",
        kind: "exclusion",
        value: { states: ["completed"] },
        confidence: 0.9,
        primary_source_ref: monetaryThresholdRef,
      },
    ],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
assert.equal(validateDeepAnalysisResult({
  seal: typedContractSeal,
  result: typedContractResult,
}).valid, true);
assert.deepEqual(
  typedContractResult.rawToolInput.audit_contract_repairs,
  [
    { index: 0, code: "financial_health_impairment_scalar_to_array" },
    { index: 1, code: "prior_award_incubation_tenancy_scope" },
    { index: 2, code: "prior_award_same_year_other_support_scope" },
    { index: 3, code: "prior_award_unsupported_monetary_threshold_to_text_only" },
  ],
);
const repairedTypedCriteria =
  typedContractResult.rawToolInput.criteria as Array<Record<string, unknown>>;
assert.deepEqual(repairedTypedCriteria[0]?.value, { impairment_excluded: ["full"] });
assert.deepEqual(repairedTypedCriteria[1]?.value, {
  states: ["completed"],
  scope: "self",
  channel: "incubation_tenancy",
});
assert.deepEqual(repairedTypedCriteria[2]?.value, {
  states: ["completed"],
  scope: "self",
  self_kind: "same_year_other_support",
  channel: "general",
});
assert.equal(repairedTypedCriteria[3]?.dimension, "other");
assert.equal(repairedTypedCriteria[3]?.operator, "text_only");
assert.deepEqual(repairedTypedCriteria[3]?.value, {
  note: typedContractEvidence.split("\n")[3],
});
const authoredTypedCriteria =
  typedContractResult.rawToolInput.audit_authored_criteria as Array<Record<string, unknown>>;
assert.deepEqual(authoredTypedCriteria[0]?.value, { impairment_excluded: "full" });
assert.equal(
  (authoredTypedCriteria[1]?.value as Record<string, unknown>).scope,
  undefined,
);

const freshScopedPriorAwardRepairs = repairDeepAnalysisAuditCriteriaContract([
  {
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    source_span: "- 전국 지역센터에 기 입주경력이 있는 자 등",
    value: {
      scope: "self",
      self_kind: "same_program",
      states: ["completed", "participating"],
    },
  },
  {
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    source_span:
      "마. 동일기업 중복지원 제한 : 해당연도 중앙부처 및 지자체 동일분야 자금 기 수혜기업",
    value: {
      scope: "self",
      states: ["completed"],
    },
  },
]);
assert.deepEqual(freshScopedPriorAwardRepairs.repairs, [
  { index: 0, code: "prior_award_incubation_tenancy_scope" },
  { index: 1, code: "prior_award_same_year_other_support_scope" },
]);
assert.deepEqual(
  (freshScopedPriorAwardRepairs.criteria[0] as Record<string, unknown>).value,
  {
    scope: "self",
    states: ["completed", "participating"],
    channel: "incubation_tenancy",
  },
);
assert.deepEqual(
  (freshScopedPriorAwardRepairs.criteria[1] as Record<string, unknown>).value,
  {
    scope: "self",
    states: ["completed"],
    self_kind: "same_year_other_support",
    channel: "general",
  },
);

const alreadyValidAndAmbiguousScopedPriorAwards = [
  {
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    source_span: "전국 지역센터에 기 입주경력이 있는 자 등",
    value: {
      scope: "self",
      channel: "incubation_tenancy",
      states: ["completed"],
    },
  },
  {
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    source_span: "해당연도 다른 중앙부처 지원과 중복 수혜한 기업",
    value: {
      scope: "self",
      self_kind: "same_year_other_support",
      channel: "general",
      states: ["completed"],
    },
  },
  {
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    source_span: "과거 정부지원사업 수혜기업은 신청할 수 없음",
    value: {
      scope: "self",
      states: ["completed"],
    },
  },
  {
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    source_span: "전국 지역센터에 기 입주경력이 있는 자 등",
    value: {
      scope: "program",
      programs: ["지역센터"],
      states: ["completed"],
    },
  },
];
const untouchedScopedPriorAwards = repairDeepAnalysisAuditCriteriaContract(
  alreadyValidAndAmbiguousScopedPriorAwards,
);
assert.deepEqual(untouchedScopedPriorAwards.repairs, []);
assert.deepEqual(
  untouchedScopedPriorAwards.criteria,
  alreadyValidAndAmbiguousScopedPriorAwards,
);

const ambiguousPriorAwardEvidence = "과거 정부지원사업 수혜기업은 신청할 수 없음";
const ambiguousPriorAwardSeal = sealDeepAnalysisInput({
  grantId: "audit-ambiguous-prior-award",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: ambiguousPriorAwardEvidence,
  attachments: [],
});
const ambiguousPriorAwardCatalog =
  createDeepAnalysisAuditEvidenceCatalog(ambiguousPriorAwardEvidence);
const ambiguousPriorAwardRef =
  /\[(ev_[0-9a-f]{16})\]/.exec(ambiguousPriorAwardCatalog.promptText)?.[1];
assert.ok(ambiguousPriorAwardRef);
const ambiguousPriorAwardResult = normalizeDeepAnalysisAuditCandidateResult({
  model: "claude-haiku-4-5-20251001",
  effort: null,
  evidenceText: ambiguousPriorAwardEvidence,
  rawToolInput: {
    criteria: [{
      dimension: "prior_award",
      operator: "in",
      kind: "exclusion",
      value: { states: ["completed"] },
      confidence: 0.9,
      primary_source_ref: ambiguousPriorAwardRef,
    }],
  },
  rawResponseText: "{}",
  stopReason: "tool_use",
  usage: null,
});
const ambiguousPriorAwardValidation = validateDeepAnalysisResult({
  seal: ambiguousPriorAwardSeal,
  result: ambiguousPriorAwardResult,
});
assert.equal(ambiguousPriorAwardValidation.valid, false);
assert.deepEqual(
  ambiguousPriorAwardResult.rawToolInput.audit_contract_repairs,
  [],
);
assert.equal(
  ambiguousPriorAwardValidation.issues.some((issue) => (
    issue.code === "canonical_contract_invalid"
    && issue.path.includes(".value.scope")
  )),
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
            primary_source_ref: sourceRef,
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
const capturedMessages = capturedAuditRequest.messages as Array<{
  content: string;
}>;
assert.match(capturedMessages[0]?.content ?? "", new RegExp(`\\[${sourceRef}\\]`));
assert.doesNotMatch(capturedMessages[0]?.content ?? "", /DEEP_ANALYSIS_SOURCE/);
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
  audit: same,
});
assert.equal(concurrence.verdict, "concur");
assert.equal(concurrence.itemResults.every((item) => item.verdict === "concur"), true);
assert.equal(concurrence.itemResults.some((item) => item.kind === "axis"), false);

const differentResult = makeResult([region("26")]);
const different = validateDeepAnalysisResult({ seal, result: differentResult });
const disagreement = compareDeepAnalysisValidations({
  primary,
  audit: different,
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
  audit: empty,
});
assert.equal(missed.verdict, "disagree");
assert.equal(
  missed.itemResults.some((item) => (
    item.kind === "criterion"
    && item.dimension === "region"
    && item.verdict === "disagree"
  )),
  true,
);

const preferredSpan = "벤처기업 인증 보유 시 2점 가점";
const preferredSeal = sealDeepAnalysisInput({
  grantId: "audit-preferred-scope",
  sourceRevisionSha256: "f".repeat(64),
  structuredText: `${span}\n${preferredSpan}`,
  attachments: [],
});
const preferredCriterion: DeepAnalysisCriterion = {
  dimension: "certification",
  operator: "text_only",
  kind: "preferred",
  value: { note: preferredSpan },
  confidence: 0.9,
  sourceSpan: preferredSpan,
  spanVerified: true,
  note: null,
};
const primaryWithPreferredResult = makeResult([region(), preferredCriterion]);
const primaryWithPreferred = validateDeepAnalysisResult({
  seal: preferredSeal,
  result: primaryWithPreferredResult,
});
const hardOnlyAuditResult = makeResult([region()]);
const hardOnlyAudit = validateDeepAnalysisResult({
  seal: preferredSeal,
  result: hardOnlyAuditResult,
});
const preferredIgnored = compareDeepAnalysisValidations({
  primary: primaryWithPreferred,
  audit: hardOnlyAudit,
});
assert.equal(preferredIgnored.verdict, "concur");
assert.equal(preferredIgnored.itemResults.length, 1);
const scopedPreferred = assessDeepAnalysisMatchImpactingAuditScope({
  primary: primaryWithPreferred,
  audit: hardOnlyAudit,
});
assert.deepEqual(scopedPreferred.ignoredPreferred, {
  primaryCount: 1,
  auditCount: 0,
});
assert.equal(scopedPreferred.claimReviews[0]?.verdict, "supported");
assert.equal(scopedPreferred.claimReviews[0]?.evidenceRefs.length, 1);
assert.deepEqual(scopedPreferred.missingCandidates, []);

const outOfScopeAuditResult = makeResult([preferredCriterion]);
const outOfScopeAudit = validateDeepAnalysisAuditResult({
  seal: preferredSeal,
  result: outOfScopeAuditResult,
});
assert.equal(outOfScopeAudit.valid, false);
assert.equal(outOfScopeAudit.responseContractValid, false);
assert.equal(
  outOfScopeAudit.issues.some((issue) => (
    issue.code === "raw_contract_invalid"
    && issue.path === "$.criteria[0].kind"
  )),
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
