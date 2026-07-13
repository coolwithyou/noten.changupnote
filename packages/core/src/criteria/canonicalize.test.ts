import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria } from "../matching/match.js";
import { canonicalizeGrantCriterion } from "./canonicalize.js";

function criterion(overrides: Partial<GrantCriterion>): GrantCriterion {
  return {
    dimension: "other",
    operator: "text_only",
    kind: "required",
    value: { note: "확인" },
    confidence: 0.9,
    source_span: "근거",
    ...overrides,
  };
}

const company: CompanyProfile = {
  region: { code: "50", label: "제주" },
  biz_age_months: 36,
  founder_age: 39,
  size: "중소기업",
  traits: ["여성"],
  target_types: ["법인사업자"],
  revenue_krw: 900_000_000,
  employees_count: 12,
  list_completeness: {
    founder_trait: "complete",
    target_type: "complete",
  },
};

const legacyRegion = criterion({
  dimension: "region",
  operator: "in",
  value: { regions: [50] as unknown as string[], labels: ["제주"] },
});
assert.deepEqual(canonicalizeGrantCriterion(legacyRegion).value, {
  regions: ["50"],
  labels: ["제주"],
});
assert.equal(matchGrantCriteria([legacyRegion], company).eligibility, "eligible");

const aliases = [
  criterion({ dimension: "size", operator: "in", value: { labels: ["소중기업"] } }),
  criterion({ dimension: "target_type", operator: "in", value: { types: ["법인사업자"] } }),
  criterion({ dimension: "founder_trait", operator: "in", value: { labels: ["여성"] } }),
];
assert.deepEqual(canonicalizeGrantCriterion(aliases[0]!).value, { sizes: ["중소기업"] });
assert.deepEqual(canonicalizeGrantCriterion(aliases[1]!).value, { targets: ["법인사업자"] });
assert.deepEqual(canonicalizeGrantCriterion(aliases[2]!).value, { traits: ["여성"] });
assert.equal(matchGrantCriteria(aliases, company).eligibility, "eligible");

assert.deepEqual(canonicalizeGrantCriterion(criterion({
  dimension: "biz_age",
  operator: "between",
  value: { min: 0, max: 7, unit: "years", labels: ["창업 7년 이내"] },
})).value, {
  min_months: 0,
  max_months: 84,
  labels: ["창업 7년 이내"],
});

assert.deepEqual(canonicalizeGrantCriterion(criterion({
  dimension: "founder_age",
  operator: "between",
  value: { min: 18, max: 45 },
})).value, {
  ranges: [{ min: 18, max: 45, label: "18~45세" }],
  labels: ["18~45세"],
});

const numericAliases = [
  criterion({ dimension: "employees", operator: "gte", value: { min_employees: 10 } }),
  criterion({ dimension: "revenue", operator: "gte", value: { amount_krw: 800_000_000 } }),
];
assert.deepEqual(canonicalizeGrantCriterion(numericAliases[0]!).value, { min: 10 });
assert.deepEqual(canonicalizeGrantCriterion(numericAliases[1]!).value, { min_krw: 800_000_000 });
assert.equal(matchGrantCriteria(numericAliases, company).eligibility, "eligible");

const localityWithoutCode = criterion({
  dimension: "region",
  operator: "in",
  value: { labels: ["구미시"] },
});
const localityResult = matchGrantCriteria([localityWithoutCode], company);
assert.equal(localityResult.eligibility, "conditional");
assert.equal(localityResult.rule_trace[0]?.result, "unknown");

const ambiguousExclusion = criterion({
  dimension: "revenue",
  operator: "lte",
  kind: "exclusion",
  value: { revenue_krw: 300_000_000_000 },
  source_span: "매출 3,000억원 이상 기업은 제외",
});
assert.deepEqual(canonicalizeGrantCriterion(ambiguousExclusion).value, {});
assert.equal(
  matchGrantCriteria([ambiguousExclusion], company).eligibility,
  "conditional",
  "자연어 극성을 재추론할 수 없는 legacy exclusion은 unknown으로 보존한다",
);

const canonicalExclusion = criterion({
  dimension: "revenue",
  operator: "gte",
  kind: "exclusion",
  value: { min_krw: 800_000_000 },
  source_span: "매출 8억원 이상 기업은 제외",
});
assert.equal(matchGrantCriteria([canonicalExclusion], company).eligibility, "ineligible");

const redundantListExclusion = canonicalizeGrantCriterion(criterion({
  dimension: "size",
  operator: "not_in",
  kind: "exclusion",
  value: { labels: ["대기업"] },
}));
assert.equal(redundantListExclusion.operator, "in", "exclusion + not_in 이중 극성을 제거한다");
assert.deepEqual(redundantListExclusion.value, { sizes: ["대기업"] });

// region 값 무결성 — 라벨→시도 코드 환원, 전국 토큰 승격, 미해석 토큰 unknown 강등.
// 운영 실측(2026-07-13)에서 '국내'·'domestic'·'37'(비표준 코드) 오염이 required IN을
// 전 회사 확정 탈락으로 만들던 것을 canonicalize 단계에서 무해화한다.
const labeledRegion = canonicalizeGrantCriterion(criterion({
  dimension: "region",
  operator: "in",
  value: { regions: ["서울특별시", "경기"] },
}));
assert.deepEqual(labeledRegion.value, { regions: ["11", "41"] });

const metroRegion = canonicalizeGrantCriterion(criterion({
  dimension: "region",
  operator: "in",
  value: { regions: ["수도권"] },
}));
assert.deepEqual(metroRegion.value, { regions: ["11", "28", "41"] });

const nationwideToken = criterion({
  dimension: "region",
  operator: "in",
  value: { regions: ["국내"] },
});
assert.deepEqual(canonicalizeGrantCriterion(nationwideToken).value, {
  regions: [],
  nationwide: true,
});
assert.equal(
  matchGrantCriteria([nationwideToken], company).eligibility,
  "eligible",
  "'국내' 토큰은 전국으로 승격되어 pass한다",
);

const pollutedRegion = criterion({
  dimension: "region",
  operator: "in",
  value: { regions: ["37"], labels: ["포항"] },
});
assert.deepEqual(canonicalizeGrantCriterion(pollutedRegion).value, {
  regions: [],
  labels: ["포항", "37"],
});
const pollutedResult = matchGrantCriteria([pollutedRegion], company);
assert.equal(
  pollutedResult.eligibility,
  "conditional",
  "시도 코드로 환원 불가한 지역 값은 확정 탈락이 아니라 unknown으로 보존한다",
);
assert.equal(pollutedResult.rule_trace[0]?.result, "unknown");

const mixedPollution = canonicalizeGrantCriterion(criterion({
  dimension: "region",
  operator: "in",
  value: { regions: ["11", "전남광주"] },
}));
assert.deepEqual(
  mixedPollution.value,
  { regions: [], labels: ["전남광주"] },
  "미해석 토큰이 섞이면 잔여 코드만으로 판정하지 않는다(미해석 지역 회사의 과잉 탈락 방지)",
);

console.log("criteria/canonicalize.test.ts: all assertions passed");
