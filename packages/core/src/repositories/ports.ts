import type {
  CompanyProfile,
  FeedbackKind,
  MatchFeedbackCorrection,
  MatchFeedbackReasonCode,
  MatchEventKind,
  MatchOutcome,
  MatchResult,
  NormalizedGrant,
  RoadmapNode,
} from "@cunote/contracts";
import type { MatchTransitionCandidate } from "../use-cases/plan-match-transitions.js";
import type { CreditRepository, CreditSystemRepository } from "../credits/ports.js";
import type { CreditPaymentRepository } from "../credits/payments.js";
import type { CreditSubscriptionRepository } from "../credits/subscriptionPort.js";

export interface GrantListOptions {
  limit?: number;
  asOf?: Date;
}

export interface GrantRepository<TPayload = unknown> {
  listActiveGrants(options?: GrantListOptions): Promise<Array<NormalizedGrant<TPayload>>>;
  findGrantById(grantId: string, options?: GrantListOptions): Promise<NormalizedGrant<TPayload> | null>;
}

export type CompanyRole = "owner" | "admin" | "member" | "viewer";

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

export interface ResolveCompanyProfileInput {
  companyId?: string;
  bizNo?: string;
  userId?: string;
}

export interface SaveCompanyProfileInput {
  companyId: string;
  profile: CompanyProfile;
  userId?: string;
}

export interface CreateCompanyInput {
  profile: CompanyProfile;
  userId: string;
}

export interface VerifyCompanyInput {
  companyId: string;
  userId: string;
  bizNo: string;
  ownerName?: string;
  openedOn?: string;
  verifyMethod?: string;
}

export interface CompanyVerificationRecord {
  companyId: string;
  bizNo: string;
  verified: boolean;
  verifiedAt: string;
  verifyMethod: string;
}

export interface CompanyRepository {
  getDefaultCompanyProfile(): Promise<CompanyProfile>;
  resolveCompanyProfile(input?: ResolveCompanyProfileInput): Promise<CompanyProfile | null>;
  createCompany(input: CreateCompanyInput): Promise<CompanyRecord>;
  saveCompanyProfile(input: SaveCompanyProfileInput): Promise<CompanyProfile>;
  verifyCompany(input: VerifyCompanyInput): Promise<CompanyVerificationRecord>;
  listUserCompanies(userId: string): Promise<CompanyRecord[]>;
}

export interface MatchState<TPayload = unknown> {
  grant: NormalizedGrant<TPayload>;
  match: MatchResult;
}

export interface MatchRepository<TPayload = unknown> {
  calculateGrantMatch(input: {
    company: CompanyProfile;
    grant: NormalizedGrant<TPayload>;
  }): Promise<MatchResult>;
  calculateGrantMatches(input: {
    company: CompanyProfile;
    grants: Array<NormalizedGrant<TPayload>>;
  }): Promise<Array<MatchState<TPayload>>>;
  saveMatchState(input: {
    companyId: string;
    grantId: string;
    match: MatchResult;
    eligibleFrom?: Date | null;
    eligibleUntil?: Date | null;
    userId?: string;
  }): Promise<void>;
  listDueMatchTransitions(input: {
    asOf: Date;
    limit?: number;
    userId?: string;
  }): Promise<MatchTransitionCandidate[]>;
  saveMatchEvent(input: SaveMatchEventInput): Promise<MatchEventReceipt>;
}

export interface SaveMatchEventInput {
  companyId: string;
  grantId: string;
  event: MatchEventKind;
  rulesetVer?: string;
  userId?: string;
}

export interface MatchEventReceipt {
  id: string;
  acceptedAt: string;
}

export type { FeedbackKind } from "@cunote/contracts";

export interface SubmitFeedbackInput {
  companyId: string;
  grantId: string;
  kind: FeedbackKind;
  userId?: string;
  message?: string | null;
  reasonCode?: MatchFeedbackReasonCode | null;
  outcome?: MatchOutcome | null;
  occurredAt?: string | null;
  correction?: MatchFeedbackCorrection | null;
  payload?: Record<string, unknown> | null;
}

export interface FeedbackReceipt {
  id: string;
  receivedAt: string;
}

export interface FeedbackRepository {
  submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackReceipt>;
}

export interface EnrichmentCacheEntry {
  provider: string;
  bizNo: string;
  scope: string;
  rawPayload?: Record<string, unknown> | null;
  canonicalPayload?: Record<string, unknown> | null;
  providerResultCode?: string | null;
  providerResultMessage?: string | null;
  checkedAt?: Date | null;
  fetchedAt: Date;
  expiresAt?: Date | null;
  payloadHash?: string | null;
  lastError?: Record<string, unknown> | null;
}

export interface ReadEnrichmentCacheInput {
  provider: string;
  bizNo: string;
  scope: string;
  now?: Date;
}

export interface WriteEnrichmentCacheInput {
  provider: string;
  bizNo: string;
  scope: string;
  rawPayload?: Record<string, unknown> | null;
  canonicalPayload?: Record<string, unknown> | null;
  providerResultCode?: string | null;
  providerResultMessage?: string | null;
  checkedAt?: Date | null;
  fetchedAt?: Date;
  expiresAt?: Date | null;
  payloadHash?: string | null;
  lastError?: Record<string, unknown> | null;
}

export interface DeleteEnrichmentCacheInput {
  bizNo: string;
  provider?: string;
  scope?: string;
}

export interface EnrichmentCacheRepository {
  getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry>;
  /** 만료 여부와 무관하게 사업자번호에 걸린 모든 캐시 행을 반환한다(개발 진단용). */
  listByBizNo(bizNo: string): Promise<EnrichmentCacheEntry[]>;
  /** 사업자번호(옵션: provider/scope)로 캐시 행을 삭제하고 삭제된 행 수를 반환한다. */
  deleteByBizNo(input: DeleteEnrichmentCacheInput): Promise<number>;
}

export interface RoadmapRepository {
  listCompanyRoadmap(companyId: string): Promise<RoadmapNode[]>;
}

export interface ServiceRepositories<TPayload = unknown> {
  grants: GrantRepository<TPayload>;
  companies: CompanyRepository;
  matches: MatchRepository<TPayload>;
  feedback: FeedbackRepository;
  enrichmentCache: EnrichmentCacheRepository;
  /** 크레딧 원장(user 컨텍스트 경유 진입점). 설계 4.13 / 6.1. */
  credits: CreditRepository;
  /** 크레딧 시스템 경로(웹훅·cron·익명 미터링). user 컨텍스트 없는 신뢰 서버 경로. 설계 4.13. */
  creditsSystem: CreditSystemRepository;
  /** 결제·충전(포트원 단건). 세션 없는 내부 함수(verifyAndGrant·웹훅·주문 cron). 설계 7장 / P3. */
  creditsPayment: CreditPaymentRepository;
  /** 플랜 구독(포트원 빌링키·예약결제). 세션 없는 내부 함수(subscribe·갱신 웹훅·갱신 cron). 설계 8장 / P4. */
  creditsSubscription: CreditSubscriptionRepository;
}
