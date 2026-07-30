import assert from "node:assert/strict";
import {
  assessDeepAnalysisMatcherRepresentability,
} from "./matcherRepresentability";
import type { DeepAnalysisNormalizedOutput } from "./promotion";
import {
  DeepAnalysisPromotionReadinessError,
  assessDeepAnalysisPromotionReadiness,
  buildDeepAnalysisPromotionPlan,
  parseDeepAnalysisNormalizedOutput,
} from "./promotion";

const directCriterion: DeepAnalysisNormalizedOutput["result"]["criteria"][number] = {
  dimension: "region",
  kind: "required",
  operator: "in",
  value: { regions: ["11"] },
  confidence: 0.95,
  sourceSpan: "서울 소재 기업",
  spanVerified: true,
  note: null,
};

const output: DeepAnalysisNormalizedOutput = {
  schema: "deep-analysis-normalized-output-v2",
  result: {
    model: "claude-opus-4-8",
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [directCriterion],
    axisAssessments: [{
      dimension: "region",
      status: "condition_found",
      confidence: 0.95,
      comment: null,
    }],
    taxonomyProposals: [],
    usage: null,
    costUsd: 0.2,
    stopReason: "end_turn",
  },
  validation: {
    valid: true,
    responseContractValid: true,
    axisCoverageComplete: true,
    evidenceGrounded: true,
  },
  matcherRepresentability: assessDeepAnalysisMatcherRepresentability([directCriterion]),
};

assert.equal(parseDeepAnalysisNormalizedOutput(output), output);
assert.throws(
  () => parseDeepAnalysisNormalizedOutput({
    ...output,
    schema: "deep-analysis-normalized-output-v1",
  }),
  /S7~S9/,
);
assert.throws(
  () => parseDeepAnalysisNormalizedOutput({
    ...output,
    matcherRepresentability: {
      ...output.matcherRepresentability,
      hardUnsupportedRelationCount: 1,
    },
  }),
  /S7~S9/,
);
assert.throws(
  () => parseDeepAnalysisNormalizedOutput({
    ...output,
    validation: { ...output.validation, valid: false },
  }),
  /S7~S9/,
);

function outputWithResult(
  result: DeepAnalysisNormalizedOutput["result"],
): DeepAnalysisNormalizedOutput {
  return {
    ...output,
    result,
    matcherRepresentability: assessDeepAnalysisMatcherRepresentability(result.criteria),
  };
}

const result = buildDeepAnalysisPromotionPlan({
  run: {
    runId: "da-test",
    grantId: "11111111-1111-4111-8111-111111111111",
    source: "bizinfo",
    sourceId: "PBLN_TEST",
    title: "테스트 공고",
    model: "claude-opus-4-8",
    promptVersion: "deep-analysis-v2",
    startedAt: new Date("2026-07-25T00:00:00Z"),
    completedAt: new Date("2026-07-25T00:01:00Z"),
    inputChars: 1000,
    inputSha256: "a".repeat(64),
    costUsd: 0.2,
  },
  output,
  currentCriteria: [],
  audit: {
    model: "claude-sonnet-5",
    promptVersion: "deep-analysis-blind-audit-v2",
    completedAt: new Date("2026-07-25T00:01:00Z"),
    verdict: "concur",
  },
});
assert.equal(result.plan.criteria.length, 1);
assert.equal(result.plan.criteria[0]?.needs_review, false);
assert.equal(result.plan.resolutions[0]?.state, "confirmed_correct");
assert.equal(result.plan.auditState, "ai_audit_concur");
assert.deepEqual(result.readiness, {
  schema: "deep-analysis-promotion-readiness-v1",
  analysisComplete: "passed",
  auditComplete: "passed",
  matcherRepresentable: "passed",
  autoPromotable: "passed",
  conditionalPromotable: "blocked",
  humanReviewRequired: false,
  terminalRoute: "auto_promotable",
  deferredCriterionIndexes: [],
  blockers: [],
  deferrals: [],
});

assert.throws(
  () => buildDeepAnalysisPromotionPlan({
    run: {
      runId: "da-conflict",
      grantId: "22222222-2222-4222-8222-222222222222",
      source: "kstartup",
      sourceId: "178511",
      title: "상충 조건 공고",
      model: "claude-opus-4-8",
      promptVersion: "deep-analysis-v9",
      startedAt: new Date("2026-07-25T00:00:00Z"),
      completedAt: new Date("2026-07-25T00:01:00Z"),
      inputChars: 1000,
      inputSha256: "b".repeat(64),
      costUsd: 0.2,
    },
    output: outputWithResult({
      ...output.result,
      criteria: [
          {
            dimension: "target_type",
            kind: "required",
            operator: "in",
            value: { targets: ["대학생", "대학원생"] },
            confidence: 0.95,
            sourceSpan: "전국 대학(원)생",
            spanVerified: true,
            note: null,
          },
          {
            dimension: "target_type",
            kind: "exclusion",
            operator: "not_in",
            value: { targets: ["대학생", "대학원생"] },
            confidence: 0.95,
            sourceSpan: "신청대상 제외한 모든 대상",
            spanVerified: true,
            note: null,
          },
      ],
    }),
    currentCriteria: [],
    audit: {
      model: "claude-sonnet-5",
      promptVersion: "deep-analysis-blind-audit-v10",
      completedAt: new Date("2026-07-25T00:01:00Z"),
      verdict: "concur",
    },
  }),
  (error: unknown) => {
    assert.ok(error instanceof DeepAnalysisPromotionReadinessError);
    assert.equal(error.readiness.analysisComplete, "passed");
    assert.equal(error.readiness.auditComplete, "passed");
    assert.equal(error.readiness.matcherRepresentable, "blocked");
    assert.equal(error.readiness.terminalRoute, "human_review_required");
    assert.deepEqual(
      error.readiness.blockers.map((blocker) => blocker.code),
      ["required_exclusion_conflict"],
    );
    assert.match(error.message, /required\/exclusion/);
    return true;
  },
);

assert.throws(
  () => buildDeepAnalysisPromotionPlan({
    run: {
      runId: "da-test",
      grantId: "11111111-1111-4111-8111-111111111111",
      source: "bizinfo",
      sourceId: "PBLN_TEST",
      title: "테스트 공고",
      model: "claude-opus-4-8",
      promptVersion: "deep-analysis-v2",
      startedAt: new Date(),
      completedAt: new Date(),
      inputChars: 1000,
      inputSha256: "a".repeat(64),
      costUsd: 0.2,
    },
    output,
    currentCriteria: [],
    audit: {
      model: "claude-sonnet-5",
      promptVersion: "deep-analysis-blind-audit-v2",
      completedAt: new Date(),
      verdict: "disagree",
    },
  }),
  (error: unknown) => {
    assert.ok(error instanceof DeepAnalysisPromotionReadinessError);
    assert.equal(error.readiness.analysisComplete, "passed");
    assert.equal(error.readiness.auditComplete, "blocked");
    assert.equal(error.readiness.matcherRepresentable, "passed");
    assert.equal(error.readiness.autoPromotable, "blocked");
    assert.equal(error.readiness.terminalRoute, "human_review_required");
    assert.deepEqual(
      error.readiness.blockers.map((blocker) => blocker.code),
      ["audit_not_concur"],
    );
    assert.match(error.message, /concur/);
    return true;
  },
);

const premisesOutput: DeepAnalysisNormalizedOutput = {
  ...outputWithResult({
    ...output.result,
    criteria: [{
      dimension: "premises",
      kind: "required",
      operator: "text_only",
      value: { note: "사업기간 종료일까지 영광군 내로 입주" },
      confidence: 0.9,
      sourceSpan: "사업기간 종료일까지 영광군 내로 입주를 완료하여야 함",
      spanVerified: true,
      note: null,
    }],
    axisAssessments: [{
      dimension: "premises",
      status: "condition_found",
      confidence: 0.9,
      comment: null,
    }],
  }),
};
const premisesResult = buildDeepAnalysisPromotionPlan({
    run: {
      runId: "da-premises",
      grantId: "33333333-3333-4333-8333-333333333333",
      source: "bizinfo",
      sourceId: "PBLN_PREMISES",
      title: "이전 확약 공고",
      model: "claude-opus-4-8",
      promptVersion: "deep-analysis-v11",
      startedAt: new Date("2026-07-29T00:00:00Z"),
      completedAt: new Date("2026-07-29T00:01:00Z"),
      inputChars: 1000,
      inputSha256: "c".repeat(64),
      costUsd: 0.2,
    },
    output: premisesOutput,
    currentCriteria: [],
    audit: {
      model: "claude-sonnet-5",
      promptVersion: "deep-analysis-blind-audit-v15",
      completedAt: new Date("2026-07-29T00:01:00Z"),
      verdict: "concur",
    },
});
assert.equal(
  premisesOutput.matcherRepresentability.items[0]?.status,
  "conditional_only",
);
assert.equal(premisesResult.plan.criteria[0]?.needs_review, true);
assert.equal(premisesResult.readiness.matcherRepresentable, "passed");
assert.equal(premisesResult.readiness.terminalRoute, "auto_promotable");

const aq8Output = outputWithResult({
  ...output.result,
  criteria: [
    {
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { regions: ["46"] },
      confidence: 0.95,
      sourceSpan: "공고일 기준 전남지역에서 6개월 이상 사업 영위 중인 기업",
      spanVerified: true,
      note: null,
    },
    {
      dimension: "premises",
      kind: "required",
      operator: "text_only",
      value: { note: "사업 종료일까지 영광군 내 입주 확약" },
      confidence: 0.95,
      sourceSpan: "전남 이외 지역 참여 기업은 사업 종료일까지 영광군 내 입주 확약",
      spanVerified: true,
      note: null,
    },
  ],
  axisAssessments: [
    {
      dimension: "region",
      status: "condition_found",
      confidence: 0.95,
      comment: null,
    },
    {
      dimension: "premises",
      status: "condition_found",
      confidence: 0.95,
      comment: null,
    },
  ],
});
assert.deepEqual(
  aq8Output.matcherRepresentability.items.map((item) => [item.status, item.reasonCode]),
  [
    ["unsupported_relation", "future_premises_alternative"],
    ["unsupported_relation", "future_premises_alternative"],
  ],
);
const aq8Result = buildDeepAnalysisPromotionPlan({
    run: {
      runId: "da-aq8",
      grantId: "44444444-4444-4444-8444-444444444444",
      source: "bizinfo",
      sourceId: "PBLN_AQ8",
      title: "지역 또는 이전 확약 공고",
      model: "claude-opus-4-8",
      promptVersion: "deep-analysis-v11",
      startedAt: new Date("2026-07-29T00:00:00Z"),
      completedAt: new Date("2026-07-29T00:01:00Z"),
      inputChars: 1000,
      inputSha256: "d".repeat(64),
      costUsd: 0.2,
    },
    output: aq8Output,
    currentCriteria: [],
    audit: {
      model: "claude-sonnet-5",
      promptVersion: "deep-analysis-blind-audit-v16",
      completedAt: new Date("2026-07-29T00:01:00Z"),
      verdict: "concur",
    },
});
assert.equal(aq8Result.readiness.analysisComplete, "passed");
assert.equal(aq8Result.readiness.auditComplete, "passed");
assert.equal(aq8Result.readiness.matcherRepresentable, "not_assessed");
assert.equal(aq8Result.readiness.autoPromotable, "blocked");
assert.equal(aq8Result.readiness.conditionalPromotable, "passed");
assert.equal(aq8Result.readiness.terminalRoute, "conditional_promotable");
assert.deepEqual(aq8Result.readiness.deferredCriterionIndexes, [0, 1]);
assert.deepEqual(
  aq8Result.readiness.deferrals?.map((deferral) => [deferral.code, deferral.count]),
  [["matcher_confirmation_required", 2]],
);
assert.deepEqual(
  aq8Result.plan.criteria.map((criterion) => criterion.needs_review),
  [true, true],
);
assert.deepEqual(
  aq8Result.plan.resolutions.map((resolution) => resolution.state),
  ["pending", "pending"],
);

const r6CrossDimensionOutput = outputWithResult({
  ...output.result,
  criteria: [
    {
      dimension: "region",
      kind: "required",
      operator: "text_only",
      value: { note: "화성시 관내 기업" },
      confidence: 0.95,
      sourceSpan: "화성시 관내 제조업 기업(뿌리기술 또는 관련 사업 분야)",
      spanVerified: true,
      note: null,
    },
    {
      dimension: "industry",
      kind: "required",
      operator: "text_only",
      value: { note: "제조업 또는 관련 사업 분야" },
      confidence: 0.95,
      sourceSpan: "화성시 관내 제조업 기업(뿌리기술 또는 관련 사업 분야)",
      spanVerified: true,
      note: null,
    },
  ],
  axisAssessments: [
    {
      dimension: "region",
      status: "condition_found",
      confidence: 0.95,
      comment: null,
    },
    {
      dimension: "industry",
      status: "condition_found",
      confidence: 0.95,
      comment: null,
    },
  ],
});
const r6CrossDimensionResult = buildDeepAnalysisPromotionPlan({
  run: {
    runId: "da-r6-cross-dimension",
    grantId: "55555555-5555-4555-8555-555555555555",
    source: "kstartup",
    sourceId: "178613",
    title: "[화성] 2026 ESG 기반 산업안전 컨설팅 참여기업 모집 안내",
    model: "claude-opus-4-8",
    promptVersion: "deep-analysis-v11",
    startedAt: new Date("2026-07-30T03:39:42Z"),
    completedAt: new Date("2026-07-30T03:41:42Z"),
    inputChars: 4118,
    inputSha256: "e".repeat(64),
    costUsd: 0.430175,
  },
  output: r6CrossDimensionOutput,
  currentCriteria: [],
  audit: {
    model: "claude-sonnet-5",
    promptVersion: "deep-analysis-blind-audit-v16",
    completedAt: new Date("2026-07-30T03:41:42Z"),
    verdict: "concur",
  },
});
assert.equal(r6CrossDimensionResult.readiness.terminalRoute, "conditional_promotable");
assert.deepEqual(
  r6CrossDimensionResult.plan.criteria.map((criterion) => criterion.needs_review),
  [true, true],
);

const r6InvalidAuditResult = buildDeepAnalysisPromotionPlan({
  run: {
    runId: "da-r6-invalid-audit",
    grantId: "66666666-6666-4666-8666-666666666666",
    source: "bizinfo",
    sourceId: "PBLN_000000000124138",
    title: "2026년 충북청주 강소특구 X 심텍 AI 제조혁신 오픈이노베이션 지원사업 모집 공고",
    model: "claude-opus-4-8",
    promptVersion: "deep-analysis-v11",
    startedAt: new Date("2026-07-30T03:42:38Z"),
    completedAt: new Date("2026-07-30T03:46:08Z"),
    inputChars: 19539,
    inputSha256: "f".repeat(64),
    costUsd: 1.020665,
  },
  output,
  currentCriteria: [],
  audit: {
    model: "claude-sonnet-5",
    promptVersion: "deep-analysis-blind-audit-v16",
    completedAt: new Date("2026-07-30T03:46:08Z"),
    verdict: "unsure",
  },
});
assert.equal(r6InvalidAuditResult.readiness.terminalRoute, "conditional_promotable");
assert.deepEqual(r6InvalidAuditResult.readiness.deferredCriterionIndexes, [0]);
assert.equal(r6InvalidAuditResult.plan.criteria[0]?.needs_review, true);
assert.equal(r6InvalidAuditResult.plan.resolutions[0]?.state, "pending");

const postSelectionAssessment = assessDeepAnalysisMatcherRepresentability([{
  dimension: "sanction",
  kind: "exclusion",
  operator: "in",
  value: { flags: ["agreement_breach"] },
  confidence: 0.9,
  sourceSpan: "협약 체결 이후 명시사항을 2회 위반하면 지원 취소",
  spanVerified: true,
  note: null,
}]);
assert.deepEqual(
  postSelectionAssessment.items.map((item) => [item.status, item.reasonCode]),
  [["unsupported_relation", "post_selection_timing"]],
);
const postSelectionReadiness = assessDeepAnalysisPromotionReadiness({
  auditVerdict: "concur",
  matcherRepresentability: postSelectionAssessment,
});
assert.equal(postSelectionReadiness.terminalRoute, "human_review_required");
assert.deepEqual(
  postSelectionReadiness.blockers.map((blocker) => blocker.code),
  ["unsupported_relation"],
);

const canonicalExceptionAssessment = assessDeepAnalysisMatcherRepresentability([{
  dimension: "sanction",
  kind: "exclusion",
  operator: "in",
  value: {
    flags: ["agreement_breach"],
    exceptions: [{ kind: "approved_exception" }],
  },
  confidence: 0.9,
  sourceSpan: "협약 위반 제재 대상. 다만 승인된 예외는 신청 가능",
  spanVerified: true,
  note: null,
}]);
assert.deepEqual(
  canonicalExceptionAssessment.items.map((item) => [item.status, item.reasonCode]),
  [["direct", "profile_resolvable"]],
);

const auditNotConcur = assessDeepAnalysisPromotionReadiness({
  auditVerdict: "unsure",
});
assert.equal(auditNotConcur.auditComplete, "not_assessed");
assert.equal(auditNotConcur.matcherRepresentable, "not_assessed");
assert.equal(auditNotConcur.terminalRoute, "conditional_promotable");
assert.equal(auditNotConcur.humanReviewRequired, false);
assert.equal(auditNotConcur.conditionalPromotable, "passed");
assert.deepEqual(
  auditNotConcur.deferrals?.map((deferral) => deferral.code),
  ["audit_uncertain"],
);

console.log("deep analysis promotion tests passed");
