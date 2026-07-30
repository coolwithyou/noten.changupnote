import assert from "node:assert/strict";
import type { CreditSystemRepository } from "@cunote/core";
import type { ProductTeaserResult } from "@cunote/contracts";
import {
  buildLandingMatchObservationContext,
  recordLandingMatchObservation,
} from "./landingMatchObservation";

const result = {
  matches: [{
    grantId: "11111111-1111-4111-8111-111111111111",
    eligibility: "conditional",
    bucket: "conditional",
    fitScore: 50,
    quality: {
      eligibilityConfidence: "medium",
      verificationCompleteness: 50,
      evidenceCoverage: 100,
      extractionReadiness: "ready",
    },
    ranking: {
      relevanceScore: 83,
      priorityScore: 71,
      reasons: [],
    },
    matchConfidence: 0.8,
    recommendationTier: "needs_profile_input",
    rulesetVer: "rules-v1",
    scoringVer: "score-v1",
  }],
  searchContext: {
    evaluatedGrantCount: 42,
  },
} as unknown as ProductTeaserResult;

const context = buildLandingMatchObservationContext(
  result,
  new Date("2026-07-31T00:00:00.000Z"),
);
assert.equal(context.evaluatedGrantCount, 42);
assert.equal(context.returnedGrantCount, 1);
assert.deepEqual(context.matches[0], {
  grantId: "11111111-1111-4111-8111-111111111111",
  rank: 1,
  eligibility: "conditional",
  bucket: "conditional",
  recommendationTier: "needs_profile_input",
  verificationCompleteness: 50,
  evidenceCoverage: 100,
  matchConfidence: 0.8,
  relevanceScore: 83,
  priorityScore: 71,
  rulesetVer: "rules-v1",
  scoringVer: "score-v1",
});
assert.equal("bizNo" in context, false);
assert.equal("profile" in context, false);

const recorded: Array<
  Parameters<CreditSystemRepository["recordFreeUsageEvent"]>[0]
> = [];
const creditsSystem = {
  recordFreeUsageEvent: async (input) => {
    recorded.push(input);
    return { id: "usage-1" };
  },
} as CreditSystemRepository;
const receipt = await recordLandingMatchObservation({
  creditsSystem,
  result,
  observedAt: new Date("2026-07-31T00:00:00.000Z"),
});
assert.equal(receipt.id, "usage-1");
assert.equal(recorded[0]?.featureCode, "landing_match_observation");
assert.equal(recorded[0]?.provider, "cunote_matcher");
assert.equal(recorded[0]?.contextRef?.schema, "landing-match-observation-v1");

console.log("landing match observation tests passed");
