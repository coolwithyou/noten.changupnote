import assert from "node:assert/strict";
import type { GrantCriterion } from "@cunote/contracts";
import { mergeGrantIndustryTags, projectGrantIndustryTags } from "./industry-projection.js";

const criteria: GrantCriterion[] = [{
  dimension: "industry",
  operator: "in",
  kind: "required",
  value: { labels: ["SW", " 소프트웨어 "] },
  confidence: 0.9,
}, {
  dimension: "industry",
  operator: "in",
  kind: "preferred",
  value: { kics_codes: ["J62"] },
  confidence: 0.7,
}, {
  dimension: "industry",
  operator: "not_in",
  kind: "exclusion",
  value: { tags: ["도박업"] },
  confidence: 0.9,
}, {
  dimension: "industry",
  operator: "text_only",
  kind: "required",
  value: { note: "세부 업종은 원문 확인" },
  confidence: 0.5,
}, {
  dimension: "size",
  operator: "in",
  kind: "required",
  value: { labels: ["중소기업"] },
  confidence: 0.9,
}];

assert.deepEqual(projectGrantIndustryTags(criteria), ["SW", "소프트웨어", "J62"]);
assert.deepEqual(
  mergeGrantIndustryTags(["ICT", "SW"], projectGrantIndustryTags(criteria)),
  ["ICT", "SW", "소프트웨어", "J62"],
);

console.log("industry-projection.test.ts: all assertions passed");
