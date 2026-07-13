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

check("조건 0건이면 conditional로 강등되고 조건 확인도는 0이다", () => {
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
      source_field: "supt_regin",
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
      source_field: "supt_regin",
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
      source_field: "supt_regin",
      value: { regions: ["41"], labels: ["경기"] },
    },
    {
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      confidence: 0.9,
      source_field: "biz_enyy",
      value: { max_months: 36, include_preliminary: false, labels: ["3년 이내"] },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.review_gate?.tier, "recommendable");
  assert.equal(result.review_gate?.scoreDisplay, "numeric");
  assert.equal(result.quality.verificationCompleteness, 100);
  assert.equal(result.quality.evidenceCoverage, 100);
  assert.equal(result.quality.extractionReadiness, "structured_unreviewed");
  assert.equal(result.quality.eligibilityConfidence, "medium");
});

check("원문 근거 없는 필수조건은 통과해도 추천 가능으로 올리지 않는다", () => {
  const result = matchGrantCriteria([{
    dimension: "region",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    value: { regions: ["41"], labels: ["경기"] },
  }], company);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
  assert.equal(result.quality.evidenceCoverage, 0);
  assert.equal(result.quality.extractionReadiness, "partial");
  assert.equal(result.quality.eligibilityConfidence, "low");
});

check("조건부 확인도는 필수·제외조건 가중 확인 비율로 계산한다", () => {
  const result = matchGrantCriteria([
    {
      dimension: "region",
      operator: "in",
      kind: "required",
      confidence: 0.9,
      source_field: "supt_regin",
      value: { regions: ["41"], labels: ["경기"] },
    },
    {
      dimension: "revenue",
      operator: "gte",
      kind: "required",
      confidence: 0.9,
      source_span: "최근 매출 1억원 이상",
      value: { min_krw: 100_000_000 },
    },
  ], company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.quality.verificationCompleteness, 50);
  assert.equal(result.fit_score, 50);
  assert.equal(result.quality.evidenceCoverage, 100);
});

check("기업규모 중소와 공고 중소기업은 canonical 동치로 통과한다", () => {
  const result = matchGrantCriteria([{
    dimension: "size",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "중소기업 지원",
    value: { sizes: ["중소기업"] },
  }], company);
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.rule_trace[0]?.result, "pass");
});

check("중소기업 근사값만으로 소상공인 요건을 탈락시키지 않고 unknown으로 둔다", () => {
  const result = matchGrantCriteria([{
    dimension: "size",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "소상공인 지원",
    value: { sizes: ["소상공인"] },
  }], company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
});

check("업력 임계값이 없는 구조화 조건은 기존 사업자를 fail 처리하지 않는다", () => {
  const result = matchGrantCriteria([{
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    confidence: 0.5,
    source_span: "창업기업 대상",
    value: { include_preliminary: false, labels: ["창업기업"] },
  }], company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
});

check("넓은 업종 라벨만으로 세부 업종 불일치를 확정하지 않는다", () => {
  const result = matchGrantCriteria([{
    dimension: "industry",
    operator: "in",
    kind: "required",
    confidence: 0.8,
    source_span: "게임 분야 기업",
    value: { industries: ["게임"], labels: ["게임"] },
  }], company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
});

check("KSIC 코드 양쪽이 있고 불일치하면 업종 미충족을 확정한다", () => {
  const result = matchGrantCriteria([{
    dimension: "industry",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "게임 소프트웨어 개발업",
    value: { codes: ["58211"], labels: ["게임 소프트웨어 개발업"] },
  }], {
    ...company,
    industry_codes: ["62010", "62", "J"],
    list_completeness: { industry: "complete" },
  });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.rule_trace[0]?.result, "fail");
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

check("검수 전 hard fail(needs_review)은 탈락 대신 core review unknown으로 보존한다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "region",
    operator: "in",
    kind: "required",
    confidence: 0.98,
    value: { regions: ["11"], labels: ["서울"], nationwide: false },
    source_span: "[서울] 소재 기업",
    needs_review: true,
  }];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.match(result.rule_trace[0]?.message ?? "", /검수 후/);
});

check("검수 전 exclusion hit(needs_review)도 탈락 대신 core review unknown으로 보존한다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "region",
    operator: "in",
    kind: "exclusion",
    confidence: 0.8,
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    source_span: "경기 소재 기업 제외",
    needs_review: true,
  }];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
  assert.equal(result.review_gate?.tier, "needs_core_review");
});

check("코드 근거가 있는 핵심 필수 조건 fail은 추천 제외 게이트로 내린다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "industry",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "제조업 대상",
    value: { codes: ["C"], industries: ["제조업"], labels: ["제조업"] },
  }];
  const result = matchGrantCriteria(criteria, {
    ...company,
    industry_codes: ["62010", "62", "J"],
    list_completeness: { industry: "complete" },
  });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.review_gate?.tier, "not_recommended");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
});

check("positive-only 인증 목록의 no-hit는 탈락시키지 않는다", () => {
  const criterion: GrantCriterion = {
    dimension: "certification",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "여성기업 확인서 보유 기업",
    value: { certs: ["여성기업"] },
  };
  const result = matchGrantCriteria([criterion], {
    ...company,
    certs: ["ISO9001"],
    confidence: { ...company.confidence, certification: 0.6 },
  });
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
});

check("complete 인증 목록의 no-hit는 필수 인증 미충족으로 확정한다", () => {
  const criterion: GrantCriterion = {
    dimension: "certification",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "여성기업 확인서 보유 기업",
    value: { certs: ["여성기업"] },
  };
  const result = matchGrantCriteria([criterion], {
    ...company,
    certs: ["ISO9001"],
    list_completeness: { certification: "complete" },
    confidence: { ...company.confidence, certification: 0.6 },
  });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.rule_trace[0]?.result, "fail");
});

check("positive-only 신청대상 목록의 exact hit는 통과한다", () => {
  const result = matchGrantCriteria([{
    dimension: "target_type",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_span: "법인사업자 대상",
    value: { targets: ["법인사업자"] },
  }], {
    ...company,
    target_types: ["법인사업자"],
    list_completeness: { target_type: "partial" },
    confidence: { ...company.confidence, target_type: 0.6 },
  });
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.rule_trace[0]?.result, "pass");
});

check("첨부 추출이 미완료면 자격 통과와 별개로 추천 가능 게이트를 막는다", () => {
  const criteria: GrantCriterion[] = [{
    dimension: "region",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    source_field: "supt_regin",
    source_span: "경기도 소재 기업",
    value: { regions: ["41"] },
  }];
  const result = matchGrantCriteria(criteria, company, {
    extractionManifest: {
      grantId: "kstartup:attachment-pending",
      revision: "r1",
      sourceFieldsSeen: ["supt_regin"],
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
  assert.equal(result.eligibility, "eligible", "입력 완전성은 규칙상 자격 결과를 뒤집지 않는다");
  assert.equal(result.review_gate?.tier, "needs_core_review");
  assert.equal(result.review_gate?.reasons[0]?.code, "extraction_incomplete");
  assert.equal(result.quality.extractionReadiness, "partial");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
});

check("업력 min 미달 fail은 unlock_at_months를 방출한다 (soon 버킷·해금 칩·eligible_from 소비)", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "biz_age",
      operator: "gte",
      kind: "required",
      confidence: 0.95,
      source_field: "biz_enyy",
      value: { min_months: 36 },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "ineligible");
  const entry = result.rule_trace[0];
  assert.ok(entry);
  assert.equal(entry.result, "fail");
  const companyValue = entry.company_value as Record<string, unknown>;
  assert.equal(companyValue.unlock_at_months, 36);
  assert.equal(companyValue.biz_age_months, 24);
});

check("업력 max 초과 fail은 unlock_at_months 없이 lock_after_months만 방출한다", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      confidence: 0.95,
      source_field: "biz_enyy",
      value: { max_months: 12 },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  const companyValue = result.rule_trace[0]?.company_value as Record<string, unknown>;
  assert.equal(companyValue.unlock_at_months, undefined);
  assert.equal(companyValue.lock_after_months, 13);
});

check("regions가 빈 제외 지역 조건은 무성 pass가 아니라 unknown으로 보존된다", () => {
  const criteria: GrantCriterion[] = [
    {
      dimension: "region",
      operator: "in",
      kind: "exclusion",
      confidence: 0.8,
      source_span: "음성·충주·제천·단양 소재 기업 제외",
      value: { labels: ["음성", "충주", "제천", "단양"] },
    },
  ];
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.eligibility, "conditional");
  assert.equal(result.rule_trace[0]?.result, "unknown");
});

console.log(`\nmatch.test.ts: ${passed} checks passed.`);
