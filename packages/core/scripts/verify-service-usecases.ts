import assert from "node:assert/strict";
import type {
  CompanyProfile,
  Grant,
  GrantCriterion,
  NormalizedGrant,
} from "@cunote/contracts";
import {
  buildApplySheet,
  buildDashboard,
  buildNotificationFeed,
  calculateMatchTransitionWindow,
  deriveGrantBenefits,
  matchGrantCriteria,
  selectMatchCards,
  updateCompanyProfileField,
} from "../src/index.js";

const asOf = new Date("2026-06-01T00:00:00.000Z");
const company: CompanyProfile = {
  name: "업력 로드맵 테스트 기업",
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

const tooOldGrant = normalizedGrant("too-old-biz-age", "업력 6개월 이내 지원사업", [
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
    value: { max_months: 6, include_preliminary: true, labels: ["6개월 이내"] },
    confidence: 0.9,
  },
]);

const dashboard = buildDashboard({
  company,
  grants: [soonGrant, tooOldGrant],
  asOf,
  limit: 10,
});

const soonMatch = dashboard.matches.find((match) => match.sourceId === soonGrant.grant.source_id);
assert.ok(soonMatch, "soon match should exist");
assert.equal(soonMatch.eligibility, "ineligible");
assert.equal(soonMatch.bucket, "soon");

const soonTrace = soonMatch.ruleTrace.find((trace) => trace.dimension === "biz_age");
assert.equal(soonTrace?.unlock?.kind, "time");
assert.equal(soonTrace?.unlock?.etaDate, "2026-08-01");
const soonTransition = calculateMatchTransitionWindow(matchGrantCriteria(soonGrant.criteria, company), { asOf });
assert.equal(soonTransition.eligibleFrom?.toISOString().slice(0, 10), "2026-08-01");
assert.equal(soonTransition.eligibleUntil, null);

const soonRoadmapNode = dashboard.roadmap.find((node) => node.grantId === soonMatch.grantId);
assert.equal(soonRoadmapNode?.bucket, "soon");
assert.equal(soonRoadmapNode?.unlock?.kind, "time");
assert.equal(soonRoadmapNode?.unlock?.etaDate, "2026-08-01");

const tooOldMatch = dashboard.matches.find((match) => match.sourceId === tooOldGrant.grant.source_id);
assert.ok(tooOldMatch, "too old match should exist");
assert.equal(tooOldMatch.eligibility, "ineligible");
assert.equal(tooOldMatch.bucket, "preparable");
assert.equal(
  tooOldMatch.ruleTrace.find((trace) => trace.dimension === "biz_age")?.unlock,
  undefined,
);

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
const closingTransition = calculateMatchTransitionWindow(matchGrantCriteria(closingGrant.criteria, company), { asOf });
assert.equal(closingTransition.eligibleFrom, null);
assert.equal(closingTransition.eligibleUntil?.toISOString().slice(0, 10), "2026-09-01");

const sheet = buildApplySheet({
  entry: {
    item: soonGrant,
    match: matchGrantCriteria(soonGrant.criteria, company),
  },
  company,
  asOf,
});
assert.equal(sheet.needsCheck.find((trace) => trace.dimension === "biz_age")?.unlock?.etaDate, "2026-08-01");
assert.equal(sheet.applicationPrep.autoSubmitSupported, false);
assert.ok(
  sheet.applicationPrep.profileCopyFields.some((field) => field.label === "소재지" && field.value === "경기"),
  "apply sheet should expose copyable company profile fields",
);
assert.equal(
  sheet.applicationPrep.profileCopyFields.some((field) => field.value.includes("null")),
  false,
  "apply sheet should not expose null values as copyable text",
);
assert.ok(
  sheet.applicationPrep.planDraftPrompts.some((prompt) => prompt.evidence.includes("경기 대상 - 귀사 경기")),
  "apply sheet should expose business-plan prompt evidence",
);
assert.equal(sheet.grant.benefits.some((benefit) => benefit.family === "funding"), true);
assert.equal(dashboard.matches.some((match) => match.benefits.some((benefit) => benefit.family === "funding")), true);

const marketBenefits = deriveGrantBenefits({
  ...soonGrant.grant,
  title: "글로벌 판로개척 팝업 지원사업",
  support_amount: null,
});
assert.equal(marketBenefits.some((benefit) => benefit.family === "market"), true);

const expandedProfile = [
  { field: "revenue" as const, value: 100_000_000 },
  { field: "employees" as const, value: 12 },
  { field: "ip" as const, value: ["특허"] },
  { field: "target_type" as const, value: ["법인"] },
].reduce((profile, update) => updateCompanyProfileField(profile, {
  ...update,
  confidence: 0.9,
}), company);
const expandedGrant = normalizedGrant("expanded-profile", "확장 프로필 조건 지원사업", [
  {
    dimension: "revenue",
    operator: "lte",
    kind: "required",
    value: { max_krw: 120_000_000 },
    confidence: 0.9,
  },
  {
    dimension: "employees",
    operator: "between",
    kind: "required",
    value: { min: 5, max: 50 },
    confidence: 0.9,
  },
  {
    dimension: "ip",
    operator: "exists",
    kind: "required",
    value: { types: ["특허"] },
    confidence: 0.9,
  },
  {
    dimension: "target_type",
    operator: "in",
    kind: "required",
    value: { targets: ["법인"] },
    confidence: 0.9,
  },
]);
const expandedMatch = matchGrantCriteria(expandedGrant.criteria, expandedProfile);
assert.equal(expandedMatch.eligibility, "eligible");
assert.deepEqual(expandedMatch.unknown_fields, []);
assert.equal(expandedProfile.revenue_krw, 100_000_000);
assert.equal(expandedProfile.employees_count, 12);
assert.deepEqual(expandedProfile.ip, ["특허"]);
assert.deepEqual(expandedProfile.target_types, ["법인"]);

const selectableDashboard = buildDashboard({
  company: expandedProfile,
  grants: [soonGrant, tooOldGrant, expandedGrant],
  asOf,
  limit: 10,
});
const eligibleSelection = selectMatchCards(selectableDashboard.matches, {
  status: "eligible",
  sort: "amount",
  limit: 2,
});
assert.equal(eligibleSelection.total, 1);
assert.equal(eligibleSelection.matches[0]?.sourceId, expandedGrant.grant.source_id);
assert.equal(eligibleSelection.hasMore, false);

const firstPage = selectMatchCards(selectableDashboard.matches, {
  sort: "fit",
  limit: 1,
});
assert.equal(firstPage.matches.length, 1);
assert.equal(firstPage.hasMore, true);
assert.equal(firstPage.cursor, "1");
const secondPage = selectMatchCards(selectableDashboard.matches, {
  sort: "fit",
  cursor: firstPage.cursor,
  limit: 1,
});
assert.equal(secondPage.matches.length, 1);
assert.notEqual(secondPage.matches[0]?.grantId, firstPage.matches[0]?.grantId);

const industryQuestionGrant = normalizedGrant("industry-question", "업종 확인 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
  {
    dimension: "industry",
    operator: "in",
    kind: "required",
    value: { tags: ["바이오"] },
    confidence: 0.9,
  },
]);
const industryQuestionDashboard = buildDashboard({
  company: { ...company, industries: [] },
  grants: [industryQuestionGrant],
  asOf,
  limit: 10,
});
assert.equal(industryQuestionDashboard.nextQuestion?.dimension, "industry");
assert.equal(industryQuestionDashboard.nextQuestion?.inputType, "select");
assert.equal(industryQuestionDashboard.nextQuestion?.options?.includes("바이오"), true);
const enrichAction = industryQuestionDashboard.actionQueue.find((action) => action.kind === "enrich");
assert.ok(enrichAction, "enrich action should be generated for enrichable unknown fields");
assert.equal(enrichAction.target, "#company-settings");

const deadlineGrant = normalizedGrant("deadline-soon", "마감임박 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
]);
deadlineGrant.grant.apply_end = "2026-06-03";
const notificationDashboard = buildDashboard({
  company: { ...company, industries: [] },
  grants: [deadlineGrant, soonGrant, industryQuestionGrant],
  asOf,
  limit: 10,
});
const notificationFeed = buildNotificationFeed({
  matches: notificationDashboard.matches,
  asOf,
});
assert.equal(notificationFeed.generatedAt, asOf.toISOString());
assert.equal(notificationFeed.notifications.some((item) => item.kind === "deadline" && item.priority === "high"), true);
assert.equal(notificationFeed.notifications.some((item) => item.kind === "soon_eligible" && item.etaDate === "2026-08-01"), true);
assert.equal(notificationFeed.notifications.some((item) => item.kind === "needs_input" && item.target === "profile:industry"), true);

const priorAwardQuestionGrant = normalizedGrant("prior-award-question", "중복수혜 자가신고 지원사업", [
  {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.95,
  },
  {
    dimension: "prior_award",
    operator: "not_in",
    kind: "exclusion",
    value: { programs: ["TIPS"] },
    confidence: 0.9,
    source_span: "TIPS 기선정 기업 제외",
  },
]);
const priorAwardQuestionDashboard = buildDashboard({
  company,
  grants: [priorAwardQuestionGrant],
  asOf,
  limit: 10,
});
assert.equal(priorAwardQuestionDashboard.nextQuestion?.dimension, "prior_award");
assert.equal(priorAwardQuestionDashboard.nextQuestion?.inputType, "select");
assert.deepEqual(priorAwardQuestionDashboard.nextQuestion?.options, ["해당 없음", "TIPS"]);

const noPriorAwardProfile = updateCompanyProfileField(company, {
  field: "prior_award",
  value: [],
  confidence: 0.9,
});
const noPriorAwardMatch = matchGrantCriteria(priorAwardQuestionGrant.criteria, noPriorAwardProfile);
assert.equal(noPriorAwardMatch.eligibility, "eligible");
assert.deepEqual(noPriorAwardProfile.prior_awards, []);
assert.equal(noPriorAwardProfile.confidence?.prior_award, 0.9);

const tipsAwardProfile = updateCompanyProfileField(company, {
  field: "prior_award",
  value: ["TIPS"],
  confidence: 0.9,
});
const tipsAwardMatch = matchGrantCriteria(priorAwardQuestionGrant.criteria, tipsAwardProfile);
assert.equal(tipsAwardMatch.eligibility, "ineligible");
assert.equal(tipsAwardMatch.rule_trace.find((trace) => trace.dimension === "prior_award")?.result, "fail");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "biz_age_min_match",
    "soon_bucket",
    "roadmap_time_unlock",
    "match_state_eligible_from",
    "match_state_eligible_until",
    "benefit_badge_funding",
    "benefit_badge_market",
    "apply_sheet_unlock",
    "apply_sheet_profile_copy",
    "apply_sheet_plan_prompts",
    "expanded_profile_field_update",
    "expanded_profile_match",
    "match_selector_filter_sort",
    "match_selector_cursor",
    "next_question_select_options",
    "action_queue_enrich",
    "notification_feed_deadline",
    "notification_feed_soon_eligible",
    "notification_feed_needs_input",
    "prior_award_next_question_options",
    "prior_award_none_self_report",
    "prior_award_exclusion_self_report",
  ],
  soon: {
    bucket: soonMatch.bucket,
    etaDate: soonTrace?.unlock?.etaDate,
    eligibleFrom: soonTransition.eligibleFrom?.toISOString(),
  },
  tooOld: {
    bucket: tooOldMatch.bucket,
  },
  closing: {
    eligibleUntil: closingTransition.eligibleUntil?.toISOString(),
  },
  expanded: {
    eligibility: expandedMatch.eligibility,
    fitScore: expandedMatch.fit_score,
  },
  priorAward: {
    noneEligibility: noPriorAwardMatch.eligibility,
    tipsEligibility: tipsAwardMatch.eligibility,
  },
  notifications: notificationFeed.notifications.map((item) => item.kind),
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
    criteria,
  };
}
