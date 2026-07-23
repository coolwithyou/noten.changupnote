import type {
  CompanyProfile,
  CriterionConfirmation,
  FeedbackKind,
  MatchFeedbackCorrection,
  MatchFeedbackProvenance,
  MatchFeedbackReasonCode,
  MatchEventKind,
  MatchOutcome,
  MatchResult,
  NormalizedGrant,
  ProfileQuestionEventReceiptDto,
  ProfileUpdateImpactDto,
  RoadmapNode,
} from "@cunote/contracts";
import type { MatchTransitionCandidate } from "../use-cases/plan-match-transitions.js";
import type { RegistryRecord, RegistryType } from "../registry/types.js";
import type { CreditRepository, CreditSystemRepository } from "../credits/ports.js";
import type { CreditPaymentRepository } from "../credits/payments.js";
import type { CreditSubscriptionRepository } from "../credits/subscriptionPort.js";

export interface GrantListOptions {
  limit?: number;
  asOf?: Date;
  /** dedup 품질 보고·재발행에서만 confirmed member occurrence까지 포함한다. 사용자 목록 기본값은 false. */
  includeConfirmedDuplicates?: boolean;
}

export interface GrantRepository<TPayload = unknown> {
  listActiveGrants(options?: GrantListOptions): Promise<Array<NormalizedGrant<TPayload>>>;
  findGrantById(grantId: string, options?: GrantListOptions): Promise<NormalizedGrant<TPayload> | null>;
  /**
   * 공고 id 목록으로 있는 그대로 로딩한다 — status·활성 필터·dedup 없음(read-only).
   * 코호트 공고가 실험 중 마감(closed)돼도 누락되면 안 되는 섀도 측정·승격 트랙 용도.
   */
  listGrantsByIds(ids: string[]): Promise<Array<NormalizedGrant<TPayload>>>;
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
  /** 회사에 저장된 사업자번호 원문을 반환한다. 없으면 null. */
  getCompanyBizNo(input: GetCompanyBizNoInput): Promise<string | null>;
}

export interface GetCompanyBizNoInput {
  companyId: string;
  userId?: string;
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
  saveProfileQuestionEvent(input: SaveProfileQuestionEventInput): Promise<ProfileQuestionEventReceipt>;
  /**
   * (company, grants) 자가신고 확인 답변을 criterion 연결(grant_criteria.id)로 읽는다(확인 루프 Phase B).
   * 반환 Map 키는 grants.id. optional — 미구현 리포지토리는 확인 답변 없음으로 동작한다.
   */
  listCriterionConfirmations?(input: {
    companyId: string;
    grantIds: string[];
  }): Promise<ReadonlyMap<string, CriterionConfirmation[]>>;
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

export interface SaveProfileQuestionEventInput {
  companyId: string;
  sessionId: string;
  impact: ProfileUpdateImpactDto;
  rulesetVer: string;
  userId?: string;
}

export type ProfileQuestionEventReceipt = ProfileQuestionEventReceiptDto;

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
  provenance?: MatchFeedbackProvenance | null;
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

export interface ClaimEnrichmentCacheInput extends WriteEnrichmentCacheInput {
  /** 기존 행의 만료 여부를 판정할 기준 시각. */
  now: Date;
  /** null은 명시적 해제/정산 전까지 다시 획득할 수 없는 fail-closed guard다. */
  expiresAt: Date | null;
}

export interface DeleteEnrichmentCacheInput {
  bizNo: string;
  provider?: string;
  scope?: string;
}

export interface EnrichmentCacheRepository {
  getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry>;
  /** 행이 없거나 이미 만료된 경우에만 단일 원자 연산으로 lease를 획득한다. */
  claim(input: ClaimEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  /** 만료 여부와 무관하게 사업자번호에 걸린 모든 캐시 행을 반환한다(개발 진단용). */
  listByBizNo(bizNo: string): Promise<EnrichmentCacheEntry[]>;
  /** 사업자번호(옵션: provider/scope)로 캐시 행을 삭제하고 삭제된 행 수를 반환한다. */
  deleteByBizNo(input: DeleteEnrichmentCacheInput): Promise<number>;
}

export interface RoadmapRepository {
  listCompanyRoadmap(companyId: string): Promise<RoadmapNode[]>;
}

/** registry_index 후보 조회 조건(정확 매칭 인덱스만 — 퍼지는 호출측 matchRegistry). */
export interface RegistryCandidateQuery {
  /** 숫자만 정규화된 사업자번호. */
  bizNo?: string | null;
  /** 숫자만 정규화된 법인번호. */
  corpNo?: string | null;
  /** normalizeCompanyName 결과(정확 일치 후보 로드용). */
  nameNormalized?: string | null;
  /** 명단 종류 한정(옵션). */
  registryType?: RegistryType | null;
}

/**
 * 공개명단 배치 색인(registry_index) 접근 포트. 오프라인 적재(replaceBySource)와
 * 런타임 조회(findCandidates/hasSource)를 한 포트로 노출한다. 퍼지 스코어링은 이 포트가
 * 아니라 호출측 matchRegistry 가 인메모리로 수행한다.
 */
export interface RegistryIndexRepository {
  /** 사업자번호·법인번호·정규화 상호 중 하나라도 일치하는 후보 행. 조건 전무면 빈 배열. */
  findCandidates(input: RegistryCandidateQuery): Promise<RegistryRecord[]>;
  /** 소스(데이터셋)가 1건이라도 적재됐는지. known_on_absence 판정용(적재+부재=clear). */
  hasSource(source: string): Promise<boolean>;
  /** 소스 전량 재적재(기존 소스 행 삭제 후 삽입). 삽입된 행 수 반환. */
  replaceBySource(source: string, records: RegistryRecord[]): Promise<number>;
}

export interface ServiceRepositories<TPayload = unknown> {
  grants: GrantRepository<TPayload>;
  companies: CompanyRepository;
  matches: MatchRepository<TPayload>;
  feedback: FeedbackRepository;
  enrichmentCache: EnrichmentCacheRepository;
  /** 공개명단 배치 색인(조달청 부정당·인증 공개명단·중대재해·체불·TIPS). 설계 §6′-C. */
  registryIndex: RegistryIndexRepository;
  /** 크레딧 원장(user 컨텍스트 경유 진입점). 설계 4.13 / 6.1. */
  credits: CreditRepository;
  /** 크레딧 시스템 경로(웹훅·cron·익명 미터링). user 컨텍스트 없는 신뢰 서버 경로. 설계 4.13. */
  creditsSystem: CreditSystemRepository;
  /** 결제·충전(포트원 단건). 세션 없는 내부 함수(verifyAndGrant·웹훅·주문 cron). 설계 7장 / P3. */
  creditsPayment: CreditPaymentRepository;
  /** 플랜 구독(포트원 빌링키·예약결제). 세션 없는 내부 함수(subscribe·갱신 웹훅·갱신 cron). 설계 8장 / P4. */
  creditsSubscription: CreditSubscriptionRepository;
}
