import assert from "node:assert/strict";
import { parseMatchFeedbackReviewJsonl, planMatchFeedbackReviewPublication } from "./match-feedback-review.js";

const [decision] = parseMatchFeedbackReviewJsonl(JSON.stringify({
  schemaVersion: "matching-feedback-review-v1",
  feedbackId: "feedback-1",
  decision: "accepted",
  reviewerId: "reviewer-human-2",
  reviewedAt: "2026-07-12T02:00:00.000Z",
  note: "공고 원문과 회사 입력을 대조함",
}));
assert.ok(decision);
const feedback = {
  id: "feedback-1",
  actor: "user" as const,
  targetId: "company-1:bizinfo:grant-1",
  timestamp: "2026-07-12T01:00:00.000Z",
  value: {
    kind: "wrong",
    userId: "user-1",
    provenance: { captureStatus: "complete", grantRevision: "revision-1" },
  },
};
const plan = planMatchFeedbackReviewPublication({ decision, feedback, currentGrantRevision: "revision-1" });
assert.equal(plan.evaluationCandidate, true);
assert.equal(plan.grantRevision, "revision-1");
assert.equal(plan.refreshScope, "pair");
const grantRefresh = planMatchFeedbackReviewPublication({
  decision,
  feedback: { ...feedback, value: { ...feedback.value, reasonCode: "criteria_wrong" } },
  currentGrantRevision: "revision-1",
});
assert.equal(grantRefresh.refreshScope, "grant");
const companyRefresh = planMatchFeedbackReviewPublication({
  decision,
  feedback: { ...feedback, value: { ...feedback.value, reasonCode: "wrong_company_fact" } },
  currentGrantRevision: "revision-1",
});
assert.equal(companyRefresh.refreshScope, "company");
const rejectedPlan = planMatchFeedbackReviewPublication({
  decision: { ...decision, decision: "rejected" }, feedback, currentGrantRevision: "revision-1",
});
assert.equal(rejectedPlan.refreshScope, "none");
assert.throws(() => planMatchFeedbackReviewPublication({
  decision, feedback, currentGrantRevision: "revision-2",
}), /stale grant revision/);
assert.throws(() => planMatchFeedbackReviewPublication({
  decision: { ...decision, reviewerId: "user-1" }, feedback, currentGrantRevision: "revision-1",
}), /reviewer must differ/);
assert.throws(() => planMatchFeedbackReviewPublication({
  decision: { ...decision, reviewedAt: "2026-07-12T00:00:00.000Z" }, feedback, currentGrantRevision: "revision-1",
}), /must not precede/);
assert.throws(() => parseMatchFeedbackReviewJsonl([
  JSON.stringify(decision), JSON.stringify(decision),
].join("\n")), /duplicate feedbackId/);
assert.throws(() => parseMatchFeedbackReviewJsonl(JSON.stringify({ ...decision, reviewerId: "codex-ai" })), /human reviewer/);
console.log("match-feedback-review.test.ts: all assertions passed");
