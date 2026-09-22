import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { evaluateProfileUpdateImpact } from "./evaluate-profile-update-impact.js";

const beforeProfile: CompanyProfile = {
  id: "company-impact-test",
  employees_count: 3,
};
const afterProfile: CompanyProfile = {
  ...beforeProfile,
  revenue_krw: 80_000_000,
  confidence: { revenue: 0.6 },
};

const grants = [
  grant("revenue-pass", [requiredMax("revenue", 100_000_000)]),
  grant("revenue-fail", [requiredMax("revenue", 50_000_000)]),
  grant("revenue-plus-unknown", [
    requiredMax("revenue", 100_000_000),
    {
      dimension: "certification",
      kind: "required",
      operator: "in",
      value: { certs: ["벤처기업"] },
      confidence: 1,
      source_field: "target",
      source_span: "벤처기업 확인기업",
    },
  ]),
  grant("unrelated", [{
    dimension: "employees",
    kind: "required",
    operator: "lte",
    value: { max: 5 },
    confidence: 1,
    source_field: "target",
    source_span: "상시근로자 5명 이하",
  }]),
];

const report = evaluateProfileUpdateImpact({
  grants,
  beforeProfile,
  afterProfile,
  dimension: "revenue",
});

assert.equal(report.evaluatedGrantCount, 4);
assert.equal(report.scope, "active_grant_window");
assert.equal(report.windowLimit, 4);
assert.equal(report.targetedConditionalCount, 3);
assert.equal(report.dimensionResolvedGrantCount, 3);
assert.equal(report.eligibilityResolvedCount, 2);
assert.equal(report.conditionalToEligibleCount, 1);
assert.equal(report.conditionalToIneligibleCount, 1);
assert.equal(report.remainingConditionalCount, 1);
assert.equal(report.conditionalResolutionRate, 0.6667);
assert.equal(report.transitionCounts.conditional_to_eligible, 1);
assert.equal(report.transitionCounts.conditional_to_ineligible, 1);
assert.equal(report.transitionCounts.conditional_to_conditional, 1);
assert.equal(report.transitionCounts.eligible_to_eligible, 1);
assert.equal(report.changedMatchStateCount, 3);
assert.deepEqual(report.refreshGrantIds, [
  "bizinfo:revenue-pass",
  "bizinfo:revenue-fail",
  "bizinfo:revenue-plus-unknown",
]);

const noTarget = evaluateProfileUpdateImpact({
  grants,
  beforeProfile,
  afterProfile,
  dimension: "region",
});
assert.equal(noTarget.targetedConditionalCount, 0);
assert.equal(noTarget.conditionalResolutionRate, null);

const emptyWindow = evaluateProfileUpdateImpact({
  grants: [],
  beforeProfile,
  afterProfile,
  dimension: "revenue",
  windowLimit: 100,
});
assert.equal(emptyWindow.evaluatedGrantCount, 0);
assert.equal(emptyWindow.windowLimit, 0, "빈 평가 집합은 요청 상한과 무관하게 실제 window 0을 보고한다");
assert.equal(emptyWindow.targetedConditionalCount, 0);
assert.equal(emptyWindow.dimensionResolvedGrantCount, 0);
assert.equal(emptyWindow.eligibilityResolvedCount, 0);
assert.equal(emptyWindow.changedMatchStateCount, 0);
assert.deepEqual(emptyWindow.refreshGrantIds, []);
assert.deepEqual(emptyWindow.transitionCounts, {});
assert.equal(emptyWindow.conditionalResolutionRate, null, "0/0을 숫자나 NaN으로 만들지 않는다");

const industryGrant = grant("industry-positive-only", [{
  dimension: "industry",
  kind: "required",
  operator: "in",
  value: { tags: ["소프트웨어"] },
  confidence: 1,
  source_field: "target",
  source_span: "소프트웨어 기업",
}]);
const partialIndustry = evaluateProfileUpdateImpact({
  grants: [industryGrant],
  beforeProfile: { id: "industry-before" },
  afterProfile: {
    id: "industry-before",
    industries: ["바이오"],
    confidence: { industry: 0.6 },
    list_completeness: { industry: "partial" },
  },
  dimension: "industry",
});
assert.equal(partialIndustry.targetedConditionalCount, 1);
assert.equal(partialIndustry.dimensionResolvedGrantCount, 0, "positive-only 비일치는 미충족이 아니라 미확인이다");
assert.equal(partialIndustry.eligibilityResolvedCount, 0);

const completeIndustry = evaluateProfileUpdateImpact({
  grants: [industryGrant],
  beforeProfile: { id: "industry-before" },
  afterProfile: {
    id: "industry-before",
    industries: ["바이오"],
    confidence: { industry: 0.6 },
    list_completeness: { industry: "complete" },
  },
  dimension: "industry",
});
assert.equal(completeIndustry.dimensionResolvedGrantCount, 1);
assert.equal(completeIndustry.conditionalToIneligibleCount, 1, "소진적 목록에서만 비일치를 확정한다");

const sharedPremisesGrants = [
  "siheung-a",
  "siheung-b",
  "siheung-c",
  "siheung-d",
].map((sourceId) => grant(sourceId, [premisesCriterion(sourceId, "2026-09-09", "headquarters")]));
const differentlyScopedPremisesGrants = [
  grant("siheung-factory", [premisesCriterion("siheung-factory", "2026-09-09", "factory")]),
  grant("siheung-future", [premisesCriterion("siheung-future", "2026-10-01", "headquarters")]),
];
const premisesImpact = evaluateProfileUpdateImpact({
  grants: [...sharedPremisesGrants, ...differentlyScopedPremisesGrants],
  beforeProfile: { id: "premises-company" },
  afterProfile: {
    id: "premises-company",
    premises: {
      schemaVersion: "premises-v1",
      locations: [{
        locationId: "00000000-0000-4000-8000-000000000001",
        facilityType: "headquarters",
        sidoCode: "41",
        validFrom: "2026-01-01",
        validTo: null,
      }],
      coverage: {
        facilityTypes: ["headquarters"],
        validFrom: "2026-01-01",
        validTo: "2026-09-09",
        asOf: "2026-09-08T15:30:00.000Z",
        completeness: "complete",
      },
    },
    profile_evidence: {
      premises: {
        sourceKind: "self_declared",
        provider: "cunote_profile_question",
        asOf: "2026-09-08T15:30:00.000Z",
        axisCompleteness: "complete",
        confidence: 0.6,
        scope: "user",
        persistenceClass: "portable_user_answer",
      },
    },
  },
  dimension: "premises",
  asOf: new Date("2026-09-08T15:30:00.000Z"),
});
assert.equal(premisesImpact.targetedConditionalCount, 6);
assert.equal(premisesImpact.dimensionResolvedGrantCount, 4, "같은 범위와 기준일의 네 공고가 한 답변으로 함께 해소된다");
assert.equal(premisesImpact.conditionalToEligibleCount, 4);
assert.equal(premisesImpact.remainingConditionalCount, 2, "시설 범위나 기준일이 다른 공고에는 답변을 확정 전파하지 않는다");

console.log("evaluate-profile-update-impact: ok");

function requiredMax(dimension: "revenue", max: number): GrantCriterion {
  return {
    dimension,
    kind: "required",
    operator: "lte",
    value: { max_krw: max },
    confidence: 1,
    source_field: "target",
    source_span: `매출 ${max}원 이하`,
  };
}

function premisesCriterion(
  id: string,
  basisDate: string,
  facilityType: "headquarters" | "factory",
): GrantCriterion {
  return {
    id: `criterion-${id}`,
    dimension: "premises",
    kind: "required",
    operator: "exists",
    value: {
      schemaVersion: "premises-v1",
      state: "registered_current_site",
      sidoCodes: ["41"],
      facilityTypes: [facilityType],
      facilitySemantics: "any",
      basisDate,
    },
    confidence: 1,
    needs_review: false,
    source_span: `${basisDate} 현재 경기도에 등록된 ${facilityType === "headquarters" ? "본사" : "공장"}를 둔 기업`,
  };
}

function grant(sourceId: string, criteria: GrantCriterion[]): NormalizedGrant<{ fixture: true }> {
  return {
    raw: {
      source: "bizinfo",
      source_id: sourceId,
      payload: { fixture: true },
      status: "normalized",
    },
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: sourceId,
      status: "open",
      apply_start: null,
      apply_end: null,
      url: `https://example.invalid/${sourceId}`,
      required_documents: [],
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      audience: "company",
      overall_confidence: 1,
    },
    criteria,
  };
}
