import assert from "node:assert/strict";
import type { CompanyProfile, Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { matchGrantCriteria } from "./match.js";
import { planProfileQuestions } from "./question-planner.js";
import type { MatchedGrant } from "../use-cases/match-card.js";
import { updateCompanyProfileField } from "../company/update-profile-field.js";

const asOf = new Date("2026-07-12T00:00:00.000Z");
const company: CompanyProfile = {
  region: { code: "41", label: "경기" },
  size: "중소",
  industries: ["ICT"],
  confidence: { region: 0.8, size: 0.6, industry: 0.6 },
};

const matches = [
  matched("revenue-1", "2026-07-16", [numericCriterion("revenue", "매출 1억원 이상", { min_krw: 100_000_000 })]),
  matched("revenue-2", "2026-08-20", [numericCriterion("revenue", "매출 2억원 이상", { min_krw: 200_000_000 })]),
  matched("revenue-3", "2026-09-30", [numericCriterion("revenue", "매출 3억원 이상", { min_krw: 300_000_000 })]),
  matched("tax-1", "2026-07-15", [{
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    source_span: "국세·지방세 체납기업 제외",
    value: { flags: ["national_tax_delinquent", "local_tax_delinquent"] },
  }]),
];

const planned = planProfileQuestions(matches, { asOf, limit: 3 });
assert.equal(planned[0]?.question.dimension, "revenue", "여러 공고를 해소하는 질문이 먼저여야 한다");
assert.equal(planned[0]?.question.affectedGrantCount, 3);
assert.equal(planned[0]?.resolvesGrantCount, 3);
assert.equal(planned[0]?.question.inputType, "select");
assert.equal(planned[0]?.question.responseStage, "range");
assert.equal(planned[0]?.question.rangeOptions?.length, 7);
assert.equal(planned[0]?.definitionId, "profile.revenue.v1");
assert.equal(planned[0]?.question.definitionId, "profile.revenue.v1");
assert.equal(planned[0]?.question.unit, "krw");
assert.deepEqual(planned[0]?.criterionThresholds, [
  { field: "min_krw", operator: "gte", value: 100_000_000, unit: "krw", affectedGrantCount: 1 },
  { field: "min_krw", operator: "gte", value: 200_000_000, unit: "krw", affectedGrantCount: 1 },
  { field: "min_krw", operator: "gte", value: 300_000_000, unit: "krw", affectedGrantCount: 1 },
]);
assert.equal(planned[1]?.question.dimension, "tax_compliance");
assert.equal(planned[1]?.question.inputType, "checklist");
assert.match(planned[1]?.question.framing ?? "", /자격 확인에만 사용/);

const malformed = matched("malformed", "2026-07-20", [{
  dimension: "biz_age",
  operator: "lte",
  kind: "required",
  confidence: 0.5,
  source_span: "창업기업 대상",
  value: { labels: ["창업기업"] },
}]);
const textOnly = matched("text-only", "2026-07-20", [{
  dimension: "industry",
  operator: "text_only",
  kind: "required",
  confidence: 0.5,
  source_span: "특수산업 실적 보유기업",
  value: { note: "원문 검토 필요" },
}]);
assert.equal(planProfileQuestions([malformed, textOnly], { asOf }).length, 0);

const mixedRevenueCriteria = matched("mixed-revenue", "2026-07-20", [
  numericCriterion("revenue", "매출 1억원 이상", { min_krw: 100_000_000 }),
  {
    dimension: "revenue",
    operator: "text_only",
    kind: "required",
    confidence: 0.5,
    source_span: "최근 매출 실적은 원문 확인 필요",
    value: { note: "원문 확인 필요" },
  },
]);
mixedRevenueCriteria.match = matchGrantCriteria(mixedRevenueCriteria.item.criteria, company, {
  asOf,
  extractionManifest: {
    grantId: "kstartup:mixed-revenue",
    revision: "r1",
    sourceFieldsSeen: ["revenue"],
    attachmentsExpected: 0,
    attachmentsFetched: 0,
    attachmentsConverted: 0,
    sectionsDetected: ["required"],
    extractorVersion: "test",
    completedAt: asOf.toISOString(),
    warnings: [],
    readiness: "reviewed",
    reviewedAt: asOf.toISOString(),
  },
});
const mixedRevenuePlan = planProfileQuestions([mixedRevenueCriteria], { asOf });
assert.equal(mixedRevenuePlan[0]?.question.dimension, "revenue");
assert.equal(
  mixedRevenuePlan[0]?.resolvesGrantCount,
  0,
  "같은 축에 non-resolvable hard unknown이 남으면 답변 하나로 공고 판정을 확정한다고 계산하면 안 된다",
);
assert.doesNotMatch(mixedRevenuePlan[0]?.question.framing ?? "", /판정을 확정/);

const extractionIncomplete = matched("extraction-incomplete", "2026-07-20", [numericCriterion(
  "revenue",
  "매출 1억원 이상",
  { min_krw: 100_000_000 },
)]);
extractionIncomplete.match = matchGrantCriteria(extractionIncomplete.item.criteria, company, {
  extractionManifest: {
    grantId: "kstartup:extraction-incomplete",
    revision: "r1",
    sourceFieldsSeen: ["revenue"],
    attachmentsExpected: 1,
    attachmentsFetched: 0,
    attachmentsConverted: 0,
    sectionsDetected: ["required"],
    extractorVersion: "test",
    completedAt: "2026-07-12T00:00:00.000Z",
    warnings: ["attachment_fetch_incomplete"],
    readiness: "partial",
  },
});
assert.equal(
  planProfileQuestions([extractionIncomplete], { asOf }).length,
  0,
  "공고 추출 미완료를 기업 질문으로 떠넘기지 않는다",
);

const ineligible = matched("ineligible", "2026-07-13", [{
  dimension: "region",
  operator: "in",
  kind: "required",
  confidence: 0.9,
  source_span: "서울 소재 기업",
  value: { regions: ["11"], labels: ["서울"] },
}, numericCriterion("employees", "상시근로자 5명 이상", { min: 5 })]);
assert.equal(planProfileQuestions([ineligible], { asOf }).length, 0, "이미 hard-fail인 공고는 질문 가치에서 제외한다");

const industryOnly = matched("industry-only", "2026-07-18", [{
  dimension: "industry",
  operator: "in",
  kind: "required",
  confidence: 0.9,
  source_span: "게임 분야 기업",
  value: { industries: ["게임"], labels: ["게임"] },
}]);
const industryPlan = planProfileQuestions([industryOnly], { asOf });
assert.equal(industryPlan[0]?.question.dimension, "industry");
assert.equal(industryPlan[0]?.question.affectedGrantCount, 1);
assert.equal(industryPlan[0]?.resolvesGrantCount, 0, "단일 positive-only 응답은 전체 업종 목록을 소진하지 않는다");

const priorAwardCompany: CompanyProfile = { confidence: {} };
const priorAwardCriteria: GrantCriterion[] = [{
  dimension: "prior_award",
  operator: "exists",
  kind: "exclusion",
  confidence: 0.95,
  source_span: "현재 유사 정부지원사업 중복 수행 기업 제외",
  value: { scope: "self", self_kind: "current_similar" },
}];
const priorAwardMatches = [
  matchedForCompany("prior-self-1", priorAwardCriteria, priorAwardCompany),
  matchedForCompany("prior-self-2", priorAwardCriteria, priorAwardCompany),
  matchedForCompany("prior-program", [{
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    confidence: 0.95,
    source_span: "초기창업패키지 기수혜 기업 제외",
    value: { scope: "program", programs: ["chogi_startup_package"], states: ["completed"] },
  }], priorAwardCompany),
];
const priorAwardPlan = planProfileQuestions(priorAwardMatches, { asOf, limit: 2 });
assert.equal(priorAwardPlan[0]?.question.dimension, "prior_award");
assert.equal(priorAwardPlan[0]?.question.inputType, "boolean");
assert.equal(priorAwardPlan[0]?.question.affectedGrantCount, 2, "같은 self 범위만 한 질문으로 묶는다");
assert.deepEqual(priorAwardPlan[0]?.question.priorAwardContext, {
  scope: "self",
  selfKind: "current_similar",
  channel: "general",
  requiresYear: false,
});

const selfAnswered = updateCompanyProfileField(priorAwardCompany, {
  field: "prior_award",
  value: { self_flags: { current_similar: false } },
});
const afterSelf = priorAwardMatches.map((entry) => ({
  item: entry.item,
  match: matchGrantCriteria(entry.item.criteria, selfAnswered, { asOf }),
}));
assert.equal(afterSelf[0]?.match.eligibility, "eligible");
assert.equal(afterSelf[1]?.match.eligibility, "eligible");
const nextPriorAward = planProfileQuestions(afterSelf, { asOf, limit: 1 })[0]?.question;
assert.deepEqual(nextPriorAward?.priorAwardContext, {
  scope: "program",
  programs: ["chogi_startup_package"],
  states: ["completed"],
  requiresYear: false,
});

console.log(JSON.stringify({
  ok: true,
  checked: [
    "question_planner_multi_grant_value",
    "question_planner_resolution_count",
    "question_planner_disqualification_framing",
    "question_planner_skips_unstructured",
    "question_planner_mixed_same_dimension_not_overclaimed",
    "question_planner_skips_extraction_incomplete",
    "question_planner_skips_ineligible",
    "question_planner_positive_only_not_resolved",
    "question_planner_prior_award_context_partition",
    "question_planner_prior_award_sequential_known_gate",
  ],
  planned: planned.map((item) => ({
    dimension: item.question.dimension,
    score: item.score,
    affectedGrantCount: item.question.affectedGrantCount,
    resolvesGrantCount: item.resolvesGrantCount,
  })),
}, null, 2));

function numericCriterion(
  dimension: "revenue" | "employees",
  sourceSpan: string,
  value: Record<string, number>,
): GrantCriterion {
  return {
    dimension,
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    source_span: sourceSpan,
    value,
  };
}

function matchedForCompany(
  sourceId: string,
  criteria: GrantCriterion[],
  companyValue: CompanyProfile,
): MatchedGrant<Record<string, unknown>> {
  const item = normalizedGrant(sourceId, "2026-08-31", criteria);
  return { item, match: matchGrantCriteria(criteria, companyValue, { asOf }) };
}

function matched(
  sourceId: string,
  applyEnd: string,
  criteria: GrantCriterion[],
): MatchedGrant<Record<string, unknown>> {
  const item = normalizedGrant(sourceId, applyEnd, criteria);
  return { item, match: matchGrantCriteria(criteria, company) };
}

function normalizedGrant(
  sourceId: string,
  applyEnd: string,
  criteria: GrantCriterion[],
): NormalizedGrant<Record<string, unknown>> {
  const grant: Grant = {
    source: "kstartup",
    source_id: sourceId,
    title: sourceId,
    status: "open",
    apply_end: applyEnd,
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.8,
  };
  return {
    raw: { source: "kstartup", source_id: sourceId, payload: {}, status: "normalized" },
    grant,
    criteria,
  };
}
