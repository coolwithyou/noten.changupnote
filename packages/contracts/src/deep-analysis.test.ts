import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  DEEP_ANALYSIS_ACTIVE_POLICY_VERSION,
  DEEP_ANALYSIS_COST_QUALITY_EXPERIMENT_POLICY_VERSION,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  DEEP_ANALYSIS_STAGE_KEYS,
  assertDeepAnalysisModelEffort,
  assertDeepAnalysisModelPair,
  assertDeepAnalysisModelPolicy,
  deriveAggregateSplitExposureBlocker,
  deriveAggregateSplitPublicationBlocker,
  deriveDeepAnalysisCompletion,
  evaluateAggregateSplitReleaseGate,
  hasExactDeepAnalysisAxisCoverage,
  isGrantActiveForDeepAnalysis,
  supportsDeepAnalysisEffort,
  type AggregateSplitReleaseChildObservation,
} from "./index.js";

assert.equal(DEEP_ANALYSIS_ACTIVE_POLICY_VERSION, "deep-analysis-active-kst-v2");
assert.equal(
  DEEP_ANALYSIS_COST_QUALITY_EXPERIMENT_POLICY_VERSION,
  "deep-analysis-model-policy-cq2-v1",
);

assert.doesNotThrow(() => assertDeepAnalysisModelPair({
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
}));
assert.throws(() => assertDeepAnalysisModelPair({
  primaryModel: "unreviewed-model",
  auditModel: "claude-sonnet-5",
}), /not allowlisted/);
assert.doesNotThrow(() => assertDeepAnalysisModelPolicy({
  primaryModel: "claude-sonnet-5",
  auditModel: "claude-haiku-4-5-20251001",
  adjudicationModel: "claude-opus-5",
}));
assert.throws(() => assertDeepAnalysisModelPolicy({
  primaryModel: "claude-sonnet-5",
  auditModel: "claude-sonnet-5",
  adjudicationModel: "claude-opus-5",
}), /must be different/);
assert.throws(() => assertDeepAnalysisModelPolicy({
  primaryModel: "claude-sonnet-5",
  auditModel: "claude-haiku-4-5-20251001",
  adjudicationModel: "unreviewed-model",
}), /adjudication model is not allowlisted/);
assert.doesNotThrow(() => assertDeepAnalysisModelEffort({
  model: "claude-sonnet-5",
  effort: "high",
}));
assert.doesNotThrow(() => assertDeepAnalysisModelEffort({
  model: "claude-haiku-4-5-20251001",
  effort: null,
}));
assert.throws(() => assertDeepAnalysisModelEffort({
  model: "claude-haiku-4-5-20251001",
  effort: "high",
}), /does not support effort/);
assert.equal(supportsDeepAnalysisEffort("claude-opus-5"), true);
assert.equal(supportsDeepAnalysisEffort("unreviewed-model"), false);

const asOf = new Date("2026-07-25T03:00:00.000Z");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  servingState: "visible",
  applyStart: "2026-07-24T00:00:00.000Z",
  applyEnd: "2026-07-25T00:00:00.000Z",
}, asOf), true, "KST 오늘 마감은 활성이다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  servingState: "visible",
  applyStart: "2026-07-26T00:00:00.000Z",
  applyEnd: "2026-07-30T00:00:00.000Z",
}, asOf), false, "KST 시작 전 공고는 활성 딥분석 분모에서 제외한다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  servingState: "visible",
  applyStart: null,
  applyEnd: null,
}, asOf), false, "마감 미상 공고는 예외 큐다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "closed",
  servingState: "visible",
  applyStart: null,
  applyEnd: "2026-07-30T00:00:00.000Z",
}, asOf), false, "closed 상태는 날짜와 무관하게 제외한다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  servingState: "staged",
  applyStart: "2026-07-24T00:00:00.000Z",
  applyEnd: "2026-07-30T00:00:00.000Z",
}, asOf), false, "staged 파생 공고는 활성 딥분석 자동 분모에서 제외한다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  servingState: "suppressed",
  applyStart: "2026-07-24T00:00:00.000Z",
  applyEnd: "2026-07-30T00:00:00.000Z",
}, asOf), false, "전환 완료 parent는 활성 딥분석 자동 분모에서 제외한다");

assert.equal(
  hasExactDeepAnalysisAxisCoverage(
    CRITERION_DIMENSIONS.map((dimension) => ({ dimension })),
  ),
  true,
);
assert.equal(
  hasExactDeepAnalysisAxisCoverage(
    CRITERION_DIMENSIONS.slice(0, -1).map((dimension) => ({ dimension })),
  ),
  false,
);
assert.equal(
  hasExactDeepAnalysisAxisCoverage(
    CRITERION_DIMENSIONS.map((dimension, index) => ({
      dimension: index === CRITERION_DIMENSIONS.length - 1 ? CRITERION_DIMENSIONS[0] : dimension,
    })),
  ),
  false,
  "22행이어도 중복 축이 있으면 실패한다",
);

const complete = deriveDeepAnalysisCompletion(
  DEEP_ANALYSIS_STAGE_KEYS.map((stage) => ({ stage, status: "passed" as const })),
);
assert.deepEqual(complete, {
  analysisComplete: true,
  publicationComplete: true,
  servingComplete: true,
  fresh: true,
  firstBlockingStage: null,
});

const blocked = deriveDeepAnalysisCompletion([
  { stage: "source_fresh", status: "passed" },
  { stage: "attachment_inventory_complete", status: "blocked" },
]);
assert.equal(blocked.firstBlockingStage, "attachment_inventory_complete");
assert.equal(blocked.analysisComplete, false);

const readySplitChild = (
  childId: string,
  jobId: string,
  runId: string,
): AggregateSplitReleaseChildObservation => ({
  childId,
  childStatus: "prepared",
  sourceRevisionSha256: "a".repeat(64),
  inputSha256: "b".repeat(64),
  stagedGrantAt: "2026-07-26T01:00:00.000Z",
  servingState: "staged",
  expectedJobId: jobId,
  job: {
    id: jobId,
    grantId: childId,
    sourceRevisionSha256: "a".repeat(64),
    modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
    status: "succeeded",
  },
  latestRun: {
    id: runId,
    jobId,
    grantId: childId,
    sourceRevisionSha256: "a".repeat(64),
    inputSha256: "b".repeat(64),
    modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
    status: "passed",
  },
  stageStatuses: Object.fromEntries(
    DEEP_ANALYSIS_STAGE_KEYS.slice(0, 12).map((stage) => [stage, "passed"]),
  ),
  latestAudit: {
    inputSha256: "b".repeat(64),
    verdict: "concur",
  },
});
const splitChildren = [
  readySplitChild(
    "11111111-1111-4111-8111-111111111111",
    "21111111-1111-4111-8111-111111111111",
    "31111111-1111-4111-8111-111111111111",
  ),
  readySplitChild(
    "12222222-2222-4222-8222-222222222222",
    "22222222-2222-4222-8222-222222222222",
    "32222222-2222-4222-8222-222222222222",
  ),
];
const readySplitGate = evaluateAggregateSplitReleaseGate({
  status: "completed",
  materializationStatus: "prepared",
  promotionStatus: "enqueued",
  parentServingState: "visible",
  programCount: 2,
  preparedChildCount: 2,
  stagedChildCount: 2,
  enqueuedChildCount: 2,
  children: splitChildren,
});
assert.equal(readySplitGate.ready, true);
assert.deepEqual(
  readySplitGate.children.map((child) => child.runId),
  [
    "31111111-1111-4111-8111-111111111111",
    "32222222-2222-4222-8222-222222222222",
  ],
);

const stageBlockedGate = evaluateAggregateSplitReleaseGate({
  status: "completed",
  materializationStatus: "prepared",
  promotionStatus: "enqueued",
  parentServingState: "visible",
  programCount: 2,
  preparedChildCount: 2,
  stagedChildCount: 2,
  enqueuedChildCount: 2,
  children: [
    splitChildren[0]!,
    {
      ...splitChildren[1]!,
      stageStatuses: {
        ...splitChildren[1]!.stageStatuses,
        evidence_grounded: "failed",
      },
    },
  ],
});
assert.equal(stageBlockedGate.ready, false);
assert.equal(stageBlockedGate.firstBlocker?.stage, "evidence_grounded");
assert.equal(stageBlockedGate.children[0]?.ready, true);
assert.equal(stageBlockedGate.children[1]?.ready, false);

assert.equal(
  deriveAggregateSplitPublicationBlocker({
    ...splitChildren[0]!,
    promotionItemStatus: "applied",
    publicationReceiptStatus: "passed",
  }),
  null,
);
assert.equal(
  deriveAggregateSplitPublicationBlocker({
    ...splitChildren[0]!,
    promotionItemStatus: "prepared",
    publicationReceiptStatus: null,
  })?.code,
  "aggregate_split_child_promotion_not_applied",
);
assert.equal(
  deriveAggregateSplitExposureBlocker({
    ...splitChildren[0]!,
    promotionItemStatus: "applied",
    publicationReceiptStatus: "passed",
    servingReceiptStatus: null,
    freshnessReceiptStatus: null,
  })?.code,
  "aggregate_split_child_not_visible",
);
assert.equal(
  deriveAggregateSplitExposureBlocker({
    ...splitChildren[0]!,
    servingState: "visible",
    promotionItemStatus: "applied",
    publicationReceiptStatus: "passed",
    servingReceiptStatus: "passed",
    freshnessReceiptStatus: "passed",
  }),
  null,
);

console.log("deep analysis contract tests passed");
