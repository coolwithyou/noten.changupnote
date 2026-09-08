import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { buildDashboard } from "./build-dashboard.js";
import { buildTeaser } from "./build-teaser.js";
import { buildInitialCompanyMatch } from "./build-initial-company-match.js";
import { planMatchStateRefresh } from "./plan-match-state-refresh.js";
import { evaluateProfileUpdateImpact } from "./evaluate-profile-update-impact.js";

const grantId = "00000000-0000-4000-8000-000000000099";
const criterionId = "00000000-0000-4000-8000-000000000100";
const company: CompanyProfile = {};
const grants: Array<NormalizedGrant<Record<string, never>>> = [{
  grant: {
    id: grantId,
    source: "bizinfo",
    source_id: "PBLN_TEST_CONFIRMATION",
    title: "기수혜 확인 공고",
    agency_primary: "테스트기관",
    category_l1: "사업화",
    category_l2: null,
    support_amount: { unit: "KRW", per: "기업" },
    apply_start: "2026-07-01",
    apply_end: "2026-07-31",
    status: "open",
    apply_method: {},
    url: null,
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    f_authoring_mode: "unknown",
    benefits: [],
    overall_confidence: 1,
  },
  criteria: [{
    id: criterionId,
    grant_id: grantId,
    dimension: "prior_award",
    kind: "exclusion",
    operator: "exists",
    value: { scope: "self", self_kind: "current_similar", channel: "general" },
    confidence: 1,
    source_span: "동일·유사 정부지원사업 수행 기업은 제외한다.",
  }],
  extraction_manifest: {
    grantId,
    revision: "test-revision",
    sourceFieldsSeen: ["criteria"],
    attachmentsExpected: 0,
    attachmentsFetched: 0,
    attachmentsConverted: 0,
    sectionsDetected: ["eligibility"],
    extractorVersion: "test",
    completedAt: "2026-07-25T00:00:00.000Z",
    warnings: [],
    readiness: "reviewed",
    reviewedAt: "2026-07-25T00:00:00.000Z",
  },
  raw: {
    source: "bizinfo",
    source_id: "PBLN_TEST_CONFIRMATION",
    collected_at: "2026-07-25T00:00:00.000Z",
    payload: {},
    status: "published",
  },
}];

const before = buildDashboard({ company, grants });
assert.equal(before.counts.conditional, 1);

// 현재 시각과 무관하게 2026년/2030년 기준 수혜기간을 모든 제품 경로가 같은 방식으로 판정한다.
const periodGrant = structuredClone(grants[0]!);
periodGrant.criteria[0] = {
  ...periodGrant.criteria[0]!,
  operator: "in",
  value: { scope: "program", programs: ["chogi_startup_package"], within: { value: 3, unit: "year" } },
  source_span: "최근 3년 이내 초기창업패키지 수혜기업 제외",
};
const awardedCompany: CompanyProfile = {
  prior_award_history: {
    records: [{ program: "초기창업패키지", state: "completed", year: 2025 }],
    known_programs: ["chogi_startup_package"],
    known_program_types: [],
  },
  confidence: { prior_award: 0.6 },
};
for (const [year, expected] of [[2026, "ineligible"], [2030, "eligible"]] as const) {
  const asOf = new Date(`${year}-07-01T00:00:00.000Z`);
  const context = { company: awardedCompany, grants: [periodGrant], asOf };
  assert.equal(buildDashboard(context).matches[0]?.eligibility, expected, `dashboard ${year}`);
  assert.equal(buildInitialCompanyMatch(context).matches[0]?.eligibility, expected, `initial ${year}`);
  assert.equal(planMatchStateRefresh(context).states[0]?.eligibility, expected, `refresh ${year}`);
  assert.equal(buildTeaser(context).counts[expected], 1, `teaser ${year}`);
  const impact = evaluateProfileUpdateImpact({
    grants: [periodGrant], beforeProfile: {}, afterProfile: awardedCompany, dimension: "prior_award", asOf,
  });
  assert.equal(impact.transitionCounts[`conditional_to_${expected}`], 1, `impact ${year}`);
}

const confirmationsByGrantId = new Map([[grantId, [{ criterion_id: criterionId, disqualified: false }]]]);
const updatedCompany: CompanyProfile = { revenue_krw: 10_000_000, confidence: { revenue: 0.6 } };
const confirmedContext = { grants, company: updatedCompany, confirmationsByGrantId };
const ownedTeaser = buildTeaser({ ...confirmedContext, asOf: new Date("2026-07-15T00:00:00Z") });
assert.equal(ownedTeaser.matches[0]?.eligibility, "eligible");
assert.equal(ownedTeaser.matches[0]?.userConfirmedCount, 1);
assert.equal(ownedTeaser.counts.openNow, 1);
assert.equal(ownedTeaser.nextQuestion, null);
assert.equal(buildTeaser({ company, grants }).counts.conditional, 1, "익명 티저에 소유 회사 확인 답변을 흘리지 않는다");
assert.equal(buildInitialCompanyMatch(confirmedContext).matches[0]?.eligibility, "eligible",
  "다른 프로필 답변 뒤에도 공고별 기존 확인 답변을 유지한다");
assert.equal(planMatchStateRefresh(confirmedContext).states[0]?.eligibility, "eligible");
const unchangedConfirmation = evaluateProfileUpdateImpact({
  grants, beforeProfile: {}, afterProfile: updatedCompany, dimension: "revenue", confirmationsByGrantId,
});
assert.equal(unchangedConfirmation.transitionCounts.eligible_to_eligible, 1);
assert.equal(unchangedConfirmation.changedMatchStateCount, 0);

const unpersistedGrant = structuredClone(grants[0]!);
delete unpersistedGrant.grant.id;
const sourceKeyConfirmation = buildDashboard({
  company,
  grants: [unpersistedGrant],
  confirmationsByGrantId: new Map([[`bizinfo:${unpersistedGrant.grant.source_id}`, [{ criterion_id: criterionId, disqualified: false }]]]),
});
assert.equal(sourceKeyConfirmation.matches[0]?.eligibility, "eligible", "확인 답변 키는 공고 ID가 없는 경로에서도 grantKey와 일치한다");

const opsReviewGrant = structuredClone(grants[0]!);
opsReviewGrant.grant.id = "00000000-0000-4000-8000-000000000098";
opsReviewGrant.grant.source_id = "PBLN_TEST_OPS_REVIEW";
opsReviewGrant.grant.title = "OPS 자동 검수 대기 공고";
opsReviewGrant.criteria[0]!.id = "00000000-0000-4000-8000-000000000097";
opsReviewGrant.criteria[0]!.grant_id = opsReviewGrant.grant.id;
opsReviewGrant.extraction_manifest = {
  ...opsReviewGrant.extraction_manifest!,
  grantId: opsReviewGrant.grant.id,
  revision: "test-ops-review-revision",
  readiness: "partial",
  reviewedAt: null,
};
const servingBoundary = buildDashboard({ company, grants: [...grants, opsReviewGrant] });
assert.equal(servingBoundary.matches.length, 1, "OPS 검수 대기 공고를 대시보드 카드에 노출하면 안 된다");
assert.equal(servingBoundary.matches[0]?.sourceId, "PBLN_TEST_CONFIRMATION");
assert.equal(servingBoundary.counts.conditional, 1, "사용자 대시보드 건수는 서빙 가능한 공고만 집계해야 한다");
assert.equal(servingBoundary.counts.needsCoreReview, 0);
assert.equal(servingBoundary.nextQuestion?.affectedGrantCount, 1, "숨긴 공고가 대시보드 질문을 만들면 안 된다");

const confirmedPass = buildDashboard({
  company,
  grants,
  confirmationsByGrantId: new Map([[
    grantId,
    [{ criterion_id: criterionId, disqualified: false }],
  ]]),
});
assert.equal(confirmedPass.counts.eligible, 1);
assert.equal(confirmedPass.matches[0]?.userConfirmedCount, 1);

const confirmedFail = buildDashboard({
  company,
  grants,
  confirmationsByGrantId: new Map([[
    grantId,
    [{ criterion_id: criterionId, disqualified: true }],
  ]]),
});
assert.equal(confirmedFail.counts.ineligible, 1);
assert.equal(confirmedFail.matches[0]?.ruleTrace[0]?.result, "fail");

const hardFailedWithUnknownGrant = structuredClone(grants[0]!);
hardFailedWithUnknownGrant.criteria.push({
  id: "00000000-0000-4000-8000-000000000101",
  grant_id: grantId,
  dimension: "founder_trait",
  kind: "required",
  operator: "in",
  value: { labels: ["여성"] },
  confidence: 1,
  source_span: "여성 대표 기업만 신청할 수 있다.",
});
const hardFailedWithUnknown = buildDashboard({
  company,
  grants: [hardFailedWithUnknownGrant],
  confirmationsByGrantId: new Map([[
    grantId,
    [{ criterion_id: criterionId, disqualified: true }],
  ]]),
});
assert.equal(
  hardFailedWithUnknown.matches[0]?.ruleTrace.some((trace) => trace.result === "unknown"),
  true,
  "확정 탈락 공고에도 미확인 조건은 남을 수 있다",
);
assert.equal(
  hardFailedWithUnknown.actionQueue.length,
  0,
  "확정 탈락 공고의 미확인 조건을 사용자 행동으로 만들면 안 된다",
);

const reviewedQuestionGrant = structuredClone(grants[0]!);
reviewedQuestionGrant.grant.id = "00000000-0000-4000-8000-000000000096";
reviewedQuestionGrant.grant.source_id = "PBLN_REVIEWED_REQUIRED_QUESTION";
reviewedQuestionGrant.criteria = [{
  id: "00000000-0000-4000-8000-000000000095",
  grant_id: reviewedQuestionGrant.grant.id,
  dimension: "other",
  kind: "required",
  operator: "text_only",
  value: { note: "공고별 협약 이행 가능 여부" },
  confidence: 0.95,
  source_span: "신청 시 협약 이행 가능 여부를 확인한다.",
}];
reviewedQuestionGrant.extraction_manifest = {
  ...reviewedQuestionGrant.extraction_manifest!,
  grantId: reviewedQuestionGrant.grant.id,
  warnings: ["text_only_criterion_present"],
  readiness: "partial",
};
assert.equal(
  buildTeaser({ company, grants: [reviewedQuestionGrant] }).matches.length,
  0,
  "질문 결속 없는 required text_only는 기존 OPS gate에서 숨긴다",
);
const reviewedQuestionTeaser = buildTeaser({
  company,
  grants: [reviewedQuestionGrant],
  confirmationQuestionBindingsByGrantId: new Map([[
    reviewedQuestionGrant.grant.id!,
    [{
      criterionId: reviewedQuestionGrant.criteria[0]!.id!,
      contractVersion: "confirmation-evaluation-v2",
      evaluationKind: "three_state_single",
      resolutionScope: "per_notice",
      reviewState: "analysis_launch_independent_review",
      runId: "run-reviewed-question",
      currentSourceBindingVerified: true,
    }],
  ]]),
});
assert.equal(reviewedQuestionTeaser.matches.length, 1);
assert.equal(reviewedQuestionTeaser.matches[0]?.recommendationTier, "needs_profile_input");
assert.equal(reviewedQuestionTeaser.counts.needsCoreReview, 0);

console.log("build-dashboard confirmations: ok");
