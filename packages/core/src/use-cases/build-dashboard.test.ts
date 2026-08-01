import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { buildDashboard } from "./build-dashboard.js";

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

console.log("build-dashboard confirmations: ok");
