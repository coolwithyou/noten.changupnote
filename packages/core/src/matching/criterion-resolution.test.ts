import assert from "node:assert/strict";
import test from "node:test";
import { classifyCriterionResolution } from "./criterion-resolution.js";

const base = {
  dimension: "other" as const,
  kind: "required" as const,
  operator: "text_only" as const,
  value: { note: "시흥시 소재 기업" },
  sourceSpan: "시흥시 관내 예비창업자 및 창업 7년 이내 기업",
  sourceVerified: true,
  companyProfileResolvable: false,
  needsReview: false,
};

test("검수된 필수 other/industry text_only는 공고별 확인 질문 수요를 만든다", () => {
  for (const dimension of ["other", "industry"] as const) {
    const actual = classifyCriterionResolution({ ...base, dimension });
    assert.equal(actual.action, "user_confirmation");
    assert.equal(actual.requiresEligibilityQuestion, true);
    assert.equal(actual.reuseScope, "per_notice");
  }
});

test("우대 text_only는 질문을 만들 수 있어도 자격 질문 누락으로 공고를 막지 않는다", () => {
  const actual = classifyCriterionResolution({ ...base, kind: "preferred" });
  assert.equal(actual.action, "user_confirmation");
  assert.equal(actual.requiresEligibilityQuestion, false);
  assert.equal(actual.reason, "criterion_not_eligibility_blocking");
});

test("구조화 조건은 회사 사실 비교로 보내고 질문 artifact를 요구하지 않는다", () => {
  const actual = classifyCriterionResolution({
    ...base,
    dimension: "region",
    operator: "in",
    value: { regions: ["41"] },
    companyProfileResolvable: true,
  });
  assert.equal(actual.action, "company_profile");
  assert.equal(actual.requiresEligibilityQuestion, false);
  assert.equal(actual.reuseScope, "company_fact");
});

test("구조화됐어도 matcher가 지원하지 않는 값 형태는 회사 입력으로 넘기지 않는다", () => {
  const actual = classifyCriterionResolution({
    ...base,
    dimension: "revenue",
    operator: "lte",
    value: { note: "매출 기준 별도 확인" },
  });
  assert.equal(actual.action, "admin_source_review");
  assert.equal(actual.reason, "unsupported_structured_criterion");
});

test("근거 누락·검수 필요·의미 강등은 사용자 답변으로 덮지 않는다", () => {
  assert.equal(classifyCriterionResolution({ ...base, sourceSpan: null }).action, "admin_source_review");
  assert.equal(classifyCriterionResolution({ ...base, needsReview: true }).action, "admin_source_review");
  assert.equal(classifyCriterionResolution({
    ...base,
    value: { downgrade_reason: "exclusive_upper_bound_mismatch", original_dimension: "biz_age" },
  }).action, "admin_source_review");
  assert.equal(classifyCriterionResolution({ ...base, dimension: "region" }).action, "admin_source_review");
});

console.log("criterion resolution: source interpretation and resolution ownership passed");
