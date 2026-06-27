import assert from "node:assert/strict";
import { buildGrantInsightSnapshot } from "./grantInsights";

const asOf = new Date("2026-06-27T00:00:00.000Z");
const snapshot = buildGrantInsightSnapshot({
  asOf,
  staleCursorHours: 24,
  grants: [
    {
      source: "kstartup",
      status: "open",
      categoryL1: "창업",
      agencyJurisdiction: "중소벤처기업부",
      applyStart: new Date("2026-06-01T00:00:00.000Z"),
      applyEnd: new Date("2026-07-01T00:00:00.000Z"),
      fRegions: ["11"],
      overallConfidence: 0.9,
      updatedAt: asOf,
    },
    {
      source: "bizinfo",
      status: "open",
      categoryL1: "판로",
      agencyJurisdiction: "중소벤처기업부",
      applyStart: new Date("2026-06-10T00:00:00.000Z"),
      applyEnd: new Date("2026-07-10T00:00:00.000Z"),
      fRegions: [],
      overallConfidence: 0.7,
      updatedAt: asOf,
    },
    {
      source: "kstartup",
      status: "closed",
      categoryL1: null,
      agencyJurisdiction: null,
      applyStart: null,
      applyEnd: new Date("2026-05-01T00:00:00.000Z"),
      fRegions: ["26"],
      overallConfidence: 0.8,
      updatedAt: asOf,
    },
  ],
  criteria: [
    { dimension: "region", operator: "in", kind: "required", confidence: 0.95, needsReview: false },
    { dimension: "industry", operator: "text_only", kind: "required", confidence: 0.55, needsReview: true },
    { dimension: "size", operator: "text_only", kind: "required", confidence: 0.5, needsReview: true },
  ],
  cursors: [
    { source: "kstartup", lastPage: 1, lastCollectedAt: new Date("2026-06-26T23:00:00.000Z") },
    { source: "bizinfo", lastPage: 1, lastCollectedAt: new Date("2026-06-24T00:00:00.000Z") },
  ],
  activity: {
    dedupLinks: 0,
    extractionLog: 0,
    feedback: 0,
    matchEvents: 0,
    goldenSet: 0,
    evalRuns: 0,
  },
});

assert.equal(snapshot.kind, "grant_archive");
assert.equal(snapshot.metrics.totalGrants, 3);
assert.equal(snapshot.metrics.activeGrants, 2);
assert.equal(snapshot.metrics.sourceCount, 2);
assert.equal(snapshot.metrics.textOnlyCriteria, 2);
assert.equal(snapshot.metrics.needsReviewCriteria, 2);
assert.equal(snapshot.metrics.staleCursorCount, 1);
assert.ok(snapshot.insights.some((item) => item.code === "text_only_heavy"));
assert.ok(snapshot.insights.some((item) => item.code === "quality_loop_empty"));
assert.ok(snapshot.insights.some((item) => item.code === "stale_source_cursor"));
assert.ok(Array.isArray(snapshot.dimensions.sources));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "grant_insight_metrics",
    "grant_insight_text_only_signal",
    "grant_insight_quality_loop_signal",
    "grant_insight_stale_cursor_signal",
    "grant_insight_dimensions",
  ],
  metrics: snapshot.metrics,
  insightCodes: snapshot.insights.map((item) => item.code),
}, null, 2));
