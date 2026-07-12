import type {
  AuthoringMode,
  CompanyProfile,
  CriterionDimension,
  CriterionKind,
  CriterionResult,
  Eligibility,
  Grant,
  GrantDocumentCategory,
  GrantDocumentPreparationType,
  GrantBenefitFamily,
  GrantBenefitSource,
  GrantStatus,
  MatchRecommendationTier,
  MatchResult,
  MatchReviewReason,
  MatchScoreDisplay,
  WriteSupportLevel,
} from "./index.js";

export type OpportunityBucket = "now" | "soon" | "preparable" | "conditional";
export type RuleTraceChipResult = "pass" | "fail" | "unknown" | "text_only";
export type ChecklistSection = "satisfied" | "needs_check" | "document" | "preferred_miss";
export type ActionType = "progressive" | "external_link" | "apply" | "prepare" | "verify";
export type ActionQueueKind = "input" | "acquire" | "apply" | "enrich" | "review";
export type DocumentSource = "self" | "portal" | "cert";
export type MatchEventKind = "surfaced" | "clicked" | "saved" | "apply_click";
export type FeedbackKind =
  | "saved"
  | "dismissed"
  | "wrong"
  | "applied"
  | "selected"
  | "rejected"
  | "blocked"
  | "note";
export type MatchOutcome = "pending" | "selected" | "rejected" | "blocked";
export type MatchFeedbackReasonCode =
  | "wrong_high"
  | "wrong_low"
  | "wrong_condition"
  | "profile_wrong"
  | "criteria_wrong"
  | "taxonomy_gap"
  | "portal_blocked"
  | "selected"
  | "rejected"
  | "other";
export type ConsentScope = "basic_info" | "hometax" | "insurance";
export type CompanyRole = "owner" | "admin" | "member" | "viewer";
export type NotificationKind = "deadline" | "new_match" | "soon_eligible" | "needs_input";
export type NotificationPriority = "low" | "medium" | "high";
export type DocumentPreparationStatus = "not_started" | "draft_ready" | "needs_user_input" | "reviewed" | "done";
export type DocumentDraftStatus = "draft" | "needs_input" | "reviewed" | "exported" | "archived";
export type DocumentFieldType = "text" | "long_text" | "number" | "date" | "currency" | "checkbox" | "table" | "file" | "unknown";
export type DocumentFillStrategy = "copy" | "summarize" | "generate" | "ask_user" | "manual";
export type DocumentDraftFeedbackKind =
  | "incorrect_fact"
  | "missing_context"
  | "format_issue"
  | "too_generic"
  | "other";

export interface ActionResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
    /**
     * 6.4 크레딧 오류 규약: 402 insufficient_credits 는 { required, available, shortfall } 를 담는다.
     * 기존 필드(code/message/field)는 불변이며 meta 는 선택 필드로 추가된다.
     */
    meta?: Record<string, unknown>;
  };
}

export interface ApiEnvelope<T> {
  data: T | null;
  meta?: {
    cursor?: string | null;
    hasMore?: boolean;
    rulesetVer?: string;
    scoringVer?: string;
  };
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

export interface StatsResult {
  openCount: number;
  totalAmount: number;
  deadlineSoonCount: number;
  updatedAt: string;
}

export interface LandingGrantStats {
  totalCount: number;
  activeCount: number;
  openCount: number;
  upcomingCount: number;
  unknownCount: number;
  deadlineSoonCount: number;
  totalAmount: number;
  sourceCount: number;
  archivedAttachmentCount: number;
  markdownAttachmentCount: number;
  updatedAt: string;
}

export interface LandingGrantBanner {
  grantId: string;
  source: Grant["source"];
  sourceId: string;
  title: string;
  agency: string | null;
  category: string | null;
  status: GrantStatus;
  applyEnd: string | null;
  dDay: number | null;
  supportAmountMax: number;
  benefits: BenefitBadge[];
  regions: string[];
  url: string | null;
}

export interface LandingGrantData {
  stats: LandingGrantStats;
  banners: LandingGrantBanner[];
}

export interface TeaserRequest {
  bizNo?: string;
  profile?: CompanyProfile;
}

export interface TeaserResult {
  attributes: {
    region: string | null;
    size: string | null;
    bizAgeMonths: number | null;
    industry: string[];
  };
  estimatedMaxAmount: number;
  conditionalUpside: number;
  counts: {
    eligible: number;
    conditional: number;
    ineligible: number;
    deadlineSoon: number;
    recommendable?: number;
    reviewNeeded?: number;
    notRecommended?: number;
  };
  matches: MatchCard[];
  recommendableMatches?: MatchCard[];
  reviewNeededMatches?: MatchCard[];
  searchContext?: TeaserSearchContext;
  privacyNote: string;
  companyEvidence?: CompanyEvidence | null;
}

export interface TeaserSearchContext {
  /** 매칭 판정 기준 시각. */
  asOf: string;
  /** 이번 응답을 만들 때 실제로 판정한 공고 수. */
  evaluatedGrantCount: number;
  /** 판정 대상 공고 중 확인 가능한 가장 최근 원본 수집 시각. */
  lastCollectedAt: string | null;
}

export interface MatchCard {
  grantId: string;
  source: Grant["source"];
  sourceId: string;
  title: string;
  agency: string | null;
  status: GrantStatus;
  eligibility: Eligibility;
  bucket: OpportunityBucket;
  fitScore: number;
  competitiveness?: {
    value: number;
    estimated: true;
  };
  value?: number;
  supportAmount: SupportAmount;
  benefits: BenefitBadge[];
  applyEnd: string | null;
  dDay: number | null;
  ruleTrace: RuleTraceChip[];
  matchConfidence: number;
  rulesetVer: string;
  scoringVer: string;
  /** 공고 조건이 구조화 추출됐는지. false면 적합도 미산정(UI는 숫자 대신 —로 표기). */
  criteriaExtracted?: boolean;
  /** 추천 노출 가능 여부. eligibility와 별도로 목록 분리와 정렬에 사용한다. */
  recommendationTier?: MatchRecommendationTier;
  /** 숫자 적합도 표시 여부. hidden이면 UI는 확인 필요 문구를 우선한다. */
  scoreDisplay?: MatchScoreDisplay;
  /** 추천에서 제외되거나 확인 필요로 내려간 이유. */
  reviewReasons?: MatchReviewReason[];
  /** 지원서 작성 방식(수집 시 규칙 분류). */
  authoringMode: AuthoringMode;
  /**
   * 지원서 작성 도움 수준(핵심 BM 신호). core 는 공고 텍스트 신호(작성형 서류·authoring mode)로만
   * 산출하며, template_fill 승격은 apps/web 서버가 HWPX 보관본을 배치 조회해 덮어쓴다(core 는 보관본을 모름).
   */
  writeSupport: WriteSupportLevel;
  detailUrl?: string | null;
}

export interface RuleTraceChip {
  dimension: CriterionDimension;
  kind: CriterionKind;
  result: RuleTraceChipResult;
  label: string;
  companyValue?: string;
  sourceSpan?: string;
  checklistSection: ChecklistSection;
  action?: {
    type: ActionType;
    target: string;
    label: string;
  };
  unlock?: {
    kind: "time" | "attribute";
    detail: string;
    etaDate?: string;
  };
}

export interface RoadmapNode {
  bucket: OpportunityBucket;
  grantId: string;
  title: string;
  unlock?: {
    dimension: CriterionDimension;
    kind: "time" | "attribute";
    detail: string;
    etaDate?: string;
  };
  deltaCount?: number;
}

export interface ApplySheet {
  grant: GrantDetail;
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
  documents: RequiredDocument[];
  sourceAttachments: SourceAttachment[];
  applicationPrep: ApplicationPrep;
  applyMethod: string | null;
  deepLink: string | null;
  schedule: {
    applyStart: string | null;
    applyEnd: string | null;
    dDay: number | null;
  };
}

export interface ApplicationPrep {
  autoSubmitSupported: false;
  profileCopyFields: ProfileCopyField[];
  planDraftPrompts: PlanDraftPrompt[];
  documentGroups: DocumentPreparationGroup[];
  draftableDocuments: DraftableDocument[];
  issuableDocuments: RequiredDocument[];
  attachableDocuments: RequiredDocument[];
  missingProfileFields: MissingFieldQuestion[];
  draftCoverage: DraftCoverage;
}

export interface DocumentPreparationGroup {
  preparationType: GrantDocumentPreparationType | "unknown";
  label: string;
  description: string;
  documents: RequiredDocument[];
}

export interface DraftableDocument {
  documentKey: string;
  name: string;
  category: GrantDocumentCategory | "other";
  canonicalName: string;
  sourceAttachment: string | null;
  templateRequired: boolean;
  confidence: number | null;
  status: DocumentPreparationStatus;
  /**
   * 원본 첨부(sourceAttachment)가 grant_attachment_archives에 .hwpx 보관본으로 존재해
   * "원본 양식에 채움" HWPX 다운로드가 가능한지. core 조립부에서는 항상 false 이고,
   * apps/web 서버 레이어가 보관본을 배치 조회해 덮어쓴다(위장 파일은 다운로드 시 매직바이트로 차단).
   */
  hwpxTemplateAvailable: boolean;
}

export interface DraftCoverage {
  totalDocuments: number;
  draftableCount: number;
  issuableCount: number;
  attachableCount: number;
  otherCount: number;
  withAttachmentContextCount: number;
  missingFieldCount: number;
}

export interface MissingFieldQuestion {
  fieldKey: string;
  label: string;
  reason: string;
  documentName?: string;
  category?: GrantDocumentCategory | "other";
}

export interface ProfileCopyField {
  label: string;
  value: string;
  source: "company_profile" | "grant_context";
}

export interface PlanDraftPrompt {
  title: string;
  prompt: string;
  evidence: string[];
}

export interface DocumentField {
  fieldKey: string;
  label: string;
  section: string | null;
  fieldType: DocumentFieldType;
  required: boolean;
  sourceSpan: string | null;
  sourceAttachment: string | null;
  mappedCompanyField: string | null;
  fillStrategy: DocumentFillStrategy;
  confidence: number;
}

export interface GrantDocumentFormField extends DocumentField {
  documentName: string;
  documentCategory: GrantDocumentCategory | "other";
  parserVersion: string;
}

export interface DocumentAutofillResult {
  filledFields: Record<string, string>;
  missingFields: MissingFieldQuestion[];
  usedProfileFields: string[];
}

export interface DocumentDraft {
  id: string;
  grantId: string;
  companyId: string;
  documentKey: string;
  documentCategory: GrantDocumentCategory | "other";
  documentName: string;
  sourceAttachment: string | null;
  draftMarkdown: string;
  filledFields: Record<string, string>;
  missingFields: MissingFieldQuestion[];
  usedProfileFields: string[];
  assumptions: string[];
  warnings: string[];
  status: DocumentDraftStatus;
  modelVer: string;
  promptVer: string;
  parserVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftGenerationRequest {
  documentKey: string;
  answers?: Record<string, string>;
}

export interface DraftGenerationResult {
  draft: DocumentDraft;
}

export interface DocumentDraftSectionRegenerationRequest {
  sectionTitle: string;
  answers?: Record<string, string>;
  filledFields?: Record<string, string>;
  draftMarkdown?: string;
}

export interface DocumentDraftFeedbackRequest {
  kind: DocumentDraftFeedbackKind;
  message?: string | null;
  selectedText?: string | null;
  fieldLabel?: string | null;
}

export interface DocumentDraftFeedbackResult {
  draftId: string;
  eventId: string;
  kind: DocumentDraftFeedbackKind;
  receivedAt: string;
}

export interface GrantPreparationResult {
  grant: GrantDetail;
  documents: RequiredDocument[];
  sourceAttachments: SourceAttachment[];
  applicationPrep: ApplicationPrep;
  drafts: DocumentDraft[];
  formFields: GrantDocumentFormField[];
  exportUrls: {
    packageMarkdown: string;
    attachmentBundleMarkdown: string;
  };
}

export interface GrantDetail {
  id: string;
  source: Grant["source"];
  sourceId: string;
  title: string;
  agency: string | null;
  supportAmount: SupportAmount;
  benefits: BenefitBadge[];
  status: GrantStatus;
}

export interface RequiredDocument {
  name: string;
  required: boolean;
  source: DocumentSource;
  category?: GrantDocumentCategory;
  preparationType?: GrantDocumentPreparationType;
  canonicalName?: string;
  templateRequired?: boolean;
  sourceAttachment?: string;
  alreadyHave?: boolean;
  fromTextOnly?: boolean;
  sourceSpan?: string;
  note?: string;
  confidence?: number;
}

export interface SourceAttachment {
  filename: string;
  url: string | null;
  sourceUri?: string | null;
  archiveUrl?: string | null;
  markdownUrl?: string | null;
}

export interface NextQuestionDto {
  dimension: CriterionDimension;
  /** 문구·선택지·응답 정책의 버전형 정의 ID. */
  definitionId: string;
  prompt: string;
  // checklist: 결격 그룹 체크리스트("해당 없음" 일괄), number_group: 재무 수치 묶음 입력.
  inputType: "number" | "select" | "boolean" | "text" | "checklist" | "number_group";
  options?: string[];
  unit?: "krw" | "people" | "months" | "years" | "percent" | "count" | null;
  /** 현재 후보 공고가 실제로 요구하는 수치 경계. */
  criterionThresholds?: QuestionCriterionThresholdDto[];
  preciseFollowUp: "never" | "when_range_straddles_threshold";
  responseStage?: "direct" | "range" | "precise";
  rangeOptions?: QuestionRangeOptionDto[];
  framing: string;
  affectedGrantCount: number;
}

export interface QuestionCriterionThresholdDto {
  field: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  value: number;
  unit: NextQuestionDto["unit"];
  affectedGrantCount: number;
}

export interface QuestionRangeOptionDto {
  value: string;
  label: string;
  min: number;
  max: number | null;
  unit: "krw" | "people";
}

export interface ActionQueueItem {
  id: string;
  kind: ActionQueueKind;
  title: string;
  reason: string;
  ctaLabel: string;
  target: string;
  affectedGrantIds: string[];
  affectedGrantCount: number;
  leverageAmount: number;
  urgency: "low" | "medium" | "high";
  effort: "quick" | "medium" | "long";
  score: number;
}

export interface ActionQueueResult {
  actions: ActionQueueItem[];
}

export interface MatchEventRequest {
  event?: MatchEventKind;
  type?: MatchEventKind;
  rulesetVer?: string;
  payload?: Record<string, unknown>;
}

export interface MatchEventReceipt {
  id: string;
  acceptedAt: string;
}

export interface MatchEventResult {
  accepted: boolean;
  companyId: string;
  grantId: string;
  event: MatchEventKind;
  receipt: MatchEventReceipt;
}

export interface MatchFeedbackRequest {
  kind?: FeedbackKind;
  message?: string | null;
  reasonCode?: MatchFeedbackReasonCode | null;
  outcome?: MatchOutcome | null;
  occurredAt?: string | null;
  correction?: MatchFeedbackCorrection | null;
  payload?: Record<string, unknown> | null;
}

export interface MatchFeedbackCorrection {
  dimension?: CriterionDimension | null;
  criterionId?: string | null;
  expectedEligibility?: Eligibility | null;
  correctedEligibility?: Eligibility | null;
  correctedResult?: CriterionResult | null;
  note?: string | null;
}

export interface FeedbackReceipt {
  id: string;
  receivedAt: string;
}

export interface FeedbackResult {
  receipt: FeedbackReceipt;
}

export interface ConsentRecordDto {
  scope: ConsentScope;
  purpose: string;
  grantedAt: string;
  revokedAt: string | null;
}

export interface ConsentListResult {
  companyId: string;
  consents: ConsentRecordDto[];
}

export interface ConsentGrantRequest {
  scope: ConsentScope;
  purpose?: string;
}

export interface ConsentRevokeResult {
  scope: ConsentScope;
  revoked: boolean;
}

export interface CompanyEnrichmentRequest {
  bizNo: string;
}

/** 랜딩 상호명 확인 게이트(팝빌 과금 전 확인 카드) 요청. */
export interface CompanyPreviewRequest {
  bizNo: string;
}

/**
 * 랜딩 상호명 확인 카드에 노출할 최소 필드.
 * 매칭 계산 없이 loadCompanyProfileResolutionForTeaser 결과에서 상호/상태만 추린다.
 * 사업자번호 원문은 절대 담지 않는다(maskedBizNo 만 노출).
 */
export interface CompanyPreviewResult {
  name: string | null;
  maskedBizNo: string;
  businessStatus?: {
    active?: boolean;
    label?: string;
  };
  regionLabel?: string;
  checkedAt?: string;
  cacheStatus?: string;
}

export interface CompanyRecord {
  id: string;
  name: string | null;
  profile: CompanyProfile;
  role?: CompanyRole;
  verified?: boolean;
  verifiedAt?: string | null;
  verifyMethod?: string | null;
  bizNoMasked?: string | null;
}

export interface CompanyListResult {
  companies: CompanyRecord[];
}

export interface CompanyResult {
  company: CompanyRecord;
}

export interface CompanyVerificationRequest {
  bizNo: string;
  ownerName?: string;
  openedOn?: string;
}

export interface CompanyVerificationResult {
  companyId: string;
  bizNoMasked: string;
  verified: boolean;
  verifiedAt: string;
  verifyMethod: string;
}

export interface CompanyEnrichmentFacts {
  maskedBizNo: string | null;
  result: number | string | null;
  resultMessage: string | null;
  checkedAt: string | null;
  hasCorpName: boolean;
  hasRegion: boolean;
  hasBizAge: boolean;
  hasSize: boolean;
  hasIndustry: boolean;
  closeDownState: string | number | null;
  closeDownTaxType: string | number | null;
}

export type CompanyEvidenceProvider = "popbill" | "apick" | "internal" | "manual" | "sample";
export type CompanyEvidenceSource =
  | "popbill_live"
  | "popbill_cache"
  | "apick_live"
  | "apick_cache"
  | "saved_profile"
  | "manual_profile"
  | "sample_profile";
export type CompanyEvidenceCacheStatus = "hit" | "stored" | "none";

export interface CompanyEvidenceField {
  key: string;
  label: string;
  available: boolean;
  value: string | null;
}

export interface CompanyEvidence {
  provider: CompanyEvidenceProvider;
  source: CompanyEvidenceSource;
  cacheStatus: CompanyEvidenceCacheStatus;
  checkedAt: string | null;
  cachedUntil: string | null;
  maskedBizNo: string | null;
  resultMessage: string | null;
  fields: CompanyEvidenceField[];
  summary: string;
}

export interface CompanyEnrichmentResult {
  profile: CompanyProfile;
  facts: CompanyEnrichmentFacts;
  evidence?: CompanyEvidence | null;
}

export interface NotificationSettingsDto {
  deadlineReminder: boolean;
  newMatch: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  priority: NotificationPriority;
  target: string;
  grantId?: string;
  dDay?: number | null;
  etaDate?: string | null;
  rulesetVer: string;
}

export interface NotificationFeedResult {
  generatedAt: string;
  notifications: NotificationItem[];
}

export type NotificationReceiptAction = "read" | "dismiss";
export type NotificationReceiptStatus = "unread" | "read" | "dismissed";

export interface NotificationReceiptRequest {
  notificationId?: string;
  action?: NotificationReceiptAction;
}

export interface NotificationReceiptItem extends NotificationItem {
  status: NotificationReceiptStatus;
  readAt: string | null;
  dismissedAt: string | null;
}

export interface NotificationReceiptResult {
  notification: NotificationReceiptItem;
}

export interface DashboardResult {
  company: {
    name: string | null;
    region: string | null;
    size: string | null;
    bizAgeMonths: number | null;
    industries: string[];
  };
  counts: TeaserResult["counts"];
  matches: MatchCard[];
  roadmap: RoadmapNode[];
  nextQuestion?: NextQuestionDto;
  actionQueue: ActionQueueItem[];
  rulesetVer: MatchResult["ruleset_ver"];
  scoringVer: MatchResult["scoring_ver"];
}

export interface SupportAmount {
  min?: number | null;
  max?: number | null;
  unit: "KRW";
  per: "기업" | "건";
  label?: string | null;
}

export interface BenefitBadge {
  family: GrantBenefitFamily;
  label: string;
  source: GrantBenefitSource;
  confidence: number;
}

// ── 크레딧 조회 API DTO (설계 9.1) ─────────────────────────────────────
// 요율 원시값은 노출하지 않는다(4.13 노출 규약) — 파생 계산값만 내려준다.

/** GET /api/web/credits/balance — 표시 잔액은 available(hold·버퍼 반영)로 통일(9.1). */
export interface CreditBalanceDto {
  balance: number;
  pendingHolds: number;
  available: number;
  lowBalance: boolean;
  expiringSoon: Array<{ lotId: string; remaining: number; expiresAt: string }>;
}

/** GET /api/web/credits/estimate — 사전 견적(요율 원시값이 아니라 계산 결과만, 4.13). */
export interface CreditEstimateDto {
  estimatedCredits: number;
  available: number;
  sufficient: boolean;
}

export type CreditLedgerEntryTypeDto =
  | "signup_bonus_grant"
  | "purchase_grant"
  | "plan_grant"
  | "admin_grant"
  | "promo_grant"
  | "usage_capture"
  | "refund_deduct"
  | "expiry"
  | "admin_deduct"
  | "reversal";

/** GET /api/web/credits/ledger — 분개 목록(커서, 최신순). description 은 서버 한국어 조립. */
export interface CreditLedgerEntryDto {
  id: string;
  entryType: CreditLedgerEntryTypeDto;
  amount: number;
  balanceAfter: number;
  createdAt: string;
  description: string;
}

export interface CreditLedgerListDto {
  entries: CreditLedgerEntryDto[];
  cursor: string | null;
  hasMore: boolean;
}

/** GET /api/web/credits/usage — usage_events 목록 + 기간 합계. 토큰은 상세 토글용(10.3). */
export interface CreditUsageEventDto {
  id: string;
  featureCode: string;
  featureLabel: string;
  creditsCharged: number;
  status: "pending" | "settled" | "failed" | "free";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  contextRef: Record<string, unknown>;
}

export interface CreditUsageSummaryDto {
  totalCredits: number;
  byFeature: Array<{ featureCode: string; featureLabel: string; credits: number; count: number }>;
}

export interface CreditUsageListDto {
  events: CreditUsageEventDto[];
  summary: CreditUsageSummaryDto;
  cursor: string | null;
  hasMore: boolean;
}

// ── P3 결제(충전) DTO (설계 9.1) ────────────────────────────────────────────

/** GET /api/web/credits/products — 활성 충전 상품(공개). */
export interface CreditProductDto {
  code: string;
  name: string;
  amountKrw: number;
  credits: number;
  bonusCredits: number;
  totalCredits: number; // credits + bonusCredits(표시용).
}

export interface CreditProductListDto {
  products: CreditProductDto[];
}

/** POST /api/web/credits/checkout — 브라우저 SDK requestPayment 입력. */
export interface CreditCheckoutDto {
  paymentId: string;
  storeId: string;
  channelKey: string;
  orderName: string;
  totalAmount: number;
}

/** POST /api/web/credits/checkout/complete — 검증·지급 결과. */
export interface CreditCheckoutCompleteDto {
  /** paid=지급 완료 / pending=결제 대기(폴링) / failed=실패 / already=이미 처리. */
  status: "paid" | "pending" | "failed" | "already";
  grantedCredits: number;
  balance: number | null;
  reason?: string;
}

/** GET /api/web/credits/orders — 내 주문 내역. */
export interface CreditOrderDto {
  paymentId: string;
  orderType: string;
  amountKrw: number;
  creditsToGrant: number;
  status: string;
  payMethod: string | null;
  paidAt: string | null;
  refundedAmountKrw: number;
  createdAt: string;
}

export interface CreditOrderListDto {
  orders: CreditOrderDto[];
  cursor: string | null;
  hasMore: boolean;
}

// ── P4 플랜 구독 DTO (설계 9.1 / 10.1 / 10.4) ────────────────────────────────

/** GET /api/web/plans — 플랜 카드. 원시 요율 미노출, 파생 예시 소모량만(4.13). */
export interface CreditPlanDto {
  code: string; // "plus" | "pro" | "flex"
  name: string;
  monthlyPriceKrw: number;
  monthlyCredits: number;
  /** 보너스율 = (monthlyCredits - monthlyPriceKrw) / monthlyPriceKrw (1cr=1krw). 서버 계산. */
  bonusRate: number;
  features?: Record<string, unknown>;
  /** 요율 기반 기능별 예상 소모량(서버가 pricing 으로 채움 — Phase B). 원시 요율 아님(4.13). */
  exampleUsages: Array<{ featureLabel: string; approxCredits: number; approxCount: number }>;
}

/** GET /api/web/plans 의 내 구독 상태(세션 있으면). */
export interface CreditSubscriptionDto {
  planCode: string;
  planName: string;
  status: "incomplete" | "active" | "past_due" | "canceled" | "expired";
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** 다음 결제 예정 금액(KRW). 다운그레이드 예약 반영. */
  nextBillingAmountKrw: number;
  cardBrand: string | null;
  cardLast4: string | null;
  /** 다운그레이드 예약 대상 플랜 코드(없으면 null). */
  pendingPlanCode: string | null;
}

/** GET /api/web/plans 응답 — 플랜 목록 + 내 구독 + (선택)충전 상품 비교 표. */
export interface CreditPlansDto {
  plans: CreditPlanDto[];
  subscription: CreditSubscriptionDto | null;
  products?: CreditProductDto[];
}

/** POST /api/web/plans/subscribe — 구독 시작 결과. */
export interface CreditSubscribeResultDto {
  subscription: CreditSubscriptionDto;
  grantedCredits: number;
}

/** POST /api/web/plans/change — 업/다운 분기 결과. */
export interface CreditPlanChangeResultDto {
  kind: "upgraded" | "downgrade_scheduled";
  subscription: CreditSubscriptionDto;
  /** 즉시 업그레이드 지급분(다운그레이드 예약이면 미포함). */
  grantedCredits?: number;
}

/** POST /api/web/plans/cancel — 해지 예약 결과. */
export interface CreditPlanCancelResultDto {
  cancelAtPeriodEnd: true;
  periodEnd: string;
}

/** POST /api/web/plans/billing-key — 빌링키 교체 결과. */
export interface CreditBillingKeyResultDto {
  ok: true;
  cardBrand: string | null;
  cardLast4: string | null;
}
