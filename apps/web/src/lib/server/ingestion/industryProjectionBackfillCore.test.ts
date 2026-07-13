import assert from "node:assert/strict";
import type { Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { planBizInfoIndustryProjectionBackfill, planGrantIndustryProjectionBackfill } from "./industryProjectionBackfillCore";

const plan = planBizInfoIndustryProjectionBackfill([
  normalized("bizinfo", "new", [criterion("required", { labels: ["SW"] })], []),
  normalized("bizinfo", "merge", [criterion("preferred", { industries: ["AI"] })], ["ICT"]),
  normalized("bizinfo", "excluded", [criterion("exclusion", { tags: ["도박업"] })], []),
  normalized("kstartup", "other-source", [criterion("required", { tags: ["바이오"] })], []),
]);

assert.equal(plan.scanned, 4);
assert.equal(plan.sourceCount, 3);
assert.equal(plan.criteriaSignalCount, 2);
assert.equal(plan.candidateCount, 2);
assert.deepEqual(plan.candidates[0]?.after, ["SW"]);
assert.deepEqual(plan.candidates[1]?.after, ["ICT", "AI"]);
assert.equal(plan.candidates.some((candidate) => candidate.sourceId === "excluded"), false);

const applied = [
  normalized("bizinfo", "new", [criterion("required", { labels: ["SW"] })], ["SW"]),
  normalized("bizinfo", "merge", [criterion("preferred", { industries: ["AI"] })], ["ICT", "AI"]),
];
assert.equal(planBizInfoIndustryProjectionBackfill(applied).candidateCount, 0, "backfill plan must be idempotent");
assert.equal(
  planGrantIndustryProjectionBackfill([
    normalized("kstartup", "k-positive", [criterion("required", { codes: ["J62"] })], []),
  ], "kstartup").candidateCount,
  1,
);

function criterion(kind: GrantCriterion["kind"], value: Record<string, unknown>): GrantCriterion {
  return { dimension: "industry", operator: kind === "exclusion" ? "not_in" : "in", kind, value, confidence: 0.9 };
}

function normalized(
  source: Grant["source"],
  sourceId: string,
  criteria: GrantCriterion[],
  industries: string[],
): NormalizedGrant {
  return {
    raw: { source, source_id: sourceId, payload: {}, status: "normalized" },
    grant: {
      source,
      source_id: sourceId,
      title: sourceId,
      status: "open",
      f_regions: [],
      f_industries: industries,
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria,
  };
}

console.log("industryProjectionBackfillCore.test.ts: all assertions passed");
