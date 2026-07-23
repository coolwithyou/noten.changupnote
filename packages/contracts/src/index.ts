// enum 단일 원천은 leaf 모듈(enums.ts). openapi.ts와 공유하며 barrel 순환 import를 피한다.
export { CRITERION_DIMENSIONS, GRANT_AUDIENCES, MATCH_REVIEW_REASON_CODES } from "./enums.js";
import { CRITERION_DIMENSIONS, GRANT_AUDIENCES, MATCH_REVIEW_REASON_CODES } from "./enums.js";

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
export const HUMAN_REVIEW_CRITERION_VERDICTS = [
  "correct",
  "needs_edit",
  "wrong",
  "unsure",
] as const;
export const HUMAN_REVIEW_AXIS_VERDICTS = [
  "confirmed_absent",
  "missed_condition",
] as const;
export const HUMAN_REVIEW_VERDICTS = [
  ...HUMAN_REVIEW_CRITERION_VERDICTS,
  ...HUMAN_REVIEW_AXIS_VERDICTS,
] as const;
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
export type HumanReviewCriterionVerdict = (typeof HUMAN_REVIEW_CRITERION_VERDICTS)[number];
export type HumanReviewAxisVerdict = (typeof HUMAN_REVIEW_AXIS_VERDICTS)[number];
export type HumanReviewVerdict = (typeof HUMAN_REVIEW_VERDICTS)[number];

export function isHumanReviewVerdictForItemKind(
  itemKind: "criterion" | "axis" | "question_check",
  verdict: string,
): verdict is HumanReviewVerdict {
  const vocabulary =
    itemKind === "axis" ? HUMAN_REVIEW_AXIS_VERDICTS : HUMAN_REVIEW_CRITERION_VERDICTS;
  return (vocabulary as readonly string[]).includes(verdict);
}

export function humanReviewVerdictRequiresNote(verdict: HumanReviewVerdict): boolean {
  return verdict !== "correct" && verdict !== "confirmed_absent";
}
export type Eligibility = (typeof ELIGIBILITIES)[number];
export type MatchRecommendationTier = (typeof MATCH_RECOMMENDATION_TIERS)[number];
export type MatchScoreDisplay = "numeric" | "hidden";
export type MatchEligibilityConfidence = "high" | "medium" | "low";
export type MatchExtractionReadiness =
  | "reviewed"
  | "structured_unreviewed"
  | "partial"
  | "unstructured";
export type GrantExtractionWarningCode =
  | "criteria_missing"
  | "text_only_criterion_present"
  | "criterion_review_required"
  | "hard_criterion_evidence_missing"
  | "source_field_missing"
  | "source_section_missing"
  | "attachment_fetch_incomplete"
  | "attachment_conversion_incomplete"
  | "attachment_conversion_failed";
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
export type GrantAudience = (typeof GRANT_AUDIENCES)[number];
export type GrantDocumentSource = "self" | "portal" | "cert";
export type GrantBenefitFamily = (typeof GRANT_BENEFIT_FAMILIES)[number];
export type GrantBenefitSource = (typeof GRANT_BENEFIT_SOURCES)[number];
export type GrantDocumentCategory = (typeof GRANT_DOCUMENT_CATEGORIES)[number];
export type GrantDocumentPreparationType = (typeof GRANT_DOCUMENT_PREPARATION_TYPES)[number];
export type ApplyMethodChannel = (typeof APPLY_METHOD_CHANNELS)[number];
export type AuthoringMode = (typeof AUTHORING_MODES)[number];
export type WriteSupportLevel = (typeof WRITE_SUPPORT_LEVELS)[number];

export const GRANT_AUDIENCE_LABELS: Record<GrantAudience, string> = {
  company: "기업 대상",
  individual: "개인 대상",
  mixed: "기업·개인 혼합",
  unknown: "미분류",
};

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

export type PriorAwardScope = "self" | "program" | "program_type";
export type PriorAwardSelfKind =
  | "current_similar"
  | "same_project"
  | "same_business_prior"
  | "same_year_other_support";
export type PriorAwardState = "participating" | "completed" | "graduated";

/** 공고가 요구·배제·우대하는 수혜/참여 이력 조건. */
export interface PriorAwardCriterionValue {
  scope: PriorAwardScope;
  self_kind?: PriorAwardSelfKind;
  channel?: "general" | "incubation_tenancy";
  programs?: string[];
  states?: PriorAwardState[];
  within?: { value: number; unit: "year" | "month" } | null;
  labels?: string[];
}

export interface PriorAwardRecord {
  program?: string;
  agency?: string;
  year?: number | null;
  state: PriorAwardState;
}

export interface PriorAwardProfileValue {
  records: PriorAwardRecord[];
  self_flags?: Partial<Record<PriorAwardSelfKind, boolean>>;
  has_incubation_tenancy?: boolean;
  known_programs: string[];
  known_program_types: string[];
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
  | PriorAwardCriterionValue
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
  audience?: GrantAudience;
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
      ocr_provider?: string | null;
      ocr_confidence?: number | null;
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
  /** 공고 입력·첨부·조건 추출의 완전성. 미제공 시 소비 시점에 raw/criteria에서 재계산한다. */
  extraction_manifest?: GrantExtractionManifest;
}

export interface GrantExtractionManifest {
  grantId: string;
  revision: string;
  sourceFieldsSeen: string[];
  attachmentsExpected: number;
  attachmentsFetched: number;
  attachmentsConverted: number;
  sectionsDetected: string[];
  extractorVersion: string;
  completedAt: string;
  warnings: GrantExtractionWarningCode[];
  readiness: MatchExtractionReadiness;
  reviewedAt?: string | null;
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

export type CompanyProfileObservationScope = "shared" | "user";

export type CompanyProfileObservationPersistenceClass =
  | "portable_user_answer"
  | "versioned_provider_observation";

/**
 * Optional wire metadata for observations persisted in the legacy profile row.
 * Older readers ignore these additive keys while P1 readers use them to make
 * row order irrelevant and rollback-safe.
 */
export interface CompanyProfileObservationMetadata {
  scope?: CompanyProfileObservationScope;
  observationId?: string;
  observationVersion?: string;
  /** Stable canonical JSON used by deterministic tie/conflict handling. */
  canonicalValue?: string;
  persistenceClass?: CompanyProfileObservationPersistenceClass;
  resolverVersion?: string;
}

export interface CompanyProfileEvidenceObservation extends CompanyProfileObservationMetadata {
  sourceKind: CompanyProfileEvidenceSourceKind;
  provider: string;
  asOf: string | null;
  axisCompleteness: "partial" | "complete";
  confidence: number | null;
}

export interface CompanyProfileFieldEvidence extends CompanyProfileEvidenceObservation {
  /** merge로 권위값에 사용자 보완값 등을 더했을 때 primary를 지우지 않고 보존한다. */
  supplemental?: CompanyProfileEvidenceObservation[];
}

export interface CompanyProfileQuestionAnswerState {
  status: "unknown" | "range";
  answeredAt: string;
  expiresAt: string;
  sourceKind: "self_declared";
  rulesetVer: string | null;
  /** range 상태에서만 사용. max=null은 상한 없음. */
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
  prior_award_history?: PriorAwardProfileValue;
  ip?: string[];
  target_types?: string[];
  /**
   * list 값의 부재를 판정 근거로 쓸 수 있는지 표시한다.
   * 미설정/partial은 positive-only이며, complete일 때만 no-hit를 fail/pass로 확정한다.
   */
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
  /** 축별 원천·기준일·완전성. 값과 분리해 API/자가응답/파생값을 추적한다. */
  profile_evidence?: Partial<Record<CriterionDimension, CompanyProfileFieldEvidence>>;
  /** 값이 아니라 질문 반복 억제 상태. unknown은 매칭의 known 근거로 사용하지 않는다. */
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
  /** 사용자 자가신고 확인으로 판정이 해소·확정된 entry 표시("본인 확인 기반" 뱃지 근거). */
  resolution?: "confirmed_by_user";
}

/**
 * (company, grant) 스코프 자가신고 확인 답변 1건이 해소하는 exclusion criterion 연결(확인 루프 Phase B).
 * criterion 연결은 grant_criteria.id 단일 기준 — 재발행으로 연결이 끊긴 질문의 답변은 전달하지 않는다(미답변과 동일).
 */
export interface CriterionConfirmation {
  /** grant_criteria.id — 질문 발행 시 앵커된 criterion. */
  criterion_id: string;
  /** 판정 시점 옵션 극성 스냅샷: true = 결격 해당(자가신고). */
  disqualified: boolean;
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

/**
 * 자격 판정의 신뢰 근거. `fit_score`와 선정 가능성을 혼동하지 않도록
 * 조건 확인 완성도·원문 근거·공고 추출 준비도를 분리한다.
 */
export interface MatchQuality {
  eligibilityConfidence: MatchEligibilityConfidence;
  /** 필수·제외조건 중 회사 값으로 pass/fail을 확정한 가중 비율(0..100). */
  verificationCompleteness: number;
  /** 필수·제외조건 중 source_span/source_field 근거가 있는 가중 비율(0..100). */
  evidenceCoverage: number;
  extractionReadiness: MatchExtractionReadiness;
}

/**
 * 자격 판정과 독립적인 목록 정렬 신호. 두 점수 모두 선정 가능성을 뜻하지 않으며,
 * 자격·검수 게이트를 통과한 동일 그룹 안에서만 순서를 정하는 데 사용한다.
 */
export interface MatchRanking {
  /** 회사 업종·KSIC·관심 목표와 공고 분야의 설명 가능한 관련성(0..100). */
  relevanceScore: number | null;
  /** 마감·혜택·준비 부담·미확인 조건을 합친 실행 우선순위(0..100). */
  priorityScore: number | null;
  /** 사용자에게 퍼센트 대신 보여줄 수 있는 짧은 정렬 근거. */
  reasons: string[];
}

export interface NextQuestion {
  field: CriterionDimension;
  prompt: string;
  reason: string;
}

export interface MatchResult {
  eligibility: Eligibility;
  /** @deprecated 호환 필드. 현재는 `quality.verificationCompleteness`와 동일하다. */
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
  /** 자격 판정·확인 완성도·근거 품질. 선정 가능성 점수가 아니다. */
  quality: MatchQuality;
  /** 목록 정렬용 관련성·실행 우선순위. eligibility를 변경하지 않는다. */
  ranking?: MatchRanking;
}

export * from "./bizno.js";
export * from "./dto.js";
export * from "./openapi.js";
