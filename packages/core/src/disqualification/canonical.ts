/**
 * 결격(배제) 축 canonical 사전 — 공고매칭 차원 확장 P0.
 *
 * 단일 원천: 결격 3축(tax_compliance / credit_status / sanction)의 canonical 플래그,
 * 예외 canonical + 예외→플래그 커버 매핑, 온보딩 문항→플래그 커버 매핑, 한국어 라벨,
 * 그리고 industry `not_in`용 공통 배제업종 canonical set(KSIC 코드 매핑 포함).
 *
 * 계약 규칙(C1/M5):
 *  - 사전에 플래그를 추가하면 반드시 문항 커버 매핑(QUESTION_FLAG_COVERAGE)에도 추가한다.
 *  - 매핑 완전성(모든 flag가 1개 이상 문항에 커버)은 canonical.test.ts로 강제한다.
 *  - 예외는 교집합 일부만 면제할 수 있으므로 예외→플래그 커버(EXCEPTION_FLAG_COVERAGE)로
 *    플래그 단위 차감한다.
 *
 * 판정 시맨틱(evaluateDisqualification)·문항 UI·프로필 직렬화는 P2/P3 몫이며 이 사전을 소비한다.
 */

export type DisqualificationAxis = "tax_compliance" | "credit_status" | "sanction";

// ── canonical 플래그 (§2.3) ──────────────────────────────────────────────

export const TAX_COMPLIANCE_FLAGS = [
  "national_tax_delinquent",
  "local_tax_delinquent",
  "customs_delinquent",
  "social_insurance_delinquent",
] as const;
export type TaxComplianceFlag = (typeof TAX_COMPLIANCE_FLAGS)[number];

export const CREDIT_STATUS_FLAGS = [
  "credit_delinquency", // 연체
  "loan_default", // 채무불이행
  "bond_default", // 부도
  "rehabilitation_in_progress", // 회생·개인회생
  "bankruptcy_filed", // 파산
  "court_receivership", // 법정관리
  "financial_misconduct", // 금융질서문란
  "asset_seizure", // 압류
  "guarantee_restricted", // 보증금지·제한
] as const;
export type CreditStatusFlag = (typeof CREDIT_STATUS_FLAGS)[number];

export const SANCTION_FLAGS = [
  "participation_restricted",
  "subsidy_fraud",
  "subsidy_law_violation",
  "obligation_breach",
  "wage_arrears_listed",
  "serious_accident_listed",
  "agreement_breach",
] as const;
export type SanctionFlag = (typeof SANCTION_FLAGS)[number];

export type DisqualificationFlag = TaxComplianceFlag | CreditStatusFlag | SanctionFlag;

/** 축별 canonical 플래그 목록. */
export const DISQUALIFICATION_FLAGS: Record<DisqualificationAxis, readonly DisqualificationFlag[]> = {
  tax_compliance: TAX_COMPLIANCE_FLAGS,
  credit_status: CREDIT_STATUS_FLAGS,
  sanction: SANCTION_FLAGS,
};

/** 전체 canonical 플래그(중복 없음). */
export const ALL_DISQUALIFICATION_FLAGS: readonly DisqualificationFlag[] = [
  ...TAX_COMPLIANCE_FLAGS,
  ...CREDIT_STATUS_FLAGS,
  ...SANCTION_FLAGS,
];

/** 플래그 → 소속 축 역참조. */
export const FLAG_AXIS: Record<DisqualificationFlag, DisqualificationAxis> = {
  national_tax_delinquent: "tax_compliance",
  local_tax_delinquent: "tax_compliance",
  customs_delinquent: "tax_compliance",
  social_insurance_delinquent: "tax_compliance",
  credit_delinquency: "credit_status",
  loan_default: "credit_status",
  bond_default: "credit_status",
  rehabilitation_in_progress: "credit_status",
  bankruptcy_filed: "credit_status",
  court_receivership: "credit_status",
  financial_misconduct: "credit_status",
  asset_seizure: "credit_status",
  guarantee_restricted: "credit_status",
  participation_restricted: "sanction",
  subsidy_fraud: "sanction",
  subsidy_law_violation: "sanction",
  obligation_breach: "sanction",
  wage_arrears_listed: "sanction",
  serious_accident_listed: "sanction",
  agreement_breach: "sanction",
};

// ── 한국어 라벨 (§2.3) ────────────────────────────────────────────────────

export const DISQUALIFICATION_FLAG_LABELS: Record<DisqualificationFlag, string> = {
  // tax_compliance
  national_tax_delinquent: "국세 체납",
  local_tax_delinquent: "지방세 체납",
  customs_delinquent: "관세 체납",
  social_insurance_delinquent: "4대보험료 체납",
  // credit_status
  credit_delinquency: "신용 연체",
  loan_default: "채무불이행",
  bond_default: "부도",
  rehabilitation_in_progress: "회생·개인회생 진행",
  bankruptcy_filed: "파산 신청",
  court_receivership: "법정관리",
  financial_misconduct: "금융질서문란행위자",
  asset_seizure: "압류",
  guarantee_restricted: "보증 금지·제한",
  // sanction
  participation_restricted: "참여제한 처분",
  subsidy_fraud: "보조금 부정수급",
  subsidy_law_violation: "보조금법 위반",
  obligation_breach: "의무 불이행",
  wage_arrears_listed: "임금체불 명단 공개",
  serious_accident_listed: "중대재해 명단 공개",
  agreement_breach: "협약 위반",
};

// ── 예외 canonical + 예외→플래그 커버 매핑 (M5, §2.3) ─────────────────────

export const DISQUALIFICATION_EXCEPTIONS = [
  "payment_deferral_approved",
  "repayment_plan_in_good_standing",
  "statute_expired",
] as const;
export type DisqualificationException = (typeof DISQUALIFICATION_EXCEPTIONS)[number];

export const DISQUALIFICATION_EXCEPTION_LABELS: Record<DisqualificationException, string> = {
  payment_deferral_approved: "징수유예·납부기한 연장 승인",
  repayment_plan_in_good_standing: "변제계획 성실 이행 중",
  statute_expired: "시효 완성",
};

/**
 * 예외 canonical → 해당 예외가 커버(면제)하는 플래그 목록.
 * 판정 시 hit ∩ profile.exceptions 에서 이 매핑을 참조해 플래그 단위로 차감한다(§2.4).
 */
export const EXCEPTION_FLAG_COVERAGE: Record<DisqualificationException, readonly DisqualificationFlag[]> = {
  payment_deferral_approved: [
    "national_tax_delinquent",
    "local_tax_delinquent",
    "customs_delinquent",
    "social_insurance_delinquent",
  ],
  repayment_plan_in_good_standing: ["rehabilitation_in_progress", "court_receivership"],
  statute_expired: ["asset_seizure"],
};

// ── 온보딩 문항→플래그 커버 매핑 (C1, §3 P3) ──────────────────────────────

export type DisqualificationQuestionId =
  | "tax_delinquency_group"
  | "credit_distress_group"
  | "insolvency_proceeding_group"
  | "financial_sanction_group"
  | "public_sanction_group";

export interface DisqualificationQuestion {
  id: DisqualificationQuestionId;
  axis: DisqualificationAxis;
  /** 온보딩 그룹 체크리스트 제목. */
  label: string;
  /** 이 문항에 응답하면 known 처리되는 플래그(그룹 체크리스트가 커버하는 전체 플래그). */
  covers: readonly DisqualificationFlag[];
}

/**
 * 초기 문항 세트 — 사전 전체 플래그를 커버하는 그룹 체크리스트 형태(저부담, "해당 없음" 일괄).
 * 개별 문항이 아니라 그룹 체크리스트이므로, 한 문항의 covers는 여러 플래그를 known 처리한다.
 * 문항 설계 정교화(카피·UI·입력 타입)는 P3가 이 세트를 기반으로 진행한다.
 */
export const DISQUALIFICATION_QUESTIONS: readonly DisqualificationQuestion[] = [
  {
    id: "tax_delinquency_group",
    axis: "tax_compliance",
    label: "세금·4대보험 체납 여부",
    covers: [
      "national_tax_delinquent",
      "local_tax_delinquent",
      "customs_delinquent",
      "social_insurance_delinquent",
    ],
  },
  {
    id: "credit_distress_group",
    axis: "credit_status",
    label: "신용 연체·채무불이행·부도·압류·보증제한 여부",
    covers: [
      "credit_delinquency",
      "loan_default",
      "bond_default",
      "financial_misconduct",
      "asset_seizure",
      "guarantee_restricted",
    ],
  },
  {
    id: "insolvency_proceeding_group",
    axis: "credit_status",
    label: "회생·파산·법정관리 절차 진행 여부",
    covers: ["rehabilitation_in_progress", "bankruptcy_filed", "court_receivership"],
  },
  {
    id: "financial_sanction_group",
    axis: "sanction",
    label: "정부지원사업 참여제한·부정수급·보조금법 위반 여부",
    covers: ["participation_restricted", "subsidy_fraud", "subsidy_law_violation", "obligation_breach"],
  },
  {
    id: "public_sanction_group",
    axis: "sanction",
    label: "임금체불·중대재해 명단 공개, 협약 위반 여부",
    covers: ["wage_arrears_listed", "serious_accident_listed", "agreement_breach"],
  },
];

/** 문항 id → 커버 플래그 목록(편의 조회). */
export const QUESTION_FLAG_COVERAGE: Record<DisqualificationQuestionId, readonly DisqualificationFlag[]> =
  DISQUALIFICATION_QUESTIONS.reduce(
    (acc, question) => {
      acc[question.id] = question.covers;
      return acc;
    },
    {} as Record<DisqualificationQuestionId, readonly DisqualificationFlag[]>,
  );

/** 특정 문항 응답이 known 처리하는 플래그(프로필 known_flags 갱신용, P3에서 소비). */
export function knownFlagsForQuestion(id: DisqualificationQuestionId): readonly DisqualificationFlag[] {
  return QUESTION_FLAG_COVERAGE[id] ?? [];
}

// ── 공통 배제업종 canonical set (industry `not_in`, §2.3) ──────────────────

export interface ExcludedIndustry {
  /** 안정적 식별자. */
  key: string;
  /** 한국어 라벨. */
  label: string;
  /** KSIC(한국표준산업분류) 코드. numeric prefix 매칭에 사용(industryCodeMatches). */
  ksic: readonly string[];
}

/**
 * 정부지원사업에서 상시 배제되는 업종 canonical set.
 * industry 축 not_in criterion 생성 시 시드로 사용한다(코드 매핑은 KSIC 11차 기준).
 * 일부 항목은 세세분류가 사전(2자리)에 없어 5자리 코드를 그대로 둔다 — industryCodeMatches가
 * numeric prefix로 회사 코드를 포괄 판정한다.
 */
export const EXCLUDED_INDUSTRIES: readonly ExcludedIndustry[] = [
  { key: "general_bar", label: "일반유흥주점업", ksic: ["56211"] },
  { key: "dancing_bar", label: "무도유흥주점업", ksic: ["56212"] },
  { key: "other_bar", label: "기타 주점업", ksic: ["56219"] },
  { key: "gambling_facility", label: "사행시설 관리 및 운영업", ksic: ["91249"] },
  {
    key: "crypto_asset_brokerage",
    label: "블록체인 기반 암호화자산 매매 및 중개업",
    ksic: ["63999"],
  },
  { key: "real_estate", label: "부동산업", ksic: ["68"] },
];

/** 배제업종 전체 KSIC 코드(중복 제거) — not_in criterion value 생성 편의용. */
export const EXCLUDED_INDUSTRY_KSIC_CODES: readonly string[] = [
  ...new Set(EXCLUDED_INDUSTRIES.flatMap((industry) => industry.ksic)),
];
