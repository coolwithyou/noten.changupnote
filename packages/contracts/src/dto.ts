import type {
  CompanyProfile,
  CriterionDimension,
  CriterionKind,
  Eligibility,
  Grant,
  GrantBenefitFamily,
  GrantBenefitSource,
  GrantStatus,
  MatchResult,
} from "./index.js";

export type OpportunityBucket = "now" | "soon" | "preparable" | "conditional";
export type RuleTraceChipResult = "pass" | "fail" | "unknown" | "text_only";
export type ChecklistSection = "satisfied" | "needs_check" | "document" | "preferred_miss";
export type ActionType = "progressive" | "external_link" | "apply" | "prepare" | "verify";
export type ActionQueueKind = "input" | "acquire" | "apply" | "enrich" | "review";
export type DocumentSource = "self" | "portal" | "cert";
export type MatchEventKind = "surfaced" | "clicked" | "saved" | "apply_click";
export type FeedbackKind = "saved" | "dismissed" | "wrong" | "applied" | "note";
export type ConsentScope = "basic_info" | "hometax" | "insurance";
export type CompanyRole = "owner" | "admin" | "member" | "viewer";
export type NotificationKind = "deadline" | "new_match" | "soon_eligible" | "needs_input";
export type NotificationPriority = "low" | "medium" | "high";

export interface ActionResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
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
  };
  matches: MatchCard[];
  privacyNote: string;
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
  alreadyHave?: boolean;
  fromTextOnly?: boolean;
  sourceSpan?: string;
  note?: string;
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
  prompt: string;
  inputType: "number" | "select" | "boolean" | "text";
  options?: string[];
  framing: string;
  affectedGrantCount: number;
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

export interface CompanyEnrichmentResult {
  profile: CompanyProfile;
  facts: CompanyEnrichmentFacts;
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
