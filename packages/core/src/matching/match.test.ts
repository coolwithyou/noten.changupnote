/**
 * matchGrantCriteria 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/matching/match.test.ts
 *
 * 커버: 조건 0건 → conditional 강등 / fit_score 0 / criteria_extracted false / unknown chip 1건,
 *       조건 1건 이상 → criteria_extracted true.
 */
import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { matchGrantCriteria } from "./match.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const company: CompanyProfile = {
  name: "테스트 기업",
  region: { code: "41", label: "경기" },
  biz_age_months: 24,
  industries: ["ICT"],
  size: "중소",
  business_status: { active: true, label: "정상" },
  confidence: { region: 0.8, biz_age: 0.8, industry: 0.6, size: 0.6 },
};

check("조건 0건이면 conditional로 강등되고 적합도는 0이다", () => {
  const result = matchGrantCriteria([], company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.fit_score, 0);
  assert.equal(result.criteria_extracted, false);
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
});

check("조건 0건이면 unknown chip 1건(other/required/unknown)이 추가된다", () => {
  const result = matchGrantCriteria([], company);
  assert.equal(result.rule_trace.length, 1);
  const entry = result.rule_trace[0];
  assert.ok(entry);
  assert.equal(entry.dimension, "other");
  assert.equal(entry.kind, "required");
  assert.equal(entry.result, "unknown");
  assert.notEqual(entry.operator, "text_only"); // UI에서 unknown chip으로 표시되어야 함
  assert.match(entry.message, /구조화되지 않았/);
  assert.deepEqual(result.unknown_fields, ["other"]);
});

check("조건 1건 이상이면 criteria_extracted true", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "region",
      operator: "in",
      kind: "required",
      confidence: 0.9,
      value: { regions: ["41"], labels: ["경기"] },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.criteria_extracted, true);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.rule_trace.length, 1);
});

check("핵심 업종 text_only required가 있으면 확인 필요 게이트로 내린다", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "region",
      operator: "in",
      kind: "required",
      confidence: 0.9,
      value: { regions: ["41"], labels: ["경기"] },
    },
    {
      dimension: "industry",
      operator: "text_only",
      kind: "required",
      confidence: 0.5,
      value: { note: "원전 분야 매출 또는 기술개발 참여실적 확인 필요" },
      source_span: "최근 5년 이내 원전 분야 매출 또는 기술개발 참여실적 보유",
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
  assert.equal(result.review_gate?.reasons[0]?.code, "core_dimension_unknown");
});

check("인증 text_only required도 숫자 점수를 숨긴다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "certification",
    operator: "text_only",
    kind: "required",
    confidence: 0.5,
    value: { note: "국내외 원자력 인증보유 확인 필요" },
    source_span: "국내외 원자력 인증보유(KEPIC, ASME 등)",
  }];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
});

check("핵심 unknown 없이 필수 조건을 통과하면 recommendable/numeric", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "region",
      operator: "in",
      kind: "required",
      confidence: 0.9,
      value: { regions: ["41"], labels: ["경기"] },
    },
    {
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      confidence: 0.9,
      value: { max_months: 36, include_preliminary: false, labels: ["3년 이내"] },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.review_gate?.tier, "recommendable");
  assert.equal(result.review_gate?.scoreDisplay, "numeric");
});

check("검수 전 핵심 조건(needs_review)은 통과해도 확인 필요 게이트로 내린다", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "industry",
      operator: "in",
      kind: "required",
      confidence: 0.6,
      value: { industries: ["ICT"], labels: ["ICT"] },
      source_span: "ICT 분야 기업",
      needs_review: true,
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
  assert.equal(result.review_gate?.reasons[0]?.code, "criteria_under_extracted");
});

check("핵심 필수 조건 fail은 추천 제외 게이트로 내린다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "industry",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    value: { industries: ["제조업"], labels: ["제조업"] },
  }];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.review_gate?.tier, "not_recommended");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
});

console.log(`\nmatch.test.ts: ${passed} checks passed.`);
