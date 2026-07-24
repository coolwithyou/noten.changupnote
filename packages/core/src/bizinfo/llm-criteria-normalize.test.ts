/**
 * bizinfo LLM criteria 정규화 방어 테스트 (node:assert, tsx 실행) — Codex 리뷰 후속.
 *
 * 실행: pnpm exec tsx packages/core/src/bizinfo/llm-criteria-normalize.test.ts
 *
 * 검증 대상(LLM 실호출 없음 — tool_use input payload 를 직접 구성):
 *  - P4: v2 prior_award + exclusion 은 구조화되고 신규 value 계약을 통과한다.
 *  - M4: premises / export_performance 예약 축은 other/text_only 로 강등된다.
 *  - M1: 신규 구조화 축은 source_span 없으면 강등되고, 있으면 raw_text 에 전문 복제가 없다.
 *  - 정상 경로: prior_award required, source_span 있는 결격 축은 그대로 구조화된다.
 *  - 강등 결과도 계약(assertGrantCriteriaContract)을 통과한다.
 */
import assert from "node:assert/strict";
import { normalizeBizInfoLlmCriteria } from "./llm-criteria.js";
import { validateGrantCriteriaContract } from "./criteria-contract.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function normalizeOne(row: Record<string, unknown>) {
  const criteria = normalizeBizInfoLlmCriteria({ criteria: [row] }, "src-1");
  assert.equal(criteria.length, 1, "정확히 1개 criterion");
  return criteria[0]!;
}

// ── P4: prior_award + exclusion 구조화 ────────────────────────────────────────

check("[P4] prior_award + exclusion → v2 구조 유지", () => {
  const c = normalizeOne({
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    value: { scope: "program_type", programs: ["창업사관학교"], states: ["graduated"] },
    confidence: 0.8,
    source_span: "창업사관학교 수료 기업은 지원 제외한다.",
  });
  assert.equal(c.dimension, "prior_award");
  assert.equal(c.operator, "in");
  assert.equal(c.kind, "exclusion");
  assert.ok(c.needs_review, "LLM 구조화 결과는 검토 필요");
  assert.deepEqual(c.value, { scope: "program_type", programs: ["창업사관학교"], states: ["graduated"] });
  assert.equal(c.source_span, "창업사관학교 수료 기업은 지원 제외한다.");
  assert.equal(c.raw_text, c.source_span, "prior_award도 span만 raw_text로 보존");
});

check("[호환] prior_award required v1 값은 계속 수용", () => {
  const c = normalizeOne({
    dimension: "prior_award",
    operator: "in",
    kind: "required",
    value: { programs: ["예비창업패키지"] },
    confidence: 0.8,
    source_span: "예비창업패키지 선정 기업 대상.",
  });
  assert.equal(c.dimension, "prior_award");
  assert.equal(c.kind, "required");
});

check("[M1] prior_award 구조화 값도 source_span 없으면 강등", () => {
  const c = normalizeOne({
    dimension: "prior_award",
    operator: "exists",
    kind: "exclusion",
    value: { scope: "self", self_kind: "same_project", channel: "general" },
    confidence: 0.8,
  });
  assert.equal(c.dimension, "other");
  assert.equal(c.operator, "text_only");
});

// ── M4: 예약 2축 강등 ─────────────────────────────────────────────────────────

check("[M4] premises 축 → other/text_only 강등", () => {
  const c = normalizeOne({
    dimension: "premises",
    operator: "exists",
    kind: "required",
    value: { note: "사업장 보유" },
    confidence: 0.7,
    source_span: "독립된 사업장을 보유해야 한다.",
  });
  assert.equal(c.dimension, "other");
  assert.equal(c.operator, "text_only");
});

check("[M4] export_performance 축 → other/text_only 강등", () => {
  const c = normalizeOne({
    dimension: "export_performance",
    operator: "gte",
    kind: "required",
    value: { min_total_krw: 100000000 },
    confidence: 0.7,
    source_span: "직전 연도 수출실적 1억원 이상.",
  });
  assert.equal(c.dimension, "other");
  assert.equal(c.operator, "text_only");
});

// ── M1: span 정책 ─────────────────────────────────────────────────────────────

check("[M1] 신규 구조화 축이 source_span 없으면 강등", () => {
  const c = normalizeOne({
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    value: { flags: ["national_tax_delinquent"] },
    confidence: 0.8,
    // source_span 누락
  });
  assert.equal(c.dimension, "other");
  assert.equal(c.operator, "text_only");
});

check("[M1] source_span 있으면 구조화 유지 + raw_text 는 span 만(전문 복제 없음)", () => {
  const c = normalizeOne({
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    value: { flags: ["national_tax_delinquent"] },
    confidence: 0.8,
    source_span: "국세를 체납한 기업은 제외한다.",
    raw_text: "본 공고 전문 ... 원전 로봇 방위산업 등 매우 긴 문단 전체 ... 국세를 체납한 기업은 제외한다.",
  });
  assert.equal(c.dimension, "tax_compliance");
  assert.equal(c.source_span, "국세를 체납한 기업은 제외한다.");
  // raw_text 는 source_span 과 동일(LLM 이 준 전문 raw_text 를 버림).
  assert.equal(c.raw_text, "국세를 체납한 기업은 제외한다.");
  assert.ok(!/원전|로봇|방위산업/.test(c.raw_text ?? ""), "전문 도메인 단어 복제 없음");
});

check("[M1] financial_health 도 source_span 없으면 강등", () => {
  const c = normalizeOne({
    dimension: "financial_health",
    operator: "lte",
    kind: "exclusion",
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: true } },
    confidence: 0.8,
  });
  assert.equal(c.dimension, "other");
});

// ── 정상 경로 + 계약 통과 ──────────────────────────────────────────────────────

check("[정상] source_span 있는 결격 축은 그대로 구조화된다", () => {
  const c = normalizeOne({
    dimension: "credit_status",
    operator: "in",
    kind: "exclusion",
    value: { flags: ["bond_default"] },
    confidence: 0.8,
    source_span: "부도 상태인 기업은 제외한다.",
  });
  assert.equal(c.dimension, "credit_status");
  const value = c.value as { flags?: string[] };
  assert.deepEqual(value.flags, ["bond_default"]);
});

check("[정규화] 규모 오타 소중기업은 canonical 중소기업으로 교정", () => {
  const c = normalizeOne({
    dimension: "size",
    operator: "in",
    kind: "required",
    value: { sizes: ["소중기업"] },
    confidence: 0.9,
    source_span: "중소기업 대상",
  });
  assert.deepEqual((c.value as { sizes?: string[] }).sizes, ["중소기업"]);
});

check("[정규화] employees/revenue alias를 evaluator canonical key로 교정", () => {
  const criteria = normalizeBizInfoLlmCriteria({ criteria: [{
    dimension: "employees",
    operator: "gte",
    kind: "preferred",
    value: { min_employees: 20 },
    confidence: 0.9,
    source_span: "상시근로자 20인 이상 우대",
  }, {
    dimension: "revenue",
    operator: "gte",
    kind: "required",
    value: { min_revenue_krw: 100_000_000 },
    confidence: 0.9,
    source_span: "매출 1억원 이상",
  }] }, "alias-test");
  assert.deepEqual(criteria[0]?.value, { min: 20 });
  assert.deepEqual(criteria[1]?.value, { min_krw: 100_000_000 });
});

check("[정규화] industry labels/industries alias를 projection canonical tags로 교정", () => {
  const criteria = normalizeBizInfoLlmCriteria({ criteria: [{
    dimension: "industry",
    operator: "in",
    kind: "required",
    value: { labels: ["SW"], industries: ["소프트웨어", "SW"], kics_codes: ["j62"] },
    confidence: 0.9,
    source_span: "SW 및 소프트웨어 기업 대상",
  }] }, "industry-alias-test");
  assert.deepEqual(criteria[0]?.value, { tags: ["소프트웨어", "SW"], codes: ["J62"] });
});

check("[fail-safe] 결격 flags를 exceptions에 잘못 넣은 row만 text_only로 강등", () => {
  const criteria = normalizeBizInfoLlmCriteria({ criteria: [{
    dimension: "credit_status",
    operator: "in",
    kind: "exclusion",
    value: {
      flags: ["loan_default"],
      exceptions: ["rehabilitation_in_progress", "bankruptcy_filed"],
    },
    confidence: 0.9,
    source_span: "회생 또는 파산 절차 중인 기업은 원문 예외를 확인한다.",
  }, {
    dimension: "size",
    operator: "in",
    kind: "required",
    value: { sizes: ["중소기업"] },
    confidence: 0.9,
  }] }, "row-fail-safe");
  assert.equal(criteria.length, 2, "잘못된 한 row 때문에 공고 전체가 탈락하면 안 된다");
  assert.equal(criteria[0]?.dimension, "other");
  assert.equal(criteria[0]?.operator, "text_only");
  assert.equal(criteria[0]?.needs_review, true);
  assert.equal((criteria[0]?.value as { downgrade_reason?: string }).downgrade_reason, "contract_validation_failed");
  assert.equal(criteria[1]?.dimension, "size");
});

check("[fail-safe] self scope 식별자가 불완전한 prior_award는 의미 추정 없이 강등", () => {
  const criterion = normalizeOne({
    dimension: "prior_award",
    operator: "exists",
    kind: "exclusion",
    value: { scope: "self", channel: "general" },
    confidence: 0.9,
    source_span: "기존 지원사업 참여 여부를 확인한다.",
  });
  assert.equal(criterion.dimension, "other");
  assert.equal(criterion.operator, "text_only");
  assert.equal(criterion.needs_review, true);
});

check("[계약] 강등 결과 + 정상 결과가 섞여도 계약 검증 통과", () => {
  const criteria = normalizeBizInfoLlmCriteria(
    {
      criteria: [
        { dimension: "prior_award", operator: "in", kind: "exclusion", value: { scope: "program", programs: ["NEST"], states: ["graduated"] }, confidence: 0.8, source_span: "NEST 수료자 제외." },
        { dimension: "premises", operator: "exists", kind: "required", value: {}, confidence: 0.7, source_span: "사업장 보유." },
        { dimension: "sanction", operator: "in", kind: "exclusion", value: { flags: ["participation_restricted"] }, confidence: 0.8, source_span: "참여제한 처분 기업 제외." },
        { dimension: "tax_compliance", operator: "in", kind: "exclusion", value: { flags: ["national_tax_delinquent"] }, confidence: 0.8 },
      ],
    },
    "src-mix",
  );
  const issues = validateGrantCriteriaContract(criteria);
  assert.deepEqual(issues, [], `계약 위반: ${JSON.stringify(issues)}`);
  // premises/tax(span 누락) 2건 강등, prior_award/sanction 2건 구조화.
  const dims = criteria.map((c) => c.dimension);
  assert.equal(dims.filter((d) => d === "other").length, 2, "강등 2건");
  assert.equal(dims.filter((d) => d === "prior_award").length, 1, "prior_award 구조화 1건");
  assert.equal(dims.filter((d) => d === "sanction").length, 1, "구조화 1건");
});

// ── 계약 backstop: 강등 없이 위반 payload 를 직접 검증하면 issue 검출 ──────────────

check("[계약 P4] 올바른 prior_award exclusion 은 직접 계약 검증도 통과", () => {
  const issues = validateGrantCriteriaContract([
    { id: "x", grant_id: "g", dimension: "prior_award", operator: "in", kind: "exclusion", value: { scope: "program_type", programs: ["창업사관학교"], states: ["graduated"] }, confidence: 0.8, source_span: "수료자 제외." },
  ]);
  assert.deepEqual(issues, []);
});

check("[계약 backstop] malformed prior_award exclusion 은 scope/program/state/within 위반 검출", () => {
  const issues = validateGrantCriteriaContract([
    { id: "x", grant_id: "g", dimension: "prior_award", operator: "in", kind: "exclusion", value: { scope: "program", programs: [], states: ["selected"], within: { value: 0, unit: "week" } }, confidence: 0.8, source_span: "수료자 제외." },
    { id: "y", grant_id: "g", dimension: "prior_award", operator: "exists", kind: "exclusion", value: { programs: ["NEST"] }, confidence: 0.8, source_span: "NEST 제외." },
  ]);
  assert.ok(issues.some((i) => i.path.endsWith(".programs")), "빈 programs 검출");
  assert.ok(issues.some((i) => i.path.endsWith(".states")), "잘못된 state 검출");
  assert.ok(issues.some((i) => i.path.endsWith(".within.value")), "잘못된 기간 값 검출");
  assert.ok(issues.some((i) => i.path.endsWith(".within.unit")), "잘못된 기간 단위 검출");
  assert.ok(issues.some((i) => i.path.endsWith(".scope")), "exclusion scope 누락 검출");
});

check("[계약 backstop] 예약 축을 직접 계약 검증하면 issue 검출", () => {
  const issues = validateGrantCriteriaContract([
    { id: "x", grant_id: "g", dimension: "premises", operator: "exists", kind: "required", value: {}, confidence: 0.8, source_span: "사업장." },
  ]);
  assert.ok(issues.some((i) => /reserved dimension/.test(i.message)), "M4 위반 검출");
});

check("[계약 backstop] span 없는 신규 구조화 축을 직접 계약 검증하면 issue 검출", () => {
  const issues = validateGrantCriteriaContract([
    { id: "x", grant_id: "g", dimension: "financial_health", operator: "lte", kind: "exclusion", value: { min_interest_coverage: 1 }, confidence: 0.8 },
  ]);
  assert.ok(issues.some((i) => /M1 span policy/.test(i.message)), "M1 위반 검출");
});

check("[계약 canonical] legacy list alias는 저장 경계에서 거부한다", () => {
  const issues = validateGrantCriteriaContract([{
    id: "legacy-size",
    grant_id: "g",
    dimension: "size",
    operator: "in",
    kind: "required",
    value: { labels: ["중소기업"] },
    confidence: 0.8,
    source_span: "중소기업 대상",
  }]);
  assert.ok(issues.some((issue) => issue.path.endsWith(".sizes")), "canonical sizes 누락 검출");
});

check("[계약 canonical] 숫자 operator에 대응하는 canonical threshold를 요구한다", () => {
  const issues = validateGrantCriteriaContract([{
    id: "legacy-revenue-exclusion",
    grant_id: "g",
    dimension: "revenue",
    operator: "lte",
    kind: "exclusion",
    value: { revenue_krw: 300_000_000_000 },
    confidence: 0.8,
    source_span: "매출 3,000억원 이상 기업 제외",
  }]);
  assert.ok(issues.some((issue) => issue.path.endsWith(".max_krw")), "canonical max_krw 누락 검출");
});

console.log(`\nllm-criteria-normalize.test.ts: ${passed} checks passed.`);
