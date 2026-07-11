/**
 * 공고매칭 차원 확장 P2 — 신규 evaluator 판정 매트릭스 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/matching/disqualification-match.test.ts
 *
 * 축별 × {pass, fail, unknown(미입력), 미질의 플래그→unknown(C1),
 *         부분 예외(교집합 2개 중 1개만 면제)→fail(M5),
 *         하위 필드 부분입력→unknown(Minor-3), 경계값 inclusive/exclusive(Minor-2)}.
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

/** 단일 criterion을 회사 프로필에 대해 평가하고 첫 trace 엔트리를 반환한다. */
function evalOne(criterion: GrantCriterion, company: CompanyProfile) {
  const result = matchGrantCriteria([criterion], company);
  const entry = result.rule_trace[0];
  assert.ok(entry, "trace entry 존재");
  return { result, entry };
}

const baseConfidence = { region: 0.8 } as const;

// ── tax_compliance ──────────────────────────────────────────────────────────

const taxCriterion: GrantCriterion = {
  dimension: "tax_compliance",
  operator: "in",
  kind: "exclusion",
  confidence: 0.9,
  value: { flags: ["national_tax_delinquent", "local_tax_delinquent"] },
};

check("[tax] 결격 없음 + 전부 질의됨 → pass", () => {
  const company: CompanyProfile = {
    tax_compliance: {
      flags: [],
      known_flags: ["national_tax_delinquent", "local_tax_delinquent", "customs_delinquent", "social_insurance_delinquent"],
      exceptions: [],
    },
    confidence: { ...baseConfidence, tax_compliance: 0.6 },
  };
  const { entry } = evalOne(taxCriterion, company);
  assert.equal(entry.result, "pass");
});

check("[tax] 결격 보유 + 예외 없음 → fail (잔존 플래그 라벨 포함)", () => {
  const company: CompanyProfile = {
    tax_compliance: {
      flags: ["national_tax_delinquent"],
      known_flags: ["national_tax_delinquent", "local_tax_delinquent", "customs_delinquent", "social_insurance_delinquent"],
      exceptions: [],
    },
    confidence: { ...baseConfidence, tax_compliance: 0.6 },
  };
  const { entry } = evalOne(taxCriterion, company);
  assert.equal(entry.result, "fail");
  assert.match(entry.message, /국세 체납/);
});

check("[tax] profile 미존재 → unknown", () => {
  const company: CompanyProfile = { confidence: { ...baseConfidence } };
  const { entry } = evalOne(taxCriterion, company);
  assert.equal(entry.result, "unknown");
});

check("[tax] dimension confidence 없음 → unknown", () => {
  const company: CompanyProfile = {
    tax_compliance: { flags: [], known_flags: ["national_tax_delinquent", "local_tax_delinquent"], exceptions: [] },
    confidence: { ...baseConfidence }, // tax_compliance confidence 미기록
  };
  const { entry } = evalOne(taxCriterion, company);
  assert.equal(entry.result, "unknown");
});

check("[tax] 미질의 플래그 있음 → unknown (C1 플래그 단위 known 게이트)", () => {
  const company: CompanyProfile = {
    tax_compliance: {
      flags: [],
      known_flags: ["national_tax_delinquent"], // local_tax_delinquent 미질의
      exceptions: [],
    },
    confidence: { ...baseConfidence, tax_compliance: 0.6 },
  };
  const { entry } = evalOne(taxCriterion, company);
  assert.equal(entry.result, "unknown");
  assert.match(entry.message, /지방세 체납/);
});

check("[tax] 예외(징수유예)로 히트 전부 면제 → pass", () => {
  const criterion: GrantCriterion = {
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    value: { flags: ["national_tax_delinquent"], exceptions: ["payment_deferral_approved"] },
  };
  const company: CompanyProfile = {
    tax_compliance: {
      flags: ["national_tax_delinquent"],
      known_flags: ["national_tax_delinquent"],
      exceptions: ["payment_deferral_approved"],
    },
    confidence: { ...baseConfidence, tax_compliance: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "pass");
  assert.match(entry.message, /예외 인정/);
});

check("[tax] 공고가 허용하지 않은 예외를 회사가 보유해도 면제 안 됨 → fail (교집합 게이트)", () => {
  const criterion: GrantCriterion = {
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    // 공고는 국세 배제만 하고 예외를 허용하지 않음.
    value: { flags: ["national_tax_delinquent"] },
  };
  const company: CompanyProfile = {
    tax_compliance: {
      flags: ["national_tax_delinquent"],
      known_flags: ["national_tax_delinquent"],
      // 회사가 징수유예를 보유해도, 공고 exceptions에 없으므로 차감 대상 아님.
      exceptions: ["payment_deferral_approved"],
    },
    confidence: { ...baseConfidence, tax_compliance: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
  assert.match(entry.message, /국세 체납/);
});

// ── credit_status: 부분 예외(M5)를 정확히 검증 (예외가 교집합 일부만 커버) ──────

check("[credit] 부분 예외(교집합 2개 중 1개만 면제) → fail (M5)", () => {
  const criterion: GrantCriterion = {
    dimension: "credit_status",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    // 공고가 회생·압류를 배제, 예외로 변제계획 성실이행(회생·법정관리만 커버) 허용.
    value: {
      flags: ["rehabilitation_in_progress", "asset_seizure"],
      exceptions: ["repayment_plan_in_good_standing"],
    },
  };
  const company: CompanyProfile = {
    credit_status: {
      flags: ["rehabilitation_in_progress", "asset_seizure"],
      known_flags: ["rehabilitation_in_progress", "asset_seizure"],
      exceptions: ["repayment_plan_in_good_standing"], // rehabilitation만 커버, asset_seizure는 잔존
    },
    confidence: { ...baseConfidence, credit_status: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
  assert.match(entry.message, /압류/); // 잔존 플래그(asset_seizure) 라벨
  assert.doesNotMatch(entry.message, /회생·개인회생 진행 - 예외 미인정/); // rehabilitation은 면제됨
});

check("[credit] 예외가 교집합 전부 면제 → pass", () => {
  const criterion: GrantCriterion = {
    dimension: "credit_status",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    value: {
      flags: ["rehabilitation_in_progress", "court_receivership"],
      exceptions: ["repayment_plan_in_good_standing"],
    },
  };
  const company: CompanyProfile = {
    credit_status: {
      flags: ["rehabilitation_in_progress", "court_receivership"],
      known_flags: ["rehabilitation_in_progress", "court_receivership"],
      exceptions: ["repayment_plan_in_good_standing"],
    },
    confidence: { ...baseConfidence, credit_status: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "pass");
});

// ── sanction ────────────────────────────────────────────────────────────────

const sanctionCriterion: GrantCriterion = {
  dimension: "sanction",
  operator: "in",
  kind: "exclusion",
  confidence: 0.9,
  value: { flags: ["participation_restricted", "subsidy_fraud"] },
};

check("[sanction] 제재 없음 + 질의됨 → pass", () => {
  const company: CompanyProfile = {
    sanction: {
      flags: [],
      known_flags: ["participation_restricted", "subsidy_fraud"],
      exceptions: [],
    },
    confidence: { ...baseConfidence, sanction: 0.6 },
  };
  const { entry } = evalOne(sanctionCriterion, company);
  assert.equal(entry.result, "pass");
});

check("[sanction] 참여제한 보유 → fail", () => {
  const company: CompanyProfile = {
    sanction: {
      flags: ["participation_restricted"],
      known_flags: ["participation_restricted", "subsidy_fraud"],
      exceptions: [],
    },
    confidence: { ...baseConfidence, sanction: 0.6 },
  };
  const { entry } = evalOne(sanctionCriterion, company);
  assert.equal(entry.result, "fail");
  assert.match(entry.message, /참여제한/);
});

check("[sanction] 미질의 → unknown (C1)", () => {
  const company: CompanyProfile = {
    sanction: { flags: [], known_flags: [], exceptions: [] },
    confidence: { ...baseConfidence, sanction: 0.6 },
  };
  const { entry } = evalOne(sanctionCriterion, company);
  assert.equal(entry.result, "unknown");
});

// ── financial_health (Minor-2 경계값, Minor-3 부분입력) ────────────────────────

check("[financial] 부채비율 1000% 이상 배제, inclusive 경계값(=1000) → fail (Minor-2)", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "lte",
    kind: "exclusion",
    confidence: 0.9,
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: true } },
  };
  const company: CompanyProfile = {
    financial_health: { debt_ratio_pct: 1000 },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
});

check("[financial] 부채비율 임계 초과(exclusive), 경계값(=1000) → pass (Minor-2)", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "lte",
    kind: "exclusion",
    confidence: 0.9,
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: false } },
  };
  const company: CompanyProfile = {
    financial_health: { debt_ratio_pct: 1000 },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "pass");
});

check("[financial] exclusive 임계 초과값(1001) → fail (Minor-2)", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "lte",
    kind: "exclusion",
    confidence: 0.9,
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: false } },
  };
  const company: CompanyProfile = {
    financial_health: { debt_ratio_pct: 1001 },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
});

check("[financial] 부채비율 임계 미만 → pass", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "lte",
    kind: "exclusion",
    confidence: 0.9,
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: true } },
  };
  const company: CompanyProfile = {
    financial_health: { debt_ratio_pct: 500 },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "pass");
});

check("[financial] dimension known이나 참조 필드(부채비율) null → unknown (Minor-3)", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "lte",
    kind: "exclusion",
    confidence: 0.9,
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: true } },
  };
  const company: CompanyProfile = {
    // 자본잠식만 입력했는데 공고 조건은 부채비율 → 참조 필드 null이므로 unknown.
    financial_health: { debt_ratio_pct: null, impairment: "none" },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

check("[financial] 자본잠식(full) 배제 → fail", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "text_only",
    kind: "exclusion",
    confidence: 0.9,
    value: { impairment_excluded: ["partial", "full"] },
  };
  const company: CompanyProfile = {
    financial_health: { impairment: "full" },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  // text_only는 switch 앞에서 unknown으로 가로채이므로, 실제 판정을 위해 operator를 바꾼다.
  const activeCriterion: GrantCriterion = { ...criterion, operator: "in" };
  const { entry } = evalOne(activeCriterion, company);
  assert.equal(entry.result, "fail");
  assert.match(entry.message, /자본잠식/);
});

check("[financial] 자본잠식 여부 null → unknown (Minor-3)", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    value: { impairment_excluded: ["partial", "full"] },
  };
  const company: CompanyProfile = {
    financial_health: { debt_ratio_pct: 200, impairment: null },
    confidence: { ...baseConfidence, financial_health: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

check("[financial] profile 미존재 → unknown", () => {
  const criterion: GrantCriterion = {
    dimension: "financial_health",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    value: { debt_ratio_pct_threshold: { value: 1000, inclusive: true } },
  };
  const company: CompanyProfile = { confidence: { ...baseConfidence } };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

// ── insured_workforce (boolean+numeric 복합, 부분입력 unknown) ────────────────

check("[insured] 고용보험 가입 필요 + 가입됨 + 인원 충족 → pass", () => {
  const criterion: GrantCriterion = {
    dimension: "insured_workforce",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { employment_insurance_required: true, min_insured: 5 },
  };
  const company: CompanyProfile = {
    insured_workforce: { employment_insurance_active: true, insured_count: 10 },
    confidence: { ...baseConfidence, insured_workforce: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "pass");
});

check("[insured] 고용보험 미가입 → fail", () => {
  const criterion: GrantCriterion = {
    dimension: "insured_workforce",
    operator: "exists",
    kind: "required",
    confidence: 0.9,
    value: { employment_insurance_required: true },
  };
  const company: CompanyProfile = {
    insured_workforce: { employment_insurance_active: false },
    confidence: { ...baseConfidence, insured_workforce: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
});

check("[insured] 최소 인원 미달 → fail", () => {
  const criterion: GrantCriterion = {
    dimension: "insured_workforce",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { min_insured: 5 },
  };
  const company: CompanyProfile = {
    insured_workforce: { insured_count: 2 },
    confidence: { ...baseConfidence, insured_workforce: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
});

check("[insured] 인원 조건인데 insured_count null → unknown (부분입력)", () => {
  const criterion: GrantCriterion = {
    dimension: "insured_workforce",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { min_insured: 5 },
  };
  const company: CompanyProfile = {
    insured_workforce: { employment_insurance_active: true, insured_count: null },
    confidence: { ...baseConfidence, insured_workforce: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

check("[insured] profile 미존재 → unknown", () => {
  const criterion: GrantCriterion = {
    dimension: "insured_workforce",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { min_insured: 5 },
  };
  const company: CompanyProfile = { confidence: { ...baseConfidence } };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

// ── investment (boolean+numeric 복합, 부분입력 unknown) ───────────────────────

check("[investment] 최소 유치 금액 충족 → pass", () => {
  const criterion: GrantCriterion = {
    dimension: "investment",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { min_total_krw: 100_000_000 },
  };
  const company: CompanyProfile = {
    investment: { total_raised_krw: 300_000_000 },
    confidence: { ...baseConfidence, investment: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "pass");
});

check("[investment] 유치 금액 미달 → fail", () => {
  const criterion: GrantCriterion = {
    dimension: "investment",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { min_total_krw: 100_000_000 },
  };
  const company: CompanyProfile = {
    investment: { total_raised_krw: 10_000_000 },
    confidence: { ...baseConfidence, investment: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
});

check("[investment] TIPS 필요인데 미선정 → fail", () => {
  const criterion: GrantCriterion = {
    dimension: "investment",
    operator: "exists",
    kind: "required",
    confidence: 0.9,
    value: { tips_operator_required: true },
  };
  const company: CompanyProfile = {
    investment: { tips_backed: false },
    confidence: { ...baseConfidence, investment: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "fail");
});

check("[investment] 금액 조건인데 total_raised_krw null → unknown (부분입력)", () => {
  const criterion: GrantCriterion = {
    dimension: "investment",
    operator: "gte",
    kind: "required",
    confidence: 0.9,
    value: { min_total_krw: 100_000_000 },
  };
  const company: CompanyProfile = {
    investment: { total_raised_krw: null },
    confidence: { ...baseConfidence, investment: 0.6 },
  };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

// ── 예약 2축 방어적 unknown ──────────────────────────────────────────────────

check("[premises] 예약 축은 방어적으로 unknown", () => {
  const criterion: GrantCriterion = {
    dimension: "premises",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    value: {},
  };
  const company: CompanyProfile = { confidence: { ...baseConfidence } };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

check("[export_performance] 예약 축은 방어적으로 unknown", () => {
  const criterion: GrantCriterion = {
    dimension: "export_performance",
    operator: "in",
    kind: "required",
    confidence: 0.9,
    value: {},
  };
  const company: CompanyProfile = { confidence: { ...baseConfidence } };
  const { entry } = evalOne(criterion, company);
  assert.equal(entry.result, "unknown");
});

// ── buildReviewGate: 결격 3축 unknown → disqualification_unconfirmed ──────────

check("[gate] 결격 축 unknown 시 disqualification_unconfirmed reason + needs_profile_input 티어", () => {
  const criterion: GrantCriterion = {
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    value: { flags: ["national_tax_delinquent"] },
  };
  const company: CompanyProfile = { confidence: { ...baseConfidence } };
  const result = matchGrantCriteria([criterion], company);
  assert.equal(result.review_gate?.tier, "needs_profile_input");
  assert.equal(result.review_gate?.scoreDisplay, "hidden");
  assert.equal(result.review_gate?.reasons[0]?.code, "disqualification_unconfirmed");
  assert.equal(result.review_gate?.reasons[0]?.dimension, "tax_compliance");
});

check("[gate] 결격 축 fail 시 not_recommended (하드 fail)", () => {
  const criterion: GrantCriterion = {
    dimension: "sanction",
    operator: "in",
    kind: "exclusion",
    confidence: 0.9,
    value: { flags: ["participation_restricted"] },
  };
  const company: CompanyProfile = {
    sanction: {
      flags: ["participation_restricted"],
      known_flags: ["participation_restricted"],
      exceptions: [],
    },
    confidence: { ...baseConfidence, sanction: 0.6 },
  };
  const result = matchGrantCriteria([criterion], company);
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.review_gate?.tier, "not_recommended");
});

check("[gate] nextQuestion 우선순위: 결격 축이 최상위", () => {
  // region unknown + tax unknown 이 함께 있으면 tax를 먼저 묻는다.
  const criteria: GrantCriterion[] = [
    {
      dimension: "region",
      operator: "in",
      kind: "required",
      confidence: 0.9,
      value: { regions: ["11"], labels: ["서울"] },
    },
    {
      dimension: "tax_compliance",
      operator: "in",
      kind: "exclusion",
      confidence: 0.9,
      value: { flags: ["national_tax_delinquent"] },
    },
  ];
  const company: CompanyProfile = { confidence: {} }; // region·tax 모두 미입력
  const result = matchGrantCriteria(criteria, company);
  assert.equal(result.next_question?.field, "tax_compliance");
});

console.log(`\ndisqualification-match.test.ts: ${passed} checks passed.`);
