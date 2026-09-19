import assert from "node:assert/strict";
import { isReviewNeededMatchCard } from "./matchBucketClassification";

assert.equal(
  isReviewNeededMatchCard({ eligibility: "conditional", recommendationTier: "needs_profile_input" }),
  true,
);
assert.equal(
  isReviewNeededMatchCard({ eligibility: "conditional", recommendationTier: "needs_core_review" }),
  true,
  "원문 확인 후보도 검토 필요 버킷에서 유지해야 합니다.",
);
assert.equal(
  isReviewNeededMatchCard({ eligibility: "ineligible", recommendationTier: "not_recommended" }),
  false,
);

console.log("match bucket classification tests passed");
