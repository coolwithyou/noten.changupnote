import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  activeUnknownQuestionDimensions,
  clearProfileQuestionAnswerState,
  activeNumericQuestionRange,
  markProfileQuestionRange,
  markProfileQuestionUnknown,
} from "./question-answer-state.js";

const base: CompanyProfile = { confidence: {} };
const marked = markProfileQuestionUnknown({
  profile: base,
  dimension: "founder_age",
  answeredAt: new Date("2026-07-12T00:00:00.000Z"),
  ttlDays: 30,
  rulesetVer: "ruleset-test",
});
assert.equal(marked.founder_age, undefined, "unknown 응답은 프로필 값으로 쓰면 안 된다");
assert.deepEqual(marked.question_answer_state?.founder_age, {
  status: "unknown",
  answeredAt: "2026-07-12T00:00:00.000Z",
  expiresAt: "2026-08-11T00:00:00.000Z",
  sourceKind: "self_declared",
  rulesetVer: "ruleset-test",
});
assert.deepEqual(activeUnknownQuestionDimensions(marked, new Date("2026-08-10T23:59:59.000Z")), ["founder_age"]);
assert.deepEqual(activeUnknownQuestionDimensions(marked, new Date("2026-08-11T00:00:00.000Z")), []);
assert.equal(clearProfileQuestionAnswerState(marked, "founder_age").question_answer_state, undefined);
assert.equal(base.question_answer_state, undefined, "원본 프로필은 불변이어야 한다");

const withdrawnSize = markProfileQuestionUnknown({
  profile: {
    size: "중소기업",
    confidence: { size: 0.6 },
    profile_evidence: { size: {
      sourceKind: "self_declared", provider: "cunote_profile_question", asOf: "2026-07-11T00:00:00.000Z",
      axisCompleteness: "complete", confidence: 0.6, scope: "user",
    } },
  },
  dimension: "size",
  answeredAt: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(withdrawnSize.size, undefined, "모름으로 바꾼 기존 자가신고 규모는 판정에 남지 않는다");
assert.equal(withdrawnSize.profile_evidence?.size, undefined);
assert.equal(withdrawnSize.confidence?.size, undefined);
assert.equal(withdrawnSize.question_answer_state?.size?.status, "unknown");

const providerSize = markProfileQuestionUnknown({
  profile: { size: "중소기업", profile_evidence: { size: {
    sourceKind: "authoritative_api", provider: "official", asOf: "2026-07-11T00:00:00.000Z",
    axisCompleteness: "complete", confidence: 0.9, scope: "shared",
  } } },
  dimension: "size",
});
assert.equal(providerSize.size, "중소기업", "사용자의 모름은 권위 원천 확인값을 지우지 않는다");

const ranged = markProfileQuestionRange({
  profile: base,
  dimension: "employees",
  range: { min: 5, max: 9, unit: "people" },
  answeredAt: new Date("2026-07-12T00:00:00.000Z"),
  ttlDays: 180,
  rulesetVer: "ruleset-test",
});
assert.deepEqual(activeNumericQuestionRange(ranged, "employees", new Date("2026-07-13T00:00:00.000Z")), {
  min: 5,
  max: 9,
  unit: "people",
});
assert.equal(ranged.question_answer_state?.employees?.status, "range");
assert.equal(ranged.profile_evidence?.employees?.axisCompleteness, "partial");
assert.deepEqual(activeUnknownQuestionDimensions(ranged), [], "range 응답은 모름 TTL 억제와 구분해야 한다");
const replacedExact = markProfileQuestionRange({
  profile: {
    revenue_krw: 900_000_000,
    profile_evidence: { revenue: {
      sourceKind: "self_declared", provider: "cunote_profile_question", asOf: "2026-07-11T00:00:00.000Z",
      axisCompleteness: "complete", confidence: 0.6, scope: "user",
    } },
  },
  dimension: "revenue", range: { min: 300_000_000, max: 499_999_999, unit: "krw" },
});
assert.equal(replacedExact.revenue_krw, undefined, "구간 답변은 이전 정확 매출을 판정 근거에서 제거한다");
assert.equal(replacedExact.question_answer_state?.revenue?.status, "range");
assert.throws(() => markProfileQuestionRange({
  profile: {
    revenue_krw: 500_000_000,
    profile_evidence: {
      revenue: {
        sourceKind: "authoritative_api",
        provider: "dart",
        asOf: "2025-12-31T00:00:00.000Z",
        axisCompleteness: "complete",
        confidence: 0.9,
      },
    },
  },
  dimension: "revenue",
  range: { min: 300_000_000, max: 499_999_999, unit: "krw" },
}), /already confirmed/);

console.log("question-answer-state: ok");
