import assert from "node:assert/strict";
import type { GrantPromotionPlan } from "./promote";
import {
  evaluatePromotionAggregateEvidence,
  type PromotionAggregateGateId,
} from "./promotion-gate-evidence";
import {
  PromotionSourceUnavailableError,
  verifyPromotionReleaseSources,
} from "./promotion-candidates";
import { planSha256, type PromotionReleasePlanItem } from "./promotion-release";

const grantId = "00000000-0000-4000-8000-000000000021";
const criterion = {
  id: "deep-repair:test:criterion-1",
  grant_id: grantId,
  dimension: "region" as const,
  kind: "required" as const,
  operator: "in" as const,
  value: { values: ["서울"] },
  confidence: 0.95,
  needs_review: false,
  source_field: "analysis_lab_deep",
  source_span: "서울 소재 기업",
  parser_version: "analysis-lab-shadow-v2",
};
const textCriterion = {
  ...criterion,
  id: "deep-repair:test:criterion-2",
  dimension: "other" as const,
  operator: "text_only" as const,
  value: { note: "추가 신청 조건" },
  source_span: "추가 신청 조건",
};
const deepRepairPlan: GrantPromotionPlan = {
  grantId,
  runId: "run-2026-08-17T000000.000Z-evidence",
  title: "receipt evidence test",
  origin: "deep_repair",
  auditState: "deep_repair_receipt",
  criteria: [criterion, textCriterion],
  criterionIndexByPosition: [0, 1],
  criterionStableKeys: ["stable-1", "stable-2"],
  resolutions: [
    { criterionIndex: 0, state: "deep_repair_receipt", decidedBy: null, note: null },
    { criterionIndex: 1, state: "deep_repair_receipt", decidedBy: null, note: null },
  ],
  conversion: {
    grantId,
    runId: "run-2026-08-17T000000.000Z-evidence",
    verdicts: { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 },
    missedConditions: 0,
    inputRows: 2,
    converted: 2,
    downgraded: 0,
    dropped: 0,
    error: null,
  },
  scopeRejectedCriterionIndexes: [],
  questions: [],
  droppedQuestionCandidates: 0,
};
const sealedItem: PromotionReleasePlanItem = {
  grantId,
  planSha256: planSha256(deepRepairPlan),
  promotionPlan: deepRepairPlan,
  deepRepairReadiness: {
    schema: "deep-repair-promotion-readiness-v1",
    disposition: "ready",
    reasons: [],
    unresolvedAxes: [],
    sourceRevisionSha256: "a".repeat(64),
    inputSha256: "b".repeat(64),
    attachmentManifestSha256: "c".repeat(64),
    receiptSha256: "d".repeat(64),
  },
  beforeCriteriaSha256: "e".repeat(64),
  beforeQuestionsSha256: "f".repeat(64),
  dedupComponentSha256: "1".repeat(64),
  criteriaCountBefore: 1,
  criteriaCountAfter: 2,
  questionCountAfter: 0,
  pendingCount: 0,
  downgradedCount: 0,
  transport: "claude-cli",
  costUsd: 99,
};
const thresholds = {
  strictPrecisionMin: 0.9,
  wrongRateMax: 0.1,
  missedPerNoticeMax: 1,
  coverageRatioMin: 1,
  costPerNoticeMaxUsd: 1,
  structuredRatioMin: 0.5,
};

function gate(
  result: ReturnType<typeof evaluatePromotionAggregateEvidence>,
  id: PromotionAggregateGateId,
) {
  return result.gates.find((item) => item.id === id)!;
}

{
  const result = evaluatePromotionAggregateEvidence({
    plans: [sealedItem],
    thresholds,
    apiCostGate: null,
  });
  assert.equal(result.mode, "sealed");
  assert.equal(result.publishedCriteriaCount, 2);
  assert.equal(result.reviewTotals.correct, 0, "receipt를 검수 correct로 가장하지 않는다");
  assert.deepEqual(gate(result, "strict_precision"), {
    id: "strict_precision",
    threshold: { operator: "gte", value: 0.9 },
    actual: null,
    pass: true,
    blocking: false,
    applicability: "not_applicable",
  });
  assert.equal(gate(result, "sealed_evidence_acceptance").actual, 1);
  assert.equal(gate(result, "sealed_evidence_acceptance").pass, true);
  assert.equal(gate(result, "sealed_evidence_acceptance").blocking, true);
  assert.equal(gate(result, "coverage_ratio").actual, 2);
  assert.equal(gate(result, "coverage_ratio").blocking, false);
  assert.equal(gate(result, "structured_ratio").actual, 0.5);
  assert.equal(gate(result, "cost_per_notice_usd").applicability, "not_applicable");
}

{
  const malformedPlan: GrantPromotionPlan = {
    ...deepRepairPlan,
    resolutions: [
      ...deepRepairPlan.resolutions.slice(0, 1),
      { criterionIndex: 1, state: "pending", decidedBy: null, note: null },
    ],
  };
  const result = evaluatePromotionAggregateEvidence({
    plans: [{ ...sealedItem, promotionPlan: malformedPlan }],
    thresholds,
    apiCostGate: null,
  });
  assert.equal(gate(result, "sealed_evidence_acceptance").actual, 0);
  assert.equal(gate(result, "sealed_evidence_acceptance").pass, false);
  assert.equal(gate(result, "sealed_evidence_acceptance").blocking, true);
}

{
  const reviewedPlan: GrantPromotionPlan = {
    ...deepRepairPlan,
    origin: "human",
    auditState: "human_reviewed",
    resolutions: [],
  };
  const { deepRepairReadiness: _deepRepairReadiness, ...reviewedItem } = sealedItem;
  const result = evaluatePromotionAggregateEvidence({
    plans: [{ ...reviewedItem, promotionPlan: reviewedPlan }],
    thresholds,
    apiCostGate: null,
  });
  assert.equal(result.mode, "reviewed");
  assert.equal(gate(result, "strict_precision").applicability, "applicable");
  assert.equal(gate(result, "strict_precision").pass, false);
  assert.equal(gate(result, "strict_precision").blocking, true);
  assert.equal(gate(result, "sealed_evidence_acceptance").applicability, "not_applicable");
}

const sourceArtifact = {
  grantId,
  runId: deepRepairPlan.runId,
  runSha256: "2".repeat(64),
  overlaySha256: null,
  confirmationsSha256: null,
};

assert.deepEqual(
  await verifyPromotionReleaseSources([sourceArtifact], {
    verifyOne: async () => ({ ok: false, changed: ["source_revision"] }),
  }),
  [`${grantId}:source_revision`],
  "실제 drift는 immutable gate가 기록할 수 있는 명시적 결과로 반환한다",
);

await assert.rejects(
  verifyPromotionReleaseSources([sourceArtifact], {
    verifyOne: async () => {
      throw new Error("temporary read failure");
    },
  }),
  (error: unknown) => error instanceof PromotionSourceUnavailableError
    && error.grantId === grantId
    && error.detail === "temporary read failure",
  "일시적 verifier 실패는 drift로 봉인하지 않고 artifact write 전에 중단한다",
);

await assert.rejects(
  verifyPromotionReleaseSources([sourceArtifact], {
    verifyOne: async () => ({ ok: false, changed: ["input_unavailable"] }),
  }),
  PromotionSourceUnavailableError,
  "기존 unavailable 코드도 typed failure로 승격한다",
);

console.log("promotion aggregate evidence tests: ok");
