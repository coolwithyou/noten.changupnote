import assert from "node:assert/strict";
import type { CompanyProfile, Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { planMatchStateRefresh } from "../src/index.js";

const asOf = new Date("2026-06-01T00:00:00.000Z");
const companyId = "company-refresh-fixture";
const company: CompanyProfile = {
  id: companyId,
  name: "매칭 상태 재계산 기업",
  region: { code: "41", label: "경기" },
  biz_age_months: 10,
  industries: ["ICT"],
  size: "중소",
  confidence: {},
};

const soonGrant = normalizedGrant("soon-biz-age", "업력 1년 이상 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
  {
    dimension: "biz_age",
    operator: "gte",
    kind: "required",
    value: { min_months: 12, include_preliminary: false, labels: ["1년 이상"] },
    confidence: 0.9,
  },
]);

const closingGrant = normalizedGrant("closing-biz-age", "업력 1년 이내 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
  {
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    value: { max_months: 12, include_preliminary: true, labels: ["1년 이내"] },
    confidence: 0.9,
  },
]);

const conditionalGrant = normalizedGrant("industry-unknown", "업종 확인 지원사업", [
  {
    dimension: "industry",
    operator: "in",
    kind: "required",
    value: { tags: ["바이오"] },
    confidence: 0.9,
  },
]);

const malformedFounderAgeGrant = normalizedGrant("founder-age-malformed", "대표자 연령 확인 지원사업", [
  {
    dimension: "founder_age",
    operator: "in",
    kind: "required",
    value: { labels: ["대표자 연령 조건"] },
    confidence: 0.2,
    needs_review: true,
  },
]);

const plan = planMatchStateRefresh({
  company: { ...company, industries: [] },
  grants: [soonGrant, closingGrant, conditionalGrant, malformedFounderAgeGrant],
  asOf,
  companyId,
});

assert.equal(plan.asOf, asOf.toISOString());
assert.equal(plan.companyId, companyId);
assert.equal(plan.grantCount, 4);
assert.deepEqual(plan.counts, { eligible: 1, conditional: 2, ineligible: 1 });
assert.deepEqual(plan.transitionWindowCounts, { eligibleFrom: 1, eligibleUntil: 1 });

const soonState = plan.states.find((state) => state.sourceId === "soon-biz-age");
assert.ok(soonState, "soon match state should exist");
assert.equal(soonState.companyId, companyId);
assert.equal(soonState.eligibility, "ineligible");
assert.equal(soonState.eligibleFrom?.slice(0, 10), "2026-08-01");
assert.equal(soonState.eligibleUntil, null);
assert.equal(soonState.match.rule_trace.some((trace) => trace.dimension === "biz_age" && trace.result === "fail"), true);

const closingState = plan.states.find((state) => state.sourceId === "closing-biz-age");
assert.ok(closingState, "closing match state should exist");
assert.equal(closingState.eligibility, "eligible");
assert.equal(closingState.eligibleFrom, null);
assert.equal(closingState.eligibleUntil?.slice(0, 10), "2026-09-01");

const conditionalState = plan.states.find((state) => state.sourceId === "industry-unknown");
assert.ok(conditionalState, "conditional match state should exist");
assert.equal(conditionalState.eligibility, "conditional");
assert.deepEqual(conditionalState.match.unknown_fields, ["industry"]);
assert.equal(conditionalState.match.review_gate?.tier, "needs_core_review");
assert.equal(conditionalState.match.review_gate?.scoreDisplay, "hidden");

const malformedFounderAgeState = plan.states.find((state) => state.sourceId === "founder-age-malformed");
assert.ok(malformedFounderAgeState, "malformed founder age match state should exist");
assert.equal(malformedFounderAgeState.eligibility, "conditional");
assert.deepEqual(malformedFounderAgeState.match.unknown_fields, ["founder_age"]);
assert.equal(malformedFounderAgeState.match.review_gate?.tier, "needs_core_review");
assert.equal(malformedFounderAgeState.match.quality.extractionReadiness, "partial");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "match_state_refresh_counts",
    "match_state_refresh_company_scope",
    "match_state_refresh_eligible_from",
    "match_state_refresh_eligible_until",
    "match_state_refresh_rule_trace",
    "match_state_refresh_unknown_fields",
    "match_state_refresh_review_gate",
    "match_state_refresh_malformed_founder_age_core_review",
  ],
  counts: plan.counts,
  transitionWindowCounts: plan.transitionWindowCounts,
}, null, 2));

function normalizedGrant(
  sourceId: string,
  title: string,
  criteria: GrantCriterion[],
): NormalizedGrant<Record<string, unknown>> {
  const grant: Grant = {
    source: "kstartup",
    source_id: sourceId,
    title,
    url: `https://example.test/grants/${sourceId}`,
    agency_jurisdiction: "중소벤처기업부",
    agency_operator: "창업진흥원",
    category_l1: "사업화",
    category_l2: null,
    apply_start: "2026-06-01",
    apply_end: "2026-09-30",
    apply_method: { online: "온라인 접수" },
    support_amount: { max: 10_000_000, unit: "KRW", per: "기업" },
    required_documents: null,
    status: "open",
    f_regions: ["41"],
    f_industries: [],
    f_biz_age_min_months: null,
    f_biz_age_max_months: null,
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
    parser_version: "fixture",
  };

  return {
    raw: {
      source: "kstartup",
      source_id: sourceId,
      payload: { sourceId, title },
      status: "normalized",
    },
    grant,
    criteria: criteria.map((criterion) => ({
      ...criterion,
      source_field: criterion.source_field ?? "test_fixture",
    })),
  };
}
