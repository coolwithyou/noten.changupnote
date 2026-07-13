import assert from "node:assert/strict";
import {
  assessRulesetRefreshSafety,
  parseRulesetRefreshManifest,
  selectRulesetRefreshTargetCompanyIds,
  stableSha256,
} from "./rulesetMatchStateRefreshSafety";

const raw = {
  asOf: "2026-07-13T00:00:00.000Z",
  currentRulesetVer: "ruleset-v5",
  currentScoringVer: "scoring-v3",
  scopeHash: stableSha256(["company-a"]),
  evaluationInputHash: stableSha256({ profiles: ["p1"], grants: ["g1"] }),
  targetCompanyCount: 1,
  activeGrantCount: 1,
  existingStoredStateCount: 2,
  plannedStateCount: 1,
  missingActiveStateCount: 0,
  obsoleteStoredStateCount: 1,
  changedEligibilityCount: 1,
  rulesetOnlyUpdateCount: 0,
  transitions: { "conditional->ineligible": 1 },
  transitionReviewGrants: [{
    transition: "conditional->ineligible",
    source: "bizinfo",
    sourceId: "g1",
    title: "지역 제한 공고",
  }],
};
const manifest = parseRulesetRefreshManifest(raw);
assert.equal(assessRulesetRefreshSafety({
  expected: manifest,
  actual: manifest,
  reviewedGrantKeys: ["bizinfo:g1"],
  publishedGrantKeys: ["bizinfo:g1"],
  now: new Date("2026-07-13T00:10:00.000Z"),
}).writeReady, true);
assert.deepEqual(assessRulesetRefreshSafety({
  expected: manifest,
  actual: manifest,
  reviewedGrantKeys: [],
  publishedGrantKeys: [],
  now: new Date("2026-07-13T00:10:00.000Z"),
}), {
  manifestMatchesCurrentInputs: true,
  planFresh: true,
  missingReviewedGrantKeys: ["bizinfo:g1"],
  unpublishedReviewedGrantKeys: ["bizinfo:g1"],
  writeReady: false,
});
const drifted = parseRulesetRefreshManifest({ ...raw, evaluationInputHash: stableSha256("drift") });
assert.equal(assessRulesetRefreshSafety({
  expected: manifest,
  actual: drifted,
  reviewedGrantKeys: ["bizinfo:g1"],
  publishedGrantKeys: ["bizinfo:g1"],
  now: new Date("2026-07-13T00:10:00.000Z"),
}).writeReady, false);
assert.equal(assessRulesetRefreshSafety({
  expected: manifest,
  actual: manifest,
  reviewedGrantKeys: ["bizinfo:g1"],
  publishedGrantKeys: ["bizinfo:g1"],
  now: new Date("2026-07-13T00:31:00.000Z"),
}).planFresh, false);
assert.throws(() => parseRulesetRefreshManifest({ ...raw, transitionReviewGrants: undefined }), /complete/);
assert.deepEqual(selectRulesetRefreshTargetCompanyIds({
  companyIds: ["complete", "stale", "empty"],
  activeGrantIds: ["g1", "g2"],
  states: [
    { companyId: "complete", grantId: "g1", rulesetVer: "v5", scoringVer: "s3" },
    { companyId: "complete", grantId: "g2", rulesetVer: "v5", scoringVer: "s3" },
    { companyId: "stale", grantId: "g1", rulesetVer: "v4", scoringVer: "s2" },
    { companyId: "stale", grantId: "closed", rulesetVer: "v5", scoringVer: "s3" },
  ],
  rulesetVer: "v5",
  scoringVer: "s3",
}), ["empty", "stale"], "companies with no state must remain in the refresh target");

console.log("ruleset-match-state-refresh-safety: ok");
