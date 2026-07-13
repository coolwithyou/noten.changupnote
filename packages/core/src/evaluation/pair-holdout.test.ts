import assert from "node:assert/strict";
import { applyPairHoldoutManifest, buildMatchingV3PairHoldoutManifest } from "./pair-holdout.js";
import type { MatchingV3PairReviewTask } from "./pair-review-packet.js";

const tasks = [
  ...Array.from({ length: 10 }, (_, index) => task(`kstartup:g${index}::individual-${index}`, "kstartup", "individual")),
  ...Array.from({ length: 10 }, (_, index) => task(`bizinfo:g${index}::corp-${index}`, "bizinfo", "corporation")),
];
const manifest = buildMatchingV3PairHoldoutManifest({
  tasks,
  targetRatio: 0.3,
  createdAt: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(manifest.pairIds.length, 6);
assert.equal(manifest.strata["kstartup:individual"]?.holdout, 3);
assert.equal(manifest.strata["bizinfo:corporation"]?.holdout, 3);
const assigned = applyPairHoldoutManifest(tasks, manifest);
assert.equal(assigned.filter((item) => item.annotationTemplate.split === "holdout").length, 6);
assert.equal(assigned.filter((item) => item.annotationTemplate.split === "development").length, 14);
assert.throws(() => applyPairHoldoutManifest(tasks, { ...manifest, pairIds: ["missing"] }), /unknown holdout/);
console.log("pair-holdout.test.ts: all assertions passed");

function task(pairId: string, source: string, businessKind: "individual" | "corporation"): MatchingV3PairReviewTask {
  return {
    recordType: "eligibility_pair_review_task",
    schemaVersion: "matching-v3-pair-review-task-v1",
    pairId,
    grantId: `${source}:g`,
    companyId: pairId.split("::")[1]!,
    businessKind,
    grantSourceRevision: "r1",
    rulesetVer: "ruleset-test",
    scoringVer: "scoring-test",
    inputFingerprint: "a".repeat(64),
    predictedEligibility: "conditional",
    predictedTrace: [],
    profileDimensionsPresent: [],
    annotationTemplate: {
      recordType: "eligibility_pair",
      schemaVersion: "matching-v3",
      pairId,
      grantId: `${source}:g`,
      companyId: pairId.split("::")[1]!,
      expectedEligibility: "conditional",
      split: "development",
      hardFailCriterionIds: [],
      unknownCriterionIds: [],
      resolvableByProfileInput: null,
      note: "ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW",
      rulesetVer: "ruleset-test",
      scoringVer: "scoring-test",
      inputFingerprint: "a".repeat(64),
      labelStatus: "draft",
    },
  };
}
