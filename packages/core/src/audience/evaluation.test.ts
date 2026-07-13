import assert from "node:assert/strict";
import { evaluateGrantAudience, parseGrantAudienceAnnotationJsonl } from "./evaluation.js";

const reviewed = annotation("individual", "reviewed");
const draft = annotation("company", "draft", "2");
const parsed = parseGrantAudienceAnnotationJsonl(`${JSON.stringify(reviewed)}\n${JSON.stringify(draft)}`);
assert.equal(parsed.length, 2);

const report = evaluateGrantAudience(parsed, [{
  grantId: reviewed.grantId,
  predictedAudience: "individual",
  safeToExcludeFromBusinessMatching: true,
}]);
assert.equal(report.reviewedCount, 1);
assert.equal(report.excludedDraftCount, 1);
assert.equal(report.individualPrecision, 1);
assert.equal(report.individualRecall, 1);
assert.equal(report.operationalReady, false, "minimum sample gate stays closed");

assert.throws(() => parseGrantAudienceAnnotationJsonl(JSON.stringify({
  ...reviewed,
  reviewerId: reviewed.annotatorId,
})), /independent reviewer/);
assert.throws(() => parseGrantAudienceAnnotationJsonl(JSON.stringify({
  ...reviewed,
  reviewerId: "codex-reviewer",
})), /human reviewer/);
assert.throws(() => parseGrantAudienceAnnotationJsonl(JSON.stringify({
  ...reviewed,
  sourceRevision: "",
})), /sourceRevision/);
assert.throws(() => parseGrantAudienceAnnotationJsonl([
  JSON.stringify(reviewed), JSON.stringify(reviewed),
].join("\n")), /duplicate grantId/);

console.log("audience/evaluation.test.ts: all assertions passed");

function annotation(expectedAudience: "company" | "individual", labelStatus: "draft" | "reviewed", suffix = "1") {
  return {
    recordType: "grant_audience_annotation",
    schemaVersion: "grant-audience-v1",
    grantId: `kstartup:${suffix}`,
    source: "kstartup",
    sourceId: suffix,
    title: "대상 검수",
    sourceRevision: `revision-${suffix}`,
    expectedAudience,
    labelStatus,
    annotatorId: labelStatus === "reviewed" ? "annotator@example.com" : null,
    annotatedAt: labelStatus === "reviewed" ? "2026-07-11T00:00:00.000Z" : null,
    reviewerId: labelStatus === "reviewed" ? "reviewer@example.com" : null,
    reviewedAt: labelStatus === "reviewed" ? "2026-07-12T00:00:00.000Z" : null,
    note: "",
  };
}
