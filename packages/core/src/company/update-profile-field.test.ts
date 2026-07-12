/**
 * 결격·재무·고용·투자 축 프로필 파이프라인 검증 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/company/update-profile-field.test.ts
 *
 * 커버(P3):
 *  - 문항 응답 → {flags, known_flags, exceptions} 변환(문항→플래그 매핑 경유).
 *  - 결격 "예" 응답 시 matching이 unknown → fail(ineligible)로 전환.
 *  - "해당사항 없음" 응답 시 unknown → pass.
 *  - M3 라운드트립: 다른 필드 저장 후 결격 답변 잔존(JSON 직렬화 페이스).
 *  - financial_health 저부담 자본잠식 문항 + 결산 수치 파생.
 *  - 자가신고 confidence 0.6 기록.
 *  - 예약 2축(premises/export_performance) 명시 에러.
 */
import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion } from "@cunote/contracts";
import { updateCompanyProfileField, InvalidCompanyProfileFieldError } from "./update-profile-field.js";
import { matchGrantCriteria } from "../matching/match.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function emptyProfile(): CompanyProfile {
  return { confidence: {} };
}

function disqualificationCriterion(
  dimension: "tax_compliance" | "credit_status" | "sanction",
  flags: string[],
): GrantCriterion {
  return {
    dimension,
    operator: "in",
    kind: "exclusion",
    value: { flags },
    confidence: 0.6,
  };
}

// ── 문항 응답 → 프로필 변환 ──────────────────────────────────────────────────
check("체납 그룹 문항 응답(held 없음) → covers 전체 known, flags 비어있음", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: [] } } },
  });
  const tax = profile.tax_compliance;
  assert.ok(tax, "tax_compliance 값이 생성되어야 함");
  assert.deepEqual(tax.flags, []);
  assert.deepEqual(
    new Set(tax.known_flags),
    new Set([
      "national_tax_delinquent",
      "local_tax_delinquent",
      "customs_delinquent",
      "social_insurance_delinquent",
    ]),
    "그룹 문항 covers 전체가 known_flags에 기록되어야 함(문항→플래그 매핑 경유)",
  );
});

check("체납 그룹 문항 응답(held=국세) → 국세만 보유, covers 전체 known", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: ["national_tax_delinquent"] } } },
  });
  assert.deepEqual(profile.tax_compliance?.flags, ["national_tax_delinquent"]);
  assert.equal(profile.tax_compliance?.known_flags.length, 4);
});

check("자가신고 confidence 0.6 기본 기록(명시 전달 없을 때)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: [] } } },
  });
  assert.equal(profile.confidence?.tax_compliance, 0.6, "결격 축 자가신고 기본 confidence는 0.6");
});

check("명시 confidence는 존중(0.6 기본이 덮지 않음)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "credit_status",
    value: { answers: { credit_distress_group: { held: [] } } },
    confidence: 0.9,
  });
  assert.equal(profile.confidence?.credit_status, 0.9);
});

check("자가응답은 축별 원천·기준일·완전성을 값과 분리해 기록", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "founder_age",
    value: 35,
    confidence: 0.6,
    sourceKind: "self_declared",
    provider: "cunote_profile_question",
    asOf: "2026-07-12T00:00:00.000Z",
  });
  assert.deepEqual(profile.profile_evidence?.founder_age, {
    sourceKind: "self_declared",
    provider: "cunote_profile_question",
    asOf: "2026-07-12T00:00:00.000Z",
    axisCompleteness: "complete",
    confidence: 0.6,
  });
});

check("positive-only 목록 merge 응답은 evidence와 list completeness 모두 partial", () => {
  const profile = updateCompanyProfileField({
    industries: ["소프트웨어"],
    confidence: { industry: 0.9 },
    profile_evidence: {
      industry: {
        sourceKind: "authoritative_api",
        provider: "nts",
        asOf: "2026-07-11T00:00:00.000Z",
        axisCompleteness: "partial",
        confidence: 0.9,
      },
    },
  }, {
    field: "industry",
    value: ["AI"],
    mode: "merge",
    confidence: 0.6,
    sourceKind: "self_declared",
    provider: "cunote_profile_question",
    asOf: "2026-07-12T00:00:00.000Z",
  });
  assert.equal(profile.list_completeness?.industry, "partial");
  assert.equal(profile.profile_evidence?.industry?.axisCompleteness, "partial");
  assert.equal(profile.profile_evidence?.industry?.sourceKind, "authoritative_api");
  assert.deepEqual(profile.profile_evidence?.industry?.supplemental, [{
    sourceKind: "self_declared",
    provider: "cunote_profile_question",
    asOf: "2026-07-12T00:00:00.000Z",
    axisCompleteness: "partial",
    confidence: 0.6,
  }]);
  assert.deepEqual(profile.industries, ["소프트웨어", "AI"]);
});

check("자가응답이 권위 원천 값을 확인 절차 없이 덮어쓰지 못함", () => {
  const authoritative: CompanyProfile = {
    region: { code: "11", label: "서울" },
    confidence: { region: 1 },
    profile_evidence: {
      region: {
        sourceKind: "authoritative_api",
        provider: "nts",
        asOf: "2026-07-11T00:00:00.000Z",
        axisCompleteness: "complete",
        confidence: 1,
      },
    },
  };
  assert.throws(
    () => updateCompanyProfileField(authoritative, {
      field: "region",
      value: { code: "26", label: "부산" },
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: "2026-07-12T00:00:00.000Z",
    }),
    (error: unknown) => error instanceof InvalidCompanyProfileFieldError && /원천 충돌/.test(error.message),
  );
});

check("다른 축 플래그를 held로 보내면 무시(축 필터)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    // credit 축 플래그를 covers 없이 넘겨도 축 필터로 걸러진다.
    value: { answers: { tax_delinquency_group: { held: [] } }, flags: ["credit_delinquency"] },
  });
  assert.deepEqual(profile.tax_compliance?.flags, [], "타 축 플래그는 flags에 반영되지 않음");
});

check("알 수 없는 문항 id → 400 에러", () => {
  assert.throws(
    () =>
      updateCompanyProfileField(emptyProfile(), {
        field: "tax_compliance",
        value: { answers: { nope: { held: [] } } },
      }),
    (error: unknown) => error instanceof InvalidCompanyProfileFieldError && error.status === 400,
  );
});

// ── 매칭 unknown 해소 (결격 "예"/"해당없음") ────────────────────────────────────
check("결격 미응답 → matching unknown(conditional)", () => {
  const criterion = disqualificationCriterion("tax_compliance", ["national_tax_delinquent"]);
  const result = matchGrantCriteria([criterion], emptyProfile());
  assert.equal(result.rule_trace[0]?.result, "unknown");
  assert.equal(result.eligibility, "conditional");
});

check("결격 '해당사항 없음' 응답 → matching pass(eligible)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: [] } } },
  });
  const criterion = disqualificationCriterion("tax_compliance", ["national_tax_delinquent"]);
  const result = matchGrantCriteria([criterion], profile);
  assert.equal(result.rule_trace[0]?.result, "pass");
  assert.equal(result.eligibility, "eligible");
});

check("결격 '예'(국세 체납) 응답 → matching fail(ineligible)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: ["national_tax_delinquent"] } } },
  });
  const criterion = disqualificationCriterion("tax_compliance", ["national_tax_delinquent"]);
  const result = matchGrantCriteria([criterion], profile);
  assert.equal(result.rule_trace[0]?.result, "fail");
  assert.equal(result.eligibility, "ineligible");
});

check("공고가 요구한 플래그가 미질의면 unknown 유지(C1 플래그 단위 게이트)", () => {
  // 체납 그룹만 응답 → 신용 축 플래그는 미질의. 신용 조건은 여전히 unknown.
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: [] } } },
  });
  const creditCriterion = disqualificationCriterion("credit_status", ["bond_default"]);
  const result = matchGrantCriteria([creditCriterion], profile);
  assert.equal(result.rule_trace[0]?.result, "unknown", "미질의 축은 unknown 유지");
});

// ── M3 라운드트립: 다른 필드 저장 후 결격 답변 잔존 ─────────────────────────────
check("M3: 결격 답변 저장 후 다른 필드(revenue) 갱신 → 결격 잔존", () => {
  let profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: { answers: { tax_delinquency_group: { held: ["national_tax_delinquent"] } } },
  });
  // 다른 필드 갱신은 기존 프로필을 복사해 이어받는다(updateCompanyProfileField 스프레드).
  profile = updateCompanyProfileField(profile, { field: "revenue", value: 120000000, confidence: 0.8 });
  assert.deepEqual(profile.tax_compliance?.flags, ["national_tax_delinquent"], "결격 flags 잔존");
  assert.equal(profile.confidence?.tax_compliance, 0.6, "결격 confidence 잔존");
  assert.equal(profile.revenue_krw, 120000000);
});

check("M3: 결격 값 JSON 직렬화 라운드트립 무손실(DB JSON 컬럼 페이스)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "credit_status",
    value: {
      answers: { insolvency_proceeding_group: { held: ["rehabilitation_in_progress"] } },
      exceptions: ["repayment_plan_in_good_standing"],
    },
  });
  const stored = JSON.parse(JSON.stringify(profile.credit_status));
  assert.deepEqual(stored.flags, ["rehabilitation_in_progress"]);
  assert.ok(stored.known_flags.includes("bankruptcy_filed"), "그룹 covers 전체 known 직렬화 잔존");
  assert.deepEqual(stored.exceptions, ["repayment_plan_in_good_standing"]);
});

check("점진 질문 merge 모드는 자동조회 업종을 보존하고 새 세부 업종만 추가", () => {
  const profile = updateCompanyProfileField({
    industries: ["ICT", "SW"],
    confidence: { industry: 0.7 },
  }, {
    field: "industry",
    value: ["게임"],
    confidence: 0.6,
    mode: "merge",
  });
  assert.deepEqual(profile.industries, ["ICT", "SW", "게임"]);
  assert.equal(profile.confidence?.industry, 0.7, "기존 authoritative dimension confidence는 낮추지 않음");
  assert.equal(profile.list_completeness?.industry, "partial");
});

check("설정 저장 기본 replace 모드는 기존 배열을 명시적으로 교체", () => {
  const profile = updateCompanyProfileField({ industries: ["ICT", "SW"], confidence: {} }, {
    field: "industry",
    value: ["제조"],
  });
  assert.deepEqual(profile.industries, ["제조"]);
  assert.equal(profile.list_completeness?.industry, "complete");
});

// ── financial_health 저부담 문항 + 파생 (M7) ────────────────────────────────────
check("financial_health 저부담 자본잠식 문항(예) → impairment=full", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { capital_impaired: true },
  });
  assert.equal(profile.financial_health?.impairment, "full");
  assert.equal(profile.confidence?.financial_health, 0.6);
});

check("financial_health 자본잠식(아니오) → impairment=none", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { capital_impaired: false },
  });
  assert.equal(profile.financial_health?.impairment, "none");
});

check("financial_health 결산 수치(자본총계<자본금) → impairment=partial 파생", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { equity_krw: 30000000, capital_krw: 50000000 },
  });
  assert.equal(profile.financial_health?.impairment, "partial");
});

check("financial_health 결산 수치(자본총계<=0) → impairment=full 파생", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { equity_krw: -1000, capital_krw: 50000000 },
  });
  assert.equal(profile.financial_health?.impairment, "full");
});

check("financial_health 부채비율만 입력 → 부채비율만 반영, impairment 미설정", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { debt_ratio_pct: 250 },
  });
  assert.equal(profile.financial_health?.debt_ratio_pct, 250);
  assert.equal(profile.financial_health?.impairment, undefined);
});

check("financial_health 이자보상배율(소수) 입력 → floor 없이 그대로 보존", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { interest_coverage_ratio: 1.5 },
  });
  assert.equal(profile.financial_health?.interest_coverage_ratio, 1.5);
});

check("financial_health 이자보상배율 음수(영업손실) 허용", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { interest_coverage_ratio: -0.8 },
  });
  assert.equal(profile.financial_health?.interest_coverage_ratio, -0.8);
});

check("이자보상배율: 프로필 입력 → matching이 소비(미달 → fail)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "financial_health",
    value: { interest_coverage_ratio: 0.5 },
  });
  const criterion: GrantCriterion = {
    id: "c",
    grant_id: "g",
    dimension: "financial_health",
    operator: "gte",
    kind: "exclusion",
    confidence: 0.9,
    value: { min_interest_coverage: 1 },
  };
  const result = matchGrantCriteria([criterion], profile);
  assert.equal(result.rule_trace[0]?.result, "fail");
});

// ── insured_workforce / investment ──────────────────────────────────────────────
check("insured_workforce 고용보험 가입 + 피보험자 수", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "insured_workforce",
    value: { employment_insurance_active: true, insured_count: 12 },
  });
  assert.equal(profile.insured_workforce?.employment_insurance_active, true);
  assert.equal(profile.insured_workforce?.insured_count, 12);
});

check("investment 누적 유치 금액 + TIPS", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "investment",
    value: { total_raised_krw: 500000000, tips_backed: true },
  });
  assert.equal(profile.investment?.total_raised_krw, 500000000);
  assert.equal(profile.investment?.tips_backed, true);
});

// ── 예약 2축 명시 에러 ────────────────────────────────────────────────────────
check("premises 축 입력 → 예약 상태 400 에러", () => {
  assert.throws(
    () => updateCompanyProfileField(emptyProfile(), { field: "premises", value: {} }),
    (error: unknown) => error instanceof InvalidCompanyProfileFieldError && error.status === 400,
  );
});

check("export_performance 축 입력 → 예약 상태 400 에러", () => {
  assert.throws(
    () => updateCompanyProfileField(emptyProfile(), { field: "export_performance", value: {} }),
    (error: unknown) => error instanceof InvalidCompanyProfileFieldError && error.status === 400,
  );
});

// ── 예외 차감(M5) 통합 ──────────────────────────────────────────────────────────
check("징수유예 예외 → 체납이지만 matching pass(예외 인정)", () => {
  const profile = updateCompanyProfileField(emptyProfile(), {
    field: "tax_compliance",
    value: {
      answers: { tax_delinquency_group: { held: ["national_tax_delinquent"] } },
      exceptions: ["payment_deferral_approved"],
    },
  });
  // 공고가 동일 예외를 허용하는 경우.
  const criterion: GrantCriterion = {
    dimension: "tax_compliance",
    operator: "in",
    kind: "exclusion",
    value: { flags: ["national_tax_delinquent"], exceptions: ["payment_deferral_approved"] },
    confidence: 0.9,
  };
  const result = matchGrantCriteria([criterion], profile);
  assert.equal(result.rule_trace[0]?.result, "pass", "예외 인정으로 통과");
});

console.log(`\n결격·재무·고용·투자 프로필 파이프라인 검증 통과: ${passed}건`);
