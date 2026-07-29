import assert from "node:assert/strict";
import type { DeepAnalysisNormalizedOutput } from "./promotion";
import {
  DeepAnalysisPromotionReadinessError,
  assessDeepAnalysisPromotionReadiness,
  buildDeepAnalysisPromotionPlan,
  parseDeepAnalysisNormalizedOutput,
} from "./promotion";

const output: DeepAnalysisNormalizedOutput = {
  schema: "deep-analysis-normalized-output-v1",
  result: {
    model: "claude-opus-4-8",
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [{
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { regions: ["11"] },
      confidence: 0.95,
      sourceSpan: "서울 소재 기업",
      spanVerified: true,
      note: null,
    }],
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
};

assert.equal(parseDeepAnalysisNormalizedOutput(output), output);
assert.throws(
  () => parseDeepAnalysisNormalizedOutput({
    ...output,
    validation: { ...output.validation, valid: false },
  }),
  /S7~S9/,
);

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
  humanReviewRequired: false,
  terminalRoute: "auto_promotable",
  blockers: [],
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
    output: {
      ...output,
      result: {
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
      },
    },
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
    assert.equal(error.readiness.matcherRepresentable, "not_assessed");
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
  ...output,
  result: {
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
  },
};
assert.throws(
  () => buildDeepAnalysisPromotionPlan({
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
  }),
  (error: unknown) => {
    assert.ok(error instanceof DeepAnalysisPromotionReadinessError);
    assert.equal(error.readiness.analysisComplete, "passed");
    assert.equal(error.readiness.auditComplete, "passed");
    assert.equal(error.readiness.matcherRepresentable, "blocked");
    assert.equal(error.readiness.autoPromotable, "blocked");
    assert.equal(error.readiness.humanReviewRequired, true);
    assert.equal(error.readiness.terminalRoute, "human_review_required");
    assert.deepEqual(
      error.readiness.blockers.map((blocker) => [blocker.code, blocker.count]),
      [["conversion_downgraded", 1]],
    );
    return true;
  },
);

const auditNotConcur = assessDeepAnalysisPromotionReadiness({
  auditVerdict: "unsure",
});
assert.equal(auditNotConcur.auditComplete, "blocked");
assert.equal(auditNotConcur.matcherRepresentable, "not_assessed");

console.log("deep analysis promotion tests passed");
