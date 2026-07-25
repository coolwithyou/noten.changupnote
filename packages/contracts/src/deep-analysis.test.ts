import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  DEEP_ANALYSIS_STAGE_KEYS,
  assertDeepAnalysisModelPair,
  deriveDeepAnalysisCompletion,
  hasExactDeepAnalysisAxisCoverage,
  isGrantActiveForDeepAnalysis,
} from "./index.js";

assert.doesNotThrow(() => assertDeepAnalysisModelPair({
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
}));
assert.throws(() => assertDeepAnalysisModelPair({
  primaryModel: "unreviewed-model",
  auditModel: "claude-sonnet-5",
}), /not allowlisted/);

const asOf = new Date("2026-07-25T03:00:00.000Z");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  applyStart: "2026-07-24T00:00:00.000Z",
  applyEnd: "2026-07-25T00:00:00.000Z",
}, asOf), true, "KST 오늘 마감은 활성이다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  applyStart: "2026-07-26T00:00:00.000Z",
  applyEnd: "2026-07-30T00:00:00.000Z",
}, asOf), false, "KST 시작 전 공고는 활성 딥분석 분모에서 제외한다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "open",
  applyStart: null,
  applyEnd: null,
}, asOf), false, "마감 미상 공고는 예외 큐다");

assert.equal(isGrantActiveForDeepAnalysis({
  status: "closed",
  applyStart: null,
  applyEnd: "2026-07-30T00:00:00.000Z",
}, asOf), false, "closed 상태는 날짜와 무관하게 제외한다");

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

console.log("deep analysis contract tests passed");
