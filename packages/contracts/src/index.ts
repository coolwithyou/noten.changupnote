// enum 단일 원천은 leaf 모듈(enums.ts). openapi.ts와 공유하며 barrel 순환 import를 피한다.
export { CRITERION_DIMENSIONS, MATCH_REVIEW_REASON_CODES } from "./enums.js";
import { CRITERION_DIMENSIONS, MATCH_REVIEW_REASON_CODES } from "./enums.js";

export const CRITERION_OPERATORS = [
  "in",
  "not_in",
  "lte",
  "gte",
  "between",
  "exists",
  "text_only",
] as const;

export const CRITERION_KINDS = ["required", "preferred", "exclusion"] as const;
export const ELIGIBILITIES = ["eligible", "conditional", "ineligible"] as const;
export const MATCH_RECOMMENDATION_TIERS = [
  "recommendable",
  "needs_profile_input",
  "needs_core_review",
  "not_recommended",
] as const;
export const GRANT_BENEFIT_FAMILIES = [
  "funding",
  "loan",
  "capability",
  "space",
  "market",
  "certification",
  "network",
] as const;
export const GRANT_BENEFIT_SOURCES = [
  "structured",
  "support_amount",
  "title",
  "category",
  "apply_method",
] as const;
export const GRANT_DOCUMENT_CATEGORIES = [
  "application_form",
  "business_plan",
  "proposal_or_intro",
  "consent_or_pledge",
  "business_registration",
  "corporate_register",
  "company_confirmation",
  "financial_tax",
  "employment_insurance",
  "shareholder",
  "bank_account",
  "estimate_budget",
  "portfolio_catalog",
  "ip_certification",
  "recommendation",
  "performance_evidence",
  "other",
] as const;
export const GRANT_DOCUMENT_PREPARATION_TYPES = [
  "write",
  "issue",
  "attach",
  "portal",
  "other",
] as const;
export const APPLY_METHOD_CHANNELS = ["online", "email", "fax", "visit", "postal", "other"] as const;
export const AUTHORING_MODES = ["file_form", "web_form", "unknown"] as const;
// 지원서 작성 도움 수준. 핵심 BM(지원서·사업계획서 작성 지원)을 매칭 카드에서 선언하는 단일 신호.
//   - template_fill: 원본 서식(HWPX) 보관본이 있어 채움 다운로드까지 가능
//   - ai_draft:      작성형 서류가 추출되어 AI 초안 작성 가능
//   - web_form_guide: 포털 웹폼 직접 입력 사업 — 항목별 답변 초안·복붙 프로필로 지원
//   - unknown:       판별 신호 부족(원문 확인 필요)
export const WRITE_SUPPORT_LEVELS = ["template_fill", "ai_draft", "web_form_guide", "unknown"] as const;

export type CriterionDimension = (typeof CRITERION_DIMENSIONS)[number];
export type CriterionOperator = (typeof CRITERION_OPERATORS)[number];
export type CriterionKind = (typeof CRITERION_KINDS)[number];
export type Eligibility = (typeof ELIGIBILITIES)[number];
export type MatchRecommendationTier = (typeof MATCH_RECOMMENDATION_TIERS)[number];
export type MatchScoreDisplay = "numeric" | "hidden";
export type ListProfileDimension =
  | "industry"
  | "founder_trait"
  | "certification"
  | "prior_award"
  | "ip"
  | "target_type";
export type ListProfileCompleteness = "partial" | "complete";
export type MatchReviewReasonCode = (typeof MATCH_REVIEW_REASON_CODES)[number];
export type CriterionResult = "pass" | "fail" | "unknown";
export type GrantSource = "kstartup" | "bizinfo" | "bizinfo_event";
export type GrantStatus = "upcoming" | "open" | "closed" | "unknown";
export type GrantDocumentSource = "self" | "portal" | "cert";
export type GrantBenefitFamily = (typeof GRANT_BENEFIT_FAMILIES)[number];
export type GrantBenefitSource = (typeof GRANT_BENEFIT_SOURCES)[number];
export type GrantDocumentCategory = (typeof GRANT_DOCUMENT_CATEGORIES)[number];
export type GrantDocumentPreparationType = (typeof GRANT_DOCUMENT_PREPARATION_TYPES)[number];
export type ApplyMethodChannel = (typeof APPLY_METHOD_CHANNELS)[number];
export type AuthoringMode = (typeof AUTHORING_MODES)[number];
export type WriteSupportLevel = (typeof WRITE_SUPPORT_LEVELS)[number];

export const APPLY_METHOD_CHANNEL_LABELS: Record<ApplyMethodChannel, string> = {
  online: "온라인 접수",
  email: "이메일 접수",
  fax: "팩스 접수",
  visit: "방문 접수",
  postal: "우편 접수",
  other: "기타 접수",
};

export const AUTHORING_MODE_LABELS: Record<AuthoringMode, string> = {
  file_form: "서식 파일 작성",
  web_form: "웹폼 직접 작성",
  unknown: "확인 필요",
};

export const WRITE_SUPPORT_LABELS: Record<WriteSupportLevel, string> = {
  template_fill: "서식 채움 지원",
  ai_draft: "초안 작성 지원",
  web_form_guide: "웹폼 작성 안내",
  unknown: "작성 방식 확인 필요",
};

export interface GrantSupportAmount {
  min?: number | null;
  max?: number | null;
  unit: "KRW";
  per: "기업" | "건";
  label?: string | null;
}

export interface GrantRequiredDocument {
  name: string;
  required: boolean;
  source: GrantDocumentSource;
  category?: GrantDocumentCategory;
  preparation_type?: GrantDocumentPreparationType;
  canonical_name?: string;
  template_required?: boolean;
  source_attachment?: string;
  source_span?: string;
  note?: string;
  confidence?: number;
}

export interface GrantBenefit {
  family: GrantBenefitFamily;
  label: string;
  source: GrantBenefitSource;
  confidence?: number;
}

export interface GrantObligation {
  label: string;
  source: GrantBenefitSource;
  confidence?: number;
}

export interface RegionCriterionValue {
  regions: string[];
  labels?: string[];
  nationwide?: boolean;
  region_group?: string;
}

export interface BizAgeCriterionValue {
  max_months?: number | null;
  min_months?: number | null;
  include_preliminary?: boolean;
  basis?: string;
  labels?: string[];
}

export interface FounderAgeRange {
  min?: number | null;
  max?: number | null;
  label: string;
}

export interface FounderAgeCriterionValue {
  ranges: FounderAgeRange[];
  labels: string[];
  youth_only?: boolean;
}

export interface ListCriterionValue {
  tags?: string[];
  sizes?: string[];
  traits?: string[];
  certs?: string[];
  programs?: string[];
  targets?: string[];
  types?: string[];
}

export interface TextOnlyCriterionValue {
  note: string;
}

/** 결격 축 공용 (tax_compliance / credit_status / sanction) — 공고 측 */
export interface DisqualificationCriterionValue {
  /** canonical 결격 플래그 (@cunote/core disqualification/canonical) */
  flags: string[];
  /** 원문 표기 */
  labels?: string[];
  /** 공고가 허용한 예외 canonical */
  exceptions?: string[];
}

export interface FinancialHealthCriterionValue {
  /** 부채비율 배제 임계. inclusive 여부를 값에 내장해 off-by-boundary 제거. "1,000% 이상 제외" → {value:1000, inclusive:true} */
  debt_ratio_pct_threshold?: { value: number; inclusive: boolean } | null;
  impairment_excluded?: ("partial" | "full")[];
  min_interest_coverage?: number | null;
  labels?: string[];
}

export interface InsuredWorkforceCriterionValue {
  employment_insurance_required?: boolean;
  min_insured?: number | null;
  max_insured?: number | null;
  no_layoff_within_months?: number | null;
  labels?: string[];
}

export interface InvestmentCriterionValue {
  min_total_krw?: number | null;
  rounds?: string[];
  tips_operator_required?: boolean;
  labels?: string[];
}

export type CriterionValue =
  | RegionCriterionValue
  | BizAgeCriterionValue
  | FounderAgeCriterionValue
  | ListCriterionValue
  | TextOnlyCriterionValue
  | DisqualificationCriterionValue
  | FinancialHealthCriterionValue
  | InsuredWorkforceCriterionValue
  | InvestmentCriterionValue
  | Record<string, unknown>;

export interface GrantCriterion {
  id?: string;
  grant_id?: string;
  dimension: CriterionDimension;
  operator: CriterionOperator;
  value: CriterionValue;
  kind: CriterionKind;
  weight?: number;
  confidence: number;
  source_span?: string;
  raw_text?: string;
  source_field?: string;
  needs_review?: boolean;
  parser_version?: string;
}

export interface Grant {
  id?: string;
  source: GrantSource;
  source_id: string;
  title: string;
  url?: string | null;
  agency_jurisdiction?: string | null;
  agency_operator?: string | null;
  agency_primary?: string | null;
  category_l1?: string | null;
  category_l2?: string | null;
  apply_start?: string | null;
  apply_end?: string | null;
  apply_method?: Record<string, string | null>;
  support_amount?: GrantSupportAmount | Record<string, unknown> | null;
  required_documents?: GrantRequiredDocument[] | null;
  benefits?: GrantBenefit[] | null;
  obligations?: GrantObligation[] | null;
  status: GrantStatus;
  f_regions: string[];
  f_industries: string[];
  f_biz_age_min_months?: number | null;
  f_biz_age_max_months?: number | null;
  f_sizes: string[];
  f_founder_traits: string[];
  f_required_certs: string[];
  f_apply_methods?: ApplyMethodChannel[];
  f_authoring_mode?: AuthoringMode;
  overall_confidence: number;
  model_ver?: string | null;
  prompt_ver?: string | null;
  parser_version?: string;
  updated_at?: string | null;
}

export interface GrantRaw<TPayload = unknown> {
  source: GrantSource;
  source_id: string;
  payload: TPayload;
  attachments?: Array<{
    filename: string;
    url?: string | null;
    source_uri?: string | null;
    archive_url?: string | null;
    storage_key?: string | null;
    content_type?: string | null;
    bytes?: number | null;
    sha256?: string | null;
    fetched_at?: string | null;
    conversion?: {
      status: "converted" | "skipped" | "failed";
      markdown_url?: string | null;
      markdown_storage_key?: string | null;
      markdown_sha256?: string | null;
      markdown_bytes?: number | null;
      converter?: string | null;
      converted_at?: string | null;
      error?: string | null;
    };
  }> | null;
  raw_hash?: string;
  collected_at?: string;
  status: "fetched" | "converted" | "extracted" | "normalized" | "published" | "failed";
}

export interface NormalizedGrant<TPayload = unknown> {
  raw: GrantRaw<TPayload>;
  grant: Grant;
  criteria: GrantCriterion[];
}

/**
 * 결격 3축 공용 프로필 값 (tax_compliance / credit_status / sanction).
 * 대칭 구조 + 플래그 단위 지식. `known_flags`는 문항→플래그 커버 매핑
 * (@cunote/core disqualification/canonical)으로 기록되며, 판정은 이 위에서
 * 플래그 단위 known 게이트를 적용한다.
 */
export interface DisqualificationProfileValue {
  /** 보유 결격 (canonical) */
  flags: string[];
  /** 질의·확인이 이뤄진 플래그 — 문항→플래그 커버 매핑으로 기록 */
  known_flags: string[];
  /** 보유 예외 (canonical, 예: payment_deferral_approved) */
  exceptions: string[];
}

export type CompanyProfileEvidenceSourceKind =
  | "authoritative_api"
  | "public_registry"
  | "auth_supplied"
  | "self_declared"
  | "derived";

export interface CompanyProfileEvidenceObservation {
  sourceKind: CompanyProfileEvidenceSourceKind;
  provider: string;
  asOf: string | null;
  axisCompleteness: "partial" | "complete";
  confidence: number | null;
}

export interface CompanyProfileFieldEvidence extends CompanyProfileEvidenceObservation {
  supplemental?: CompanyProfileEvidenceObservation[];
}

export interface CompanyProfileQuestionAnswerState {
  status: "unknown" | "range";
  answeredAt: string;
  expiresAt: string;
  sourceKind: "self_declared";
  rulesetVer: string | null;
  min?: number;
  max?: number | null;
  unit?: "krw" | "people";
}

export interface CompanyProfile {
  id?: string;
  name?: string;
  region?: {
    code: string;
    label?: string;
  };
  biz_age_months?: number | null;
  founder_age?: number | null;
  is_preliminary?: boolean;
  industries?: string[];
  /** KSIC 파생 코드(원 코드 + 중분류 2자리 + 대분류 A~U). 라벨은 industries에 둔다. */
  industry_codes?: string[];
  size?: string | null;
  revenue_krw?: number | null;
  employees_count?: number | null;
  traits?: string[];
  certs?: string[];
  prior_awards?: string[];
  ip?: string[];
  target_types?: string[];
  list_completeness?: Partial<Record<ListProfileDimension, ListProfileCompleteness>>;
  other_conditions?: Record<string, unknown> | null;
  business_status?: {
    active?: boolean;
    close_down_state?: string | number | null;
    close_down_tax_type?: string | number | null;
    label?: string;
  };
  // ── 결격·재무·고용·투자 축 (공고매칭 차원 확장) ──────────────────────────
  tax_compliance?: DisqualificationProfileValue;
  credit_status?: DisqualificationProfileValue;
  sanction?: DisqualificationProfileValue;
  financial_health?: {
    debt_ratio_pct?: number | null;
    impairment?: "none" | "partial" | "full" | null; // 자본총계·자본금 입력 시 파생 계산 가능(P3)
    interest_coverage_ratio?: number | null; // 이자보상배율(영업이익/이자비용). 음수 가능(영업손실). null=미상
    total_assets_krw?: number | null; // size(중기법) 판정 정밀화에도 사용
    equity_krw?: number | null;
    capital_krw?: number | null;
    fiscal_year?: string;
  };
  insured_workforce?: {
    employment_insurance_active?: boolean;
    insured_count?: number | null;
    months_since_last_layoff?: number | null; // null=미상. 감원 없음은 no_layoff 로 구분
    no_layoff?: boolean;
  };
  investment?: {
    total_raised_krw?: number | null;
    last_round?: string | null;
    tips_backed?: boolean;
  };
  // premises / export_performance: 예약 축 — enum·타입 자리만. 프로필 필드는 후속 트랙에서 신설.
  confidence?: Partial<Record<CriterionDimension, number>>;
  profile_evidence?: Partial<Record<CriterionDimension, CompanyProfileFieldEvidence>>;
  question_answer_state?: Partial<Record<CriterionDimension, CompanyProfileQuestionAnswerState>>;
}

export interface RuleTraceEntry {
  criterion_id?: string;
  dimension: CriterionDimension;
  kind: CriterionKind;
  operator: CriterionOperator;
  result: CriterionResult;
  source_span?: string;
  company_value?: unknown;
  message: string;
}

export interface MatchReviewReason {
  code: MatchReviewReasonCode;
  dimension: CriterionDimension;
  label: string;
  sourceSpan?: string;
}

export interface MatchReviewGate {
  tier: MatchRecommendationTier;
  scoreDisplay: MatchScoreDisplay;
  reasons: MatchReviewReason[];
}

export interface NextQuestion {
  field: CriterionDimension;
  prompt: string;
  reason: string;
}

export interface MatchResult {
  eligibility: Eligibility;
  fit_score: number;
  rule_trace: RuleTraceEntry[];
  unknown_fields: CriterionDimension[];
  next_question?: NextQuestion;
  ruleset_ver: string;
  scoring_ver: string;
  /** 공고에서 구조화된 조건(criteria)이 1건 이상 추출됐는지. 0건이면 false(미산정). */
  criteria_extracted: boolean;
  /** 추천 노출 가능 여부와 점수 표시 정책. eligibility 판정과 별도로 UI/정렬에서 사용한다. */
  review_gate?: MatchReviewGate;
}

export * from "./bizno.js";
export * from "./dto.js";
export * from "./openapi.js";
