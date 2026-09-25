import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria } from "../matching/match.js";
import { compareIndustryCategories } from "./semantic-category.js";
import { normalizeGrantLlmCriteria } from "../bizinfo/llm-criteria.js";

const company: CompanyProfile = {
  industries: ["응용 소프트웨어 개발 및 공급업", "컴퓨터 프로그래밍 서비스업", "광고 대행업"],
  confidence: { industry: 0.6 }, list_completeness: { industry: "complete" },
};
const industry: GrantCriterion = {
  dimension: "industry", kind: "required", operator: "in", value: { tags: ["ICT"] },
  source_span: "과학기술 및 ICT 중소 기업", confidence: 0.95, needs_review: false,
};
const size: GrantCriterion = {
  dimension: "size", kind: "required", operator: "in", value: { sizes: ["중소기업"] },
  source_span: "과학기술 및 ICT 중소 기업", confidence: 0.95, needs_review: false,
};

for (const label of ["응용 소프트웨어 개발 및 공급업", "컴퓨터 프로그래밍 서비스업", "호스팅 및 관련 서비스업", "SW"]) {
  const result = matchGrantCriteria([industry], { ...company, industries: [label] });
  assert.equal(result.rule_trace[0]?.result, "pass", `${label} satisfies the broader ICT category`);
  assert.match(result.rule_trace[0]!.message, /ICT/);
}
assert.deepEqual(compareIndustryCategories(["ICT"], ["컴퓨터 프로그래밍 서비스업"]).match?.path,
  ["컴퓨터 프로그래밍", "소프트웨어", "ICT"]);
assert.equal(compareIndustryCategories(["소프트웨어 개발 및 공급업"], ["컴퓨터 프로그래밍 서비스업"]).match, null,
  "a shared software parent does not establish a specific publishing industry");

const incomplete = matchGrantCriteria([industry, size], company);
assert.equal(incomplete.rule_trace.find(t => t.dimension === "industry")?.result, "pass");
assert.equal(incomplete.rule_trace.find(t => t.dimension === "size")?.result, "unknown");
assert.equal(incomplete.eligibility, "conditional", "sector membership never invents SME status");

assert.equal(compareIndustryCategories(["게임 소프트웨어"], ["소프트웨어"]).match, null, "parent membership does not prove a child activity");
for (const label of ["ICT", "소프트웨어"]) {
  const narrower = matchGrantCriteria([{ ...industry, value: { tags: ["게임 소프트웨어"] } }], { ...company, industries: [label] });
  assert.equal(narrower.rule_trace[0]?.result, "unknown");
}
for (const label of ["소프트웨어", "시스템 소프트웨어 개발 및 공급업"]) {
  const narrower = matchGrantCriteria([{ ...industry, value: { tags: ["응용 소프트웨어 개발 및 공급업"] } }], { ...company, industries: [label] });
  assert.equal(narrower.rule_trace[0]?.result, "unknown", "broad or sibling software activity does not prove application software");
}
for (const label of ["광고 대행업", "소프트웨어 교육업", "비소프트웨어 제조업", "소프트웨어를 이용하는 음식점"]) {
  assert.equal(compareIndustryCategories(["ICT"], [label]).match, null, "using or mentioning software does not establish an ICT business");
  assert.notEqual(matchGrantCriteria([industry], { ...company, industries: [label] }).rule_trace[0]?.result, "pass");
}
const exclusion = matchGrantCriteria([{ ...industry, kind: "exclusion", operator: "not_in" }], company);
assert.equal(exclusion.rule_trace[0]?.result, "fail", "the same semantic relation preserves exclusion polarity");
const unresolved = matchGrantCriteria([{ ...industry, operator: "text_only", value: { note: "ICT 분야 참여 조건 원문 확인" } }], company);
assert.equal(unresolved.rule_trace[0]?.result, "unknown", "historical unresolved scope is not silently rewritten");
const unreviewed = matchGrantCriteria([{ ...industry, needs_review: true }], company);
assert.equal(unreviewed.review_gate?.tier, "needs_core_review", "semantic membership does not forge review approval");

// Synthetic model output exercises the real reviewed-output normalizer and matcher.
// This is not evidence that a new live model run or publication has occurred.
const projected = normalizeGrantLlmCriteria({ criteria: [industry, size] }, "semantic-industry-fixture", {
  sourcePrefix: "lab-shadow", parserVersion: "semantic-industry-fixture", forceNeedsReview: false,
});
assert.deepEqual(projected[0]?.value, { tags: ["ICT"] });
const projectedMatch = matchGrantCriteria(projected, company);
assert.equal(projectedMatch.rule_trace.find(t => t.dimension === "industry")?.result, "pass");
assert.equal(projectedMatch.rule_trace.find(t => t.dimension === "size")?.result, "unknown");
assert.equal(projectedMatch.eligibility, "conditional");

console.log("industry/semantic-category.test.ts: all assertions passed");

// Cross-industry regression: legal hierarchy is directional and shares the same
// matcher interface as ICT policy membership. Codes here are synthetic fixtures.
for (const [required, actual] of [
  ["제조업", "식료품 제조업"], ["제조업", "의류제조"],
  ["제조업", "가구제조업"], ["도소매업", "소매업"],
  ["운수 및 창고업", "창고업"],
  ["전문, 과학 및 기술 서비스업", "연구개발업"],
  ["정보통신업", "응용 소프트웨어 개발 및 공급업"],
  ["정보통신업", "영상·오디오 기록물 제작 및 배급업"],
] as const) {
  const criterion = { ...industry, value: { tags: [required] } };
  assert.equal(matchGrantCriteria([criterion], { industries: [actual] }).rule_trace[0]?.result, "pass", `${actual} -> ${required}`);
  assert.equal(compareIndustryCategories([actual], [required]).match, null, `No reverse membership ${required} -> ${actual}`);
}
assert.deepEqual(compareIndustryCategories(["정보통신업"], ["컴퓨터 프로그래밍 서비스업"]).match?.path,
  ["컴퓨터 프로그래밍", "소프트웨어", "정보통신업"], "explanations must be an actual path, not flattened siblings");
assert.equal(compareIndustryCategories(["ICT"], ["영상·오디오 기록물 제작 및 배급업"]).match, null,
  "statistical information/communications is not identical to the ICT policy category");
for (const [required, actual] of [["AI", "소프트웨어"], ["바이오", "의료용 물질 및 의약품 제조업"],
  ["제조업", "식품 도소매업"], ["연구개발업", "연구개발 서비스를 이용하는 기업"]] as const) {
  assert.equal(compareIndustryCategories([required], [actual]).match, null, "no inferred technology, activity or supplier role");
}
assert.equal(matchGrantCriteria([{ ...industry, value: { tags: ["제조업"] } }],
  { industry_codes: ["10799"] }).rule_trace[0]?.result, "pass");
for (const code of ["154103", "J10", "107990", "bad-code"])
  assert.equal(compareIndustryCategories(["제조업"], [], [code]).match, null, "invalid, tax, or contradictory code must not prove membership");
assert.equal(compareIndustryCategories(["식료품 제조업"], [], ["C"]).match, null, "broad codes cannot prove narrow industries");
assert.equal(matchGrantCriteria([{ ...industry, kind: "exclusion", operator: "not_in", value: { tags: ["제조업"] } }],
  { industries: ["식료품 제조업"] }).rule_trace[0]?.result, "fail");
console.log("industry cross-sector membership assertions passed");

assert.equal(compareIndustryCategories(["창고업"], [], ["52"]).match, null, "transport-support division does not prove warehousing");
assert.equal(compareIndustryCategories(["의류 제조업"], [], ["14"]).match, null, "broader division including accessories does not prove clothing manufacture");
