import assert from "node:assert/strict";
import type { DeepAnalysisNormalizedOutput } from "./promotion";
import {
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
  /concur/,
);

console.log("deep analysis promotion tests passed");
