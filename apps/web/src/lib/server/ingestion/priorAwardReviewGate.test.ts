import assert from "node:assert/strict";
import { assessPriorAwardIndependentReview, type PriorAwardReviewCandidate } from "./priorAwardReviewGate";

const candidate: PriorAwardReviewCandidate = {
  grantId: "kstartup:1",
  sourceId: "1",
  sourceFixture: "prior-award-p5:kstartup:1:hash",
  criterionId: "kstartup:1:prior-award-1",
  operator: "exists",
  value: { scope: "self", self_kind: "current_similar", channel: "general" },
  sourceSpan: "동일·유사 사업 중복 수혜자",
};
const reviewed = {
  recordType: "grant",
  schemaVersion: "matching-v3",
  grantId: "kstartup:1",
  source: "kstartup",
  sourceId: "1",
  title: "검수 공고",
  audience: "company",
  labelStatus: "reviewed",
  annotatorId: "human-annotator",
  reviewerId: "human-reviewer",
  annotatedAt: "2026-07-12T00:00:00.000Z",
  reviewedAt: "2026-07-12T01:00:00.000Z",
  criteria: [{
    criterionId: candidate.criterionId,
    dimension: "prior_award",
    kind: "exclusion",
    operator: candidate.operator,
    value: candidate.value,
    sourceSpan: candidate.sourceSpan,
    sourceField: "aply_excl_trgt_ctnt",
    annotationConfidence: 0.9,
    note: null,
  }],
  sourceFixture: candidate.sourceFixture,
  sourceRevision: "revision-1",
};

assert.deepEqual(assessPriorAwardIndependentReview([candidate], null), {
  acceptedCriterionCount: 0,
  reviewedGrantCount: 0,
  ready: false,
});
assert.deepEqual(assessPriorAwardIndependentReview([candidate], JSON.stringify(reviewed)), {
  acceptedCriterionCount: 1,
  reviewedGrantCount: 1,
  ready: true,
});
assert.equal(assessPriorAwardIndependentReview(
  [candidate],
  JSON.stringify({ ...reviewed, sourceFixture: `${candidate.sourceFixture}-stale` }),
).ready, false, "stale input fixture는 승인 불가");
assert.equal(assessPriorAwardIndependentReview(
  [candidate],
  JSON.stringify({ ...reviewed, criteria: [{ ...reviewed.criteria[0], value: { scope: "self", self_kind: "same_project" } }] }),
).ready, false, "reviewed value와 deterministic 결과 불일치는 승인 불가");
assert.throws(
  () => assessPriorAwardIndependentReview([candidate], JSON.stringify({ ...reviewed, reviewerId: "codex-ai" })),
  /human reviewer/,
);

console.log("priorAwardReviewGate.test.ts: all assertions passed");
