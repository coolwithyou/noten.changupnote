import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria } from "./match.js";

const company: CompanyProfile = {
  region: { code: "41", label: "경기" },
  biz_age_months: 144,
};
const legacyAge: GrantCriterion = {
  dimension: "biz_age", operator: "lte", kind: "required", confidence: 0.98,
  source_field: "biz_enyy", parser_version: "kstartup-field-parser-v3",
  source_span: "예비창업자,1년미만,2년미만,3년미만,5년미만,7년미만,10년미만",
  value: { max_months: 120, include_preliminary: true },
};
const explicitRegion: GrantCriterion = {
  dimension: "region", operator: "in", kind: "required", confidence: 0.98,
  source_field: "aply_trgt_ctnt", source_span: "경기도에 본사를 둔 기업",
  value: { regions: ["41"], labels: ["경기"] },
};

const onlyLegacy = matchGrantCriteria([legacyAge], company);
assert.equal(onlyLegacy.eligibility, "conditional");
assert.equal(onlyLegacy.criteria_extracted, false);
assert.equal(onlyLegacy.review_gate?.tier, "needs_core_review");
assert.equal(onlyLegacy.rule_trace.length, 1);
assert.equal(onlyLegacy.rule_trace[0]?.dimension, "other");
assert.equal(onlyLegacy.rule_trace[0]?.result, "unknown");

const withPassingExplicitCondition = matchGrantCriteria([legacyAge, explicitRegion], company);
assert.equal(withPassingExplicitCondition.eligibility, "conditional");
assert.equal(withPassingExplicitCondition.criteria_extracted, false);
assert.equal(withPassingExplicitCondition.review_gate?.tier, "needs_core_review");
assert.equal(withPassingExplicitCondition.rule_trace.length, 1);
assert.equal(withPassingExplicitCondition.rule_trace[0]?.source_span, explicitRegion.source_span);
assert.equal(withPassingExplicitCondition.next_question, undefined);

const withFailingExplicitCondition = matchGrantCriteria([
  legacyAge,
  { ...explicitRegion, value: { regions: ["11"], labels: ["서울"] } },
], company);
assert.equal(withFailingExplicitCondition.eligibility, "ineligible");
assert.equal(withFailingExplicitCondition.review_gate?.tier, "not_recommended");
assert.equal(withFailingExplicitCondition.rule_trace.length, 1);

// This protection applies to the known legacy parser only; other source fields
// retain their normal matching meaning until they receive source-specific review.
const unrelated = matchGrantCriteria([{ ...legacyAge, parser_version: "other-parser-v1" }], company);
assert.equal(unrelated.eligibility, "ineligible");
