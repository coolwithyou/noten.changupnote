/**
 * bizinfo LLM criteria 정규화 방어 테스트 (node:assert, tsx 실행) — Codex 리뷰 후속.
 *
 * 실행: pnpm exec tsx packages/core/src/bizinfo/llm-criteria-normalize.test.ts
 *
 * 검증 대상(LLM 실호출 없음 — tool_use input payload 를 직접 구성):
 *  - C2: prior_award + exclusion 은 구조화 수용되지 않고 other/text_only 로 강등된다.
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

// ── C2: prior_award + exclusion 강등 ──────────────────────────────────────────

check("[C2] prior_award + exclusion → other/text_only 강등 (span·note 보존)", () => {
  const c = normalizeOne({
    dimension: "prior_award",
    operator: "in",
    kind: "exclusion",
    value: { programs: ["창업사관학교"] },
    confidence: 0.8,
    source_span: "창업사관학교 수료 기업은 지원 제외한다.",
  });
  assert.equal(c.dimension, "other");
  assert.equal(c.operator, "text_only");
  assert.equal(c.kind, "exclusion");
  assert.ok(c.needs_review, "강등 시 needs_review true");
  const value = c.value as { note?: string };
  assert.match(value.note ?? "", /창업사관학교/);
  assert.equal(c.source_span, "창업사관학교 수료 기업은 지원 제외한다.");
});

check("[C2] prior_award + required(정상) 는 강등되지 않는다 (범위 밖)", () => {
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

check("[계약] 강등 결과 + 정상 결과가 섞여도 계약 검증 통과", () => {
  const criteria = normalizeBizInfoLlmCriteria(
    {
      criteria: [
        { dimension: "prior_award", operator: "in", kind: "exclusion", value: { programs: ["NEST"] }, confidence: 0.8, source_span: "NEST 수료자 제외." },
        { dimension: "premises", operator: "exists", kind: "required", value: {}, confidence: 0.7, source_span: "사업장 보유." },
        { dimension: "sanction", operator: "in", kind: "exclusion", value: { flags: ["participation_restricted"] }, confidence: 0.8, source_span: "참여제한 처분 기업 제외." },
        { dimension: "tax_compliance", operator: "in", kind: "exclusion", value: { flags: ["national_tax_delinquent"] }, confidence: 0.8 },
      ],
    },
    "src-mix",
  );
  const issues = validateGrantCriteriaContract(criteria);
  assert.deepEqual(issues, [], `계약 위반: ${JSON.stringify(issues)}`);
  // prior_award/premises/tax(span 누락) 3건 강등, sanction 1건 구조화.
  const dims = criteria.map((c) => c.dimension);
  assert.equal(dims.filter((d) => d === "other").length, 3, "강등 3건");
  assert.equal(dims.filter((d) => d === "sanction").length, 1, "구조화 1건");
});

// ── 계약 backstop: 강등 없이 위반 payload 를 직접 검증하면 issue 검출 ──────────────

check("[계약 backstop] prior_award exclusion 을 직접 계약 검증하면 issue 검출", () => {
  const issues = validateGrantCriteriaContract([
    { id: "x", grant_id: "g", dimension: "prior_award", operator: "in", kind: "exclusion", value: { programs: [] }, confidence: 0.8, source_span: "수료자 제외." },
  ]);
  assert.ok(issues.some((i) => /prior_award exclusion/.test(i.message)), "C2 위반 검출");
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

console.log(`\nllm-criteria-normalize.test.ts: ${passed} checks passed.`);
