import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { updateCompanyProfileField } from "../company/update-profile-field.js";
import { markProfileQuestionUnknown } from "../company/question-answer-state.js";
import { buildInitialCompanyMatch } from "./build-initial-company-match.js";
import { buildTeaser } from "./build-teaser.js";
import { evaluateProfileUpdateImpact } from "./evaluate-profile-update-impact.js";
import { daysUntil } from "./match-card.js";

assert.equal(daysUntil("2026-07-15", new Date("2026-07-14T14:59:59.000Z")), 1);
assert.equal(daysUntil("2026-07-15", new Date("2026-07-14T15:00:00.000Z")), 0);

const beforeProfile: CompanyProfile = { confidence: {} };
const grants = Array.from({ length: 60 }, (_, index) => ageGrant(
  `age-${String(index).padStart(2, "0")}`,
  index < 30 ? 20 : 40,
  index < 30 ? 39 : 59,
));

const before = buildInitialCompanyMatch({
  company: beforeProfile,
  grants,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 12,
});
assert.equal(before.evaluatedGrantCount, 60);
assert.equal(before.counts.conditional, 60);
assert.equal(before.nextQuestion?.dimension, "founder_age");
assert.equal(before.nextQuestion?.affectedGrantCount, 60);

const teaserBefore = buildTeaser({
  company: beforeProfile,
  grants,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 8,
});
assert.equal(teaserBefore.searchContext?.evaluatedGrantCount, 60);
assert.equal(teaserBefore.matches.length, 8, "teaser 카드 제한이 평가 universe를 제한하면 안 된다");
assert.equal(teaserBefore.nextQuestion?.dimension, "founder_age");
assert.equal(teaserBefore.nextQuestion?.affectedGrantCount, 60);
assert.equal(teaserBefore.recommendableMatches?.length, 0);
assert.equal(teaserBefore.reviewNeededMatches?.length, 8, "추천 버킷이 비면 검토 필요 카드가 전체 제한을 채워야 한다");
assert.equal(teaserBefore.counts.needsProfileInput, 60, "프로필 입력 필요 전체 수는 visible quota와 분리되어야 한다");
assert.equal(teaserBefore.counts.oneAnswer, 60);
assert.equal(teaserBefore.counts.needsCoreReview, 0);

const mixedBuckets = buildTeaser({
  company: { founder_age: 30, confidence: { founder_age: 1 } },
  grants: [
    ...Array.from({ length: 8 }, (_, index) => ageGrant(`recommendable-${index}`, 20, 39)),
    ...Array.from({ length: 8 }, (_, index) => revenueGrant(`review-${index}`)),
  ],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 8,
});
assert.equal(mixedBuckets.matches.length, 8);
assert.equal(mixedBuckets.recommendableMatches?.length, 5, "추천 카드가 검토 필요 버킷을 전부 잠식하면 안 된다");
assert.equal(mixedBuckets.reviewNeededMatches?.length, 3, "검토 필요 후보가 있으면 기본 3개를 노출해야 한다");
assert.equal(mixedBuckets.counts.needsProfileInput, 8);
assert.equal(mixedBuckets.counts.oneAnswer, 8);

const multipleAnswersNeeded = buildTeaser({
  company: beforeProfile,
  grants: [multiAnswerGrant("multi-answer")],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(multipleAnswersNeeded.counts.needsProfileInput, 1);
assert.equal(multipleAnswersNeeded.counts.oneAnswer, 0, "두 축이 비었으면 답변 하나로 확정된다고 약속하면 안 됨");
assert.equal(multipleAnswersNeeded.counts.preparable, 1);

const upcomingGrant = ageGrant("upcoming", 20, 39);
upcomingGrant.grant.status = "upcoming";
const upcomingTeaser = buildTeaser({
  company: { founder_age: 30, confidence: { founder_age: 1 } },
  grants: [upcomingGrant],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(upcomingTeaser.counts.recommendable, 1);
assert.equal(upcomingTeaser.counts.openNow, 0, "접수 예정 공고는 지금 신청 가능 수치에 포함하면 안 됨");
assert.equal(upcomingTeaser.recommendableMatches?.length, 1, "접수 예정 추천 공고도 Programs 노출 후보에 포함해야 함");
assert.equal(upcomingTeaser.matches.length, 1);
assert.equal(upcomingTeaser.matches[0]?.status, "upcoming");

const unknownProfile = markProfileQuestionUnknown({
  profile: beforeProfile,
  dimension: "founder_age",
  answeredAt: new Date("2026-07-12T00:00:00.000Z"),
  ttlDays: 30,
});
const afterUnknown = buildInitialCompanyMatch({
  company: unknownProfile,
  grants,
  asOf: new Date("2026-07-13T00:00:00.000Z"),
  limit: 12,
});
assert.equal(afterUnknown.counts.conditional, 60, "모름은 matching known 근거가 아니어야 한다");
assert.equal(afterUnknown.nextQuestion, null, "TTL 동안 같은 축 질문을 반복하면 안 된다");
assert.equal(buildTeaser({
  company: unknownProfile,
  grants,
  asOf: new Date("2026-07-13T00:00:00.000Z"),
}).nextQuestion, null, "teaser도 모름 TTL 동안 같은 축 질문을 반복하면 안 된다");

const afterProfile = updateCompanyProfileField(unknownProfile, {
  field: "founder_age",
  value: 30,
  confidence: 0.6,
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf: "2026-07-12T00:00:00.000Z",
});
assert.equal(afterProfile.profile_evidence?.founder_age?.sourceKind, "self_declared");
assert.equal(afterProfile.profile_evidence?.founder_age?.axisCompleteness, "complete");
assert.equal(afterProfile.question_answer_state?.founder_age, undefined, "실제 답변은 unknown 상태를 해제해야 한다");
const impact = evaluateProfileUpdateImpact({
  grants,
  beforeProfile,
  afterProfile,
  dimension: "founder_age",
  windowLimit: grants.length,
});
assert.equal(impact.evaluatedGrantCount, 60, "질문 영향도는 화면 40건이 아닌 전체 universe를 평가해야 한다");
assert.equal(impact.targetedConditionalCount, 60);
assert.equal(impact.dimensionResolvedGrantCount, 60);
assert.equal(impact.conditionalToEligibleCount, 30);
assert.equal(impact.conditionalToIneligibleCount, 30);
assert.equal(impact.conditionalResolutionRate, 1);

const after = buildInitialCompanyMatch({
  company: afterProfile,
  grants,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  limit: 12,
});
assert.equal(after.counts.eligible, 30);
assert.equal(after.counts.ineligible, 30);
assert.equal(after.counts.conditional, 0);
assert.equal(after.nextQuestion, null);

console.log("first-mission-flow: ok");

function ageGrant(sourceId: string, min: number, max: number): NormalizedGrant<Record<string, never>> {
  return {
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: `대표자 ${min}-${max}세 지원사업`,
      status: "open",
      apply_start: "2026-07-01",
      apply_end: "2026-07-31",
      apply_method: {},
      support_amount: { unit: "KRW", per: "기업" },
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
      id: `criterion:${sourceId}`,
      dimension: "founder_age",
      kind: "required",
      operator: "between",
      value: { ranges: [{ min, max }] },
      confidence: 1,
      source_span: `대표자 만 ${min}세 이상 ${max}세 이하`,
    }],
    extraction_manifest: {
      grantId: `bizinfo:${sourceId}`,
      revision: `revision:${sourceId}`,
      sourceFieldsSeen: ["criteria"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: ["eligibility"],
      extractorVersion: "test-reviewed-v1",
      completedAt: "2026-07-11T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
      reviewedAt: "2026-07-11T01:00:00.000Z",
    },
    raw: {
      source: "bizinfo",
      source_id: sourceId,
      payload: {},
      collected_at: "2026-07-12T00:00:00.000Z",
      status: "published",
    },
  };
}

function revenueGrant(sourceId: string): NormalizedGrant<Record<string, never>> {
  const entry = ageGrant(sourceId, 20, 39);
  entry.grant.title = "매출 기준 확인 사업";
  entry.criteria = [{
    id: `criterion:${sourceId}`,
    dimension: "revenue",
    kind: "required",
    operator: "lte",
    value: { max_krw: 1_000_000_000 },
    confidence: 1,
    source_span: "최근 연 매출 10억원 이하",
  }];
  return entry;
}

function multiAnswerGrant(sourceId: string): NormalizedGrant<Record<string, never>> {
  const entry = ageGrant(sourceId, 20, 39);
  entry.grant.title = "대표자 연령과 매출 확인 사업";
  entry.criteria = [
    ...entry.criteria,
    {
      id: `criterion:${sourceId}:revenue`,
      dimension: "revenue",
      kind: "required",
      operator: "lte",
      value: { max_krw: 1_000_000_000 },
      confidence: 1,
      source_span: "최근 연 매출 10억원 이하",
    },
  ];
  return entry;
}
