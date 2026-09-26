import assert from "node:assert/strict";
import type { LabCriterion, LabRun } from "./lab-contract";
import {
  buildAnalysisLaunchMatchingProjectionBinding,
  buildPrimaryMatchingProjectionSnapshot,
  primaryProjectionSource,
} from "./primary-matching-projection";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import { resolveReviewedMatchingProjectionForPromotion } from "./matching-projection-review-carryforward";

function criterion(): LabCriterion {
  return {
    dimension: "industry",
    kind: "required",
    operator: "text_only",
    value: { note: "정보통신 분야 기업이어야 하나 특정 업종 코드가 없어 원문 조건으로 확인한다." },
    confidence: 0.91,
    sourceSpan: "정보통신 분야 중소기업",
    spanVerified: true,
    note: "특정 KSIC 코드는 제시되지 않았다.",
  };
}

const source = primaryProjectionSource({
  runId: "run-carryforward",
  grantId: "00000000-0000-4000-8000-0000000001d0",
  source: "bizinfo",
  sourceId: "carryforward-source",
  inputSha256: "1".repeat(64),
  attachmentManifestSha256: "2".repeat(64),
  criteria: [criterion()],
});
const current = buildPrimaryMatchingProjectionSnapshot({
  source,
  primaryExtractionAvailable: true,
});
assert.equal(current.verification, "verified");
assert.deepEqual(current.projectedCriteria[0]?.value, source.criteria[0]?.value);

function runWithHistorical(
  historical: LabRun["primaryMatchingProjection"],
): LabRun {
  return {
    runId: source.runId,
    grantId: source.grantId,
    source: source.source,
    sourceId: source.sourceId,
    inputSha256: source.inputSha256,
    attachmentManifestSha256: source.attachmentManifestSha256 ?? undefined,
    criteria: source.criteria,
    primaryMatchingProjection: historical,
  } as LabRun;
}

function reviewedInput(historical: NonNullable<LabRun["primaryMatchingProjection"]>) {
  const historicalBinding = buildAnalysisLaunchMatchingProjectionBinding(historical);
  return {
    run: runWithHistorical(historical),
    target: {
      grantId: source.grantId,
      primaryMatchingProjection: historicalBinding,
    },
    reviewedPacketBinding: {
      ...historicalBinding,
      provenance: "run_snapshot" as const,
    },
    reviewFindings: [],
  };
}

const lossyHistorical = structuredClone(current);
lossyHistorical.runtime.normalizerContractVersion = "grant-llm-criteria-normalization-v2";
(lossyHistorical.projectedCriteria[0] as { value: unknown }).value = { tags: [] };
lossyHistorical.projectedCriteriaSha256 = sha256Canonical(lossyHistorical.projectedCriteria);

const currentReviewed = resolveReviewedMatchingProjectionForPromotion(reviewedInput(current));
assert.equal(currentReviewed.carryforward, null, "현행 v4 projection은 같은 검수 결속을 그대로 사용한다");
assert.throws(
  () => resolveReviewedMatchingProjectionForPromotion(reviewedInput(lossyHistorical)),
  /허용되지 않은 matching projection runtime 전환/,
  "역사 v2 검수는 v4 결과로 자동 승계하지 않는다",
);

const runtimeOnlyHistorical = structuredClone(current);
runtimeOnlyHistorical.runtime.normalizerContractVersion = "grant-llm-criteria-normalization-v3";
assert.throws(
  () => resolveReviewedMatchingProjectionForPromotion(reviewedInput(runtimeOnlyHistorical)),
  /허용되지 않은 matching projection runtime 전환/,
  "역사 v3 검수도 v4 결과로 자동 승계하지 않는다",
);

assert.throws(
  () => resolveReviewedMatchingProjectionForPromotion({
    ...reviewedInput(lossyHistorical),
    reviewFindings: [{ kind: "criterion", key: 0 }],
  }),
  /허용되지 않은 matching projection runtime 전환/,
  "검수 finding이 있어도 역사 v2에서 v4로 승계하지 않는다",
);

const tamperedHistorical = structuredClone(lossyHistorical);
tamperedHistorical.projectedCriteria[0]!.kind = "preferred";
tamperedHistorical.projectedCriteriaSha256 = sha256Canonical(tamperedHistorical.projectedCriteria);
assert.throws(
  () => resolveReviewedMatchingProjectionForPromotion(reviewedInput(tamperedHistorical)),
  /승계할 수 없습니다|검수 범위를 벗어난/,
  "value 복원 외 projection 변경은 차단한다",
);

console.log("matching projection review carryforward tests: ok");
