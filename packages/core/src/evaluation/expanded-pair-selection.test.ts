import assert from "node:assert/strict";
import type { MatchingV3PairReviewTask } from "./pair-review-packet.js";
import { selectExpandedPairReviewCandidates } from "./expanded-pair-selection.js";

const tasks = Array.from({ length: 20 }, (_, grant) => Array.from({ length: 10 }, (_, company) => task(grant, company))).flat();
const selection = selectExpandedPairReviewCandidates({ tasks, targetCount: 100 });
assert.equal(selection.tasks.length, 100);
assert.equal(selection.grantCoverage, 20);
assert.equal(selection.companyCoverage, 10);
assert.equal(new Set(selection.tasks.map((item) => item.pairId)).size, 100);
assert.throws(() => selectExpandedPairReviewCandidates({ tasks, targetCount: 201 }), /targetCount/);
console.log("expanded-pair-selection.test.ts: all assertions passed");

function task(grant: number, company: number): MatchingV3PairReviewTask {
  const source = grant % 2 === 0 ? "kstartup" : "bizinfo";
  const businessKind = company % 2 === 0 ? "individual" : "corporation";
  const predictedEligibility = (["eligible", "conditional", "ineligible"] as const)[(grant + company) % 3]!;
  const pairId = `${source}:g${grant}::c${company}`;
  return {
    recordType: "eligibility_pair_review_task", schemaVersion: "matching-v3-pair-review-task-v1",
    pairId, grantId: `${source}:g${grant}`, companyId: `c${company}`, businessKind,
    grantSourceRevision: "r", rulesetVer: "ruleset-test", scoringVer: "scoring-test",
    inputFingerprint: "a".repeat(64), predictedEligibility, predictedTrace: [], profileDimensionsPresent: [],
    annotationTemplate: {
      recordType: "eligibility_pair", schemaVersion: "matching-v3", pairId, grantId: `${source}:g${grant}`,
      companyId: `c${company}`, expectedEligibility: predictedEligibility, split: "development",
      hardFailCriterionIds: [], unknownCriterionIds: [], resolvableByProfileInput: null,
      note: "ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW", labelStatus: "draft",
      rulesetVer: "ruleset-test", scoringVer: "scoring-test", inputFingerprint: "a".repeat(64),
    },
  };
}
