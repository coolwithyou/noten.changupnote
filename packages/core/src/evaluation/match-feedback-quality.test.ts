import assert from "node:assert/strict";
import { buildMatchFeedbackQualityReport, type MatchFeedbackQualityRecord } from "./match-feedback-quality.js";

const records: MatchFeedbackQualityRecord[] = [
  user("feedback-1", "wrong", {
    reasonCode: "criteria_wrong",
    correction: { dimension: "industry" },
    provenance: { captureStatus: "complete", grantSource: "kstartup", rulesetVersion: "v3" },
  }),
  user("feedback-2", "saved", {
    provenance: { captureStatus: "complete", grantSource: "bizinfo", rulesetVersion: "v3" },
  }),
  user("feedback-3", "wrong", { provenance: { captureStatus: "company_missing" } }),
  {
    id: "review-1",
    actor: "reviewer",
    timestamp: "2026-07-20T00:00:00.000Z",
    value: {
      reviewedFeedbackId: "feedback-1",
      reviewDecision: "accepted",
      reviewerId: "reviewer-human-1",
      reviewedAt: "2026-07-20T00:00:00.000Z",
    },
  },
  {
    id: "invalid-review",
    actor: "reviewer",
    timestamp: "2026-07-21T00:00:00.000Z",
    value: { reviewedFeedbackId: "feedback-3", reviewDecision: "accepted" },
  },
];
const report = buildMatchFeedbackQualityReport({
  records,
  periodStart: new Date("2026-07-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-01T00:00:00.000Z"),
});
assert.equal(report.totalUserFeedback, 3);
assert.equal(report.completeProvenanceCount, 2);
assert.equal(report.provenanceCoverage, 0.6667);
assert.equal(report.reviewCandidateCount, 2);
assert.equal(report.reviewedCandidateCount, 1);
assert.equal(report.reviewBacklogCount, 1);
assert.equal(report.invalidReviewerRecordCount, 1);
assert.equal(report.byCorrectedDimension.industry, 1);
assert.equal(report.operationalReady, false);
assert.throws(() => buildMatchFeedbackQualityReport({
  records: [], periodStart: new Date("2026-08-01"), periodEnd: new Date("2026-07-01"),
}), /periodEnd/);
console.log("match-feedback-quality.test.ts: all assertions passed");

function user(id: string, kind: string, value: Record<string, unknown>): MatchFeedbackQualityRecord {
  return {
    id,
    actor: "user",
    timestamp: "2026-07-10T00:00:00.000Z",
    value: { kind, ...value },
  };
}
