import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { markProfileQuestionRange } from "../company/question-answer-state.js";
import { updateCompanyProfileField } from "../company/update-profile-field.js";
import { matchGrantCriteria } from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import type { MatchedGrant } from "./match-card.js";

const asOf = new Date("2026-07-12T00:00:00.000Z");
const grants = [revenueGrant("revenue-1eok", 100_000_000), revenueGrant("revenue-2eok", 200_000_000)];
const empty: CompanyProfile = { confidence: {} };

const initial = evaluate(empty);
assert.equal(initial.question?.dimension, "revenue");
assert.equal(initial.question?.responseStage, "range");
assert.equal(initial.question?.inputType, "select");
assert.equal(initial.question?.rangeOptions?.length, 7);

const straddling = markProfileQuestionRange({
  profile: empty,
  dimension: "revenue",
  range: { min: 100_000_000, max: 299_999_999, unit: "krw" },
  answeredAt: asOf,
  ttlDays: 180,
});
const afterRange = evaluate(straddling);
assert.equal(afterRange.eligible, 1, "구간 전체가 1억원 기준 이상이면 확정 통과해야 한다");
assert.equal(afterRange.conditional, 1, "2억원 경계를 포함한 구간은 정확값 전까지 unknown이어야 한다");
assert.equal(afterRange.question?.responseStage, "precise");
assert.equal(afterRange.question?.inputType, "number");
assert.equal(afterRange.question?.affectedGrantCount, 1);

const nonStraddling = markProfileQuestionRange({
  profile: empty,
  dimension: "revenue",
  range: { min: 300_000_000, max: 499_999_999, unit: "krw" },
  answeredAt: asOf,
  ttlDays: 180,
});
const afterResolvedRange = evaluate(nonStraddling);
assert.equal(afterResolvedRange.eligible, 2);
assert.equal(afterResolvedRange.question, null, "모든 임계값을 판정한 구간 뒤에는 정확값을 묻지 않아야 한다");

const exact = updateCompanyProfileField(straddling, {
  field: "revenue",
  value: 150_000_000,
  confidence: 0.6,
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf: asOf.toISOString(),
});
const afterExact = evaluate(exact);
assert.equal(afterExact.eligible, 1);
assert.equal(afterExact.ineligible, 1);
assert.equal(afterExact.question, null);
assert.equal(exact.question_answer_state?.revenue, undefined, "정확값 저장 시 임시 구간 상태를 지워야 한다");

console.log("range-question-flow: ok");

function evaluate(company: CompanyProfile) {
  const matched: Array<MatchedGrant<Record<string, never>>> = grants.map((item) => ({
    item,
    match: matchGrantCriteria(item.criteria, company, { extractionManifest: item.extraction_manifest! }),
  }));
  const eligibility = matched.map((entry) => entry.match.eligibility);
  return {
    eligible: eligibility.filter((value) => value === "eligible").length,
    conditional: eligibility.filter((value) => value === "conditional").length,
    ineligible: eligibility.filter((value) => value === "ineligible").length,
    question: planProfileQuestions(matched, { asOf, limit: 1 })[0]?.question ?? null,
  };
}

function revenueGrant(sourceId: string, minKrw: number): NormalizedGrant<Record<string, never>> {
  return {
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: `매출 ${minKrw}원 이상`,
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
      dimension: "revenue",
      kind: "required",
      operator: "gte",
      value: { min_krw: minKrw },
      confidence: 1,
      source_span: `매출 ${minKrw}원 이상`,
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
