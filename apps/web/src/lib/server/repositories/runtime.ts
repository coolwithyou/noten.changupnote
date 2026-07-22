import {
  CreditContextRequiredError,
  InsufficientCreditsError,
  InvalidLedgerEntryError,
  WalletFrozenError,
  allocateFromLots,
  allocateFromTargetLots,
  computeChainHash,
  genesisHash,
  grantKey,
  grantLotBreakdown,
  idempotencyKeys,
  maskCorpNum,
  matchNormalizedGrant,
  sortLotsForConsumption,
} from "@cunote/core";
import type {
  CompanyProfile,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import type {
  ApplyLedgerEntryInput,
  CaptureHoldResult,
  ClaimEnrichmentCacheInput,
  CompanyRecord,
  CompanyRepository,
  CreateCompanyInput,
  CreditHoldRecord,
  CreditLedgerEntryRecord,
  CreditLotRecord,
  CreditOrderRecord,
  CreditPaymentRepository,
  CreditPlanRecord,
  CreditProductRecord,
  CreditRepository,
  CreditSubscriptionRecord,
  CreditSubscriptionRepository,
  CreditSystemRepository,
  CreditWalletRecord,
  ActivateSubscriptionResult,
  RenewSubscriptionResult,
  UpgradeSubscriptionResult,
  FailedWebhookEvent,
  OrderLotSnapshot,
  LedgerListRow,
  TokenUsage,
  UsageListRow,
  DeleteEnrichmentCacheInput,
  EnrichmentCacheEntry,
  EnrichmentCacheRepository,
  FeedbackReceipt,
  FeedbackRepository,
  GrantListOptions,
  GrantRepository,
  LotBreakdownLine,
  MatchEventReceipt,
  MatchRepository,
  ProfileQuestionEventReceipt,
  PricingRule,
  ResolveCompanyProfileInput,
  ReadEnrichmentCacheInput,
  RegistryCandidateQuery,
  RegistryIndexRepository,
  RegistryRecord,
  SaveMatchEventInput,
  SaveProfileQuestionEventInput,
  SaveCompanyProfileInput,
  ServiceRepositories,
  SubmitFeedbackInput,
  VerifyCompanyInput,
  CompanyVerificationRecord,
  WriteEnrichmentCacheInput,
} from "@cunote/core";
import { filterActiveGrants } from "./activeGrantFilter";

export const DEFAULT_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000101";
export const DEMO_COMPANY_ID = DEFAULT_DEMO_COMPANY_ID;

export function demoCompanyId(): string {
  return process.env.CUNOTE_DEMO_COMPANY_ID ?? DEFAULT_DEMO_COMPANY_ID;
}

export interface RuntimeRepositoryLoaders<TPayload = unknown> {
  loadGrants(options?: GrantListOptions): Promise<Array<NormalizedGrant<TPayload>>>;
  loadCompanyProfile(bizNo?: string): Promise<CompanyProfile>;
}

export function createRuntimeRepositories<TPayload = unknown>(
  loaders: RuntimeRepositoryLoaders<TPayload>,
): ServiceRepositories<TPayload> {
  return {
    grants: new RuntimeGrantRepository(loaders),
    companies: new RuntimeCompanyRepository(loaders),
    matches: new RuntimeMatchRepository(),
    feedback: new RuntimeFeedbackRepository(),
    enrichmentCache: new RuntimeEnrichmentCacheRepository(),
    registryIndex: new RuntimeRegistryIndexRepository(),
    credits: new RuntimeCreditRepository(),
    creditsSystem: new RuntimeCreditSystemRepository(),
    creditsPayment: new RuntimePaymentRepository(),
    creditsSubscription: new RuntimeSubscriptionRepository(),
  };
}

class RuntimeGrantRepository<TPayload> implements GrantRepository<TPayload> {
  constructor(private readonly loaders: RuntimeRepositoryLoaders<TPayload>) {}

  async listActiveGrants(options: GrantListOptions = {}) {
    const grants = await this.loaders.loadGrants(options);
    return filterActiveGrants(grants, options);
  }

  async findGrantById(grantId: string, options: GrantListOptions = {}) {
    const grants = await this.loaders.loadGrants(options);
    return grants.find((entry) => grantKey(entry.grant) === grantId || entry.grant.source_id === grantId) ?? null;
  }

  /** id 목록 조회 — 활성 필터 없이 로더 결과에서 id/grantKey 일치분만 반환한다(read-only). */
  async listGrantsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    const grants = await this.loaders.loadGrants();
    return grants.filter((entry) =>
      (entry.grant.id !== undefined && wanted.has(entry.grant.id)) || wanted.has(grantKey(entry.grant)));
  }
}

class RuntimeCompanyRepository implements CompanyRepository {
  private readonly savedProfiles = new Map<string, CompanyProfile>();
  private readonly verifications = new Map<string, CompanyVerificationRecord>();

  constructor(private readonly loaders: RuntimeRepositoryLoaders) {}

  async getDefaultCompanyProfile() {
    return this.resolveSavedOrLoadedProfile(demoCompanyId());
  }

  async resolveCompanyProfile(input: ResolveCompanyProfileInput = {}) {
    if (input.companyId && input.companyId !== demoCompanyId()) return null;
    if (input.companyId) {
      return this.resolveSavedOrLoadedProfile(input.companyId, input.bizNo, input.userId);
    }
    return this.loaders.loadCompanyProfile(input.bizNo);
  }

  async saveCompanyProfile(input: SaveCompanyProfileInput) {
    this.setSavedProfile(input.companyId, input.profile, input.userId);
    return cloneProfile(input.profile);
  }

  async createCompany(input: CreateCompanyInput): Promise<CompanyRecord> {
    this.setSavedProfile(demoCompanyId(), input.profile, input.userId);
    const profile = cloneProfile(input.profile);
    return {
      id: demoCompanyId(),
      name: profile.name ?? "샘플 기업",
      profile,
      role: "owner",
      verified: false,
      verifiedAt: null,
      verifyMethod: null,
      bizNoMasked: null,
    };
  }

  async listUserCompanies(_userId: string): Promise<CompanyRecord[]> {
    const profile = await this.resolveSavedOrLoadedProfile(demoCompanyId(), undefined, _userId);
    const verification = this.getVerification(demoCompanyId(), _userId);
    return [{
      id: demoCompanyId(),
      name: profile.name ?? "샘플 기업",
      profile,
      role: "owner",
      verified: verification?.verified ?? false,
      verifiedAt: verification?.verifiedAt ?? null,
      verifyMethod: verification?.verifyMethod ?? null,
      bizNoMasked: verification ? maskBizNo(verification.bizNo) : null,
    }];
  }

  async getCompanyBizNo(input: { companyId: string; userId?: string }): Promise<string | null> {
    return this.getVerification(input.companyId, input.userId)?.bizNo ?? null;
  }

  async verifyCompany(input: VerifyCompanyInput): Promise<CompanyVerificationRecord> {
    if (input.companyId !== demoCompanyId()) {
      throw new Error("회사를 찾지 못했습니다.");
    }
    const verification: CompanyVerificationRecord = {
      companyId: input.companyId,
      bizNo: input.bizNo,
      verified: true,
      verifiedAt: new Date().toISOString(),
      verifyMethod: input.verifyMethod ?? "dev_self_declared",
    };
    this.verifications.set(profileKey(input.companyId, input.userId), verification);
    this.verifications.set(profileKey(input.companyId), verification);
    return verification;
  }

  private async resolveSavedOrLoadedProfile(
    companyId: string,
    bizNo?: string,
    userId?: string,
  ): Promise<CompanyProfile> {
    const shared = this.savedProfiles.get(profileKey(companyId)) ?? await this.loaders.loadCompanyProfile(bizNo);
    const personal = userId ? this.savedProfiles.get(profileKey(companyId, userId)) : undefined;
    return cloneProfile(personal ? mergeRuntimeProfiles(shared, personal) : shared);
  }

  private setSavedProfile(companyId: string, profile: CompanyProfile, userId?: string) {
    const cloned = cloneProfile(profile);
    this.savedProfiles.set(userId ? profileKey(companyId, userId) : profileKey(companyId), cloned);
  }

  private getVerification(companyId: string, userId?: string): CompanyVerificationRecord | null {
    return userId
      ? this.verifications.get(profileKey(companyId, userId)) ?? this.verifications.get(profileKey(companyId)) ?? null
      : this.verifications.get(profileKey(companyId)) ?? null;
  }
}

class RuntimeMatchRepository<TPayload> implements MatchRepository<TPayload> {
  async calculateGrantMatch(input: {
    company: CompanyProfile;
    grant: NormalizedGrant<TPayload>;
  }): Promise<MatchResult> {
    return matchNormalizedGrant(input.grant, input.company);
  }

  async calculateGrantMatches(input: {
    company: CompanyProfile;
    grants: Array<NormalizedGrant<TPayload>>;
  }) {
    return input.grants.map((grant) => ({
      grant,
      match: matchNormalizedGrant(grant, input.company),
    }));
  }

  async saveMatchState() {
    // The runtime adapter is stateless until DB-backed match_state is connected.
  }

  async listDueMatchTransitions() {
    return [];
  }

  async saveMatchEvent(_input: SaveMatchEventInput): Promise<MatchEventReceipt> {
    return {
      id: `match-event:${crypto.randomUUID()}`,
      acceptedAt: new Date().toISOString(),
    };
  }

  async saveProfileQuestionEvent(input: SaveProfileQuestionEventInput): Promise<ProfileQuestionEventReceipt> {
    return {
      id: `profile-question-event:${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      recordedAt: new Date().toISOString(),
      persisted: false,
    };
  }
}

class RuntimeFeedbackRepository implements FeedbackRepository {
  async submitFeedback(_input: SubmitFeedbackInput): Promise<FeedbackReceipt> {
    return {
      id: `feedback:${crypto.randomUUID()}`,
      receivedAt: new Date().toISOString(),
    };
  }
}

class RuntimeEnrichmentCacheRepository implements EnrichmentCacheRepository {
  private readonly entries = new Map<string, EnrichmentCacheEntry>();

  async getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null> {
    const entry = this.entries.get(enrichmentCacheKey(input));
    if (!entry) return null;
    const now = input.now ?? new Date();
    if (entry.expiresAt && entry.expiresAt.getTime() <= now.getTime()) return null;
    return cloneCacheEntry(entry);
  }

  async put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry> {
    const entry: EnrichmentCacheEntry = {
      provider: input.provider,
      bizNo: input.bizNo,
      scope: input.scope,
      fetchedAt: input.fetchedAt ?? new Date(),
    };
    if (input.rawPayload !== undefined) entry.rawPayload = cloneRecord(input.rawPayload);
    if (input.canonicalPayload !== undefined) entry.canonicalPayload = cloneRecord(input.canonicalPayload);
    if (input.providerResultCode !== undefined) entry.providerResultCode = input.providerResultCode;
    if (input.providerResultMessage !== undefined) entry.providerResultMessage = input.providerResultMessage;
    if (input.checkedAt !== undefined) entry.checkedAt = input.checkedAt;
    if (input.expiresAt !== undefined) entry.expiresAt = input.expiresAt;
    if (input.payloadHash !== undefined) entry.payloadHash = input.payloadHash;
    if (input.lastError !== undefined) entry.lastError = cloneRecord(input.lastError);
    this.entries.set(enrichmentCacheKey(input), entry);
    return cloneCacheEntry(entry);
  }

  async claim(input: ClaimEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null> {
    const key = enrichmentCacheKey(input);
    const existing = this.entries.get(key);
    if (existing && (!existing.expiresAt || existing.expiresAt.getTime() > input.now.getTime())) {
      return null;
    }
    return this.put(input);
  }

  async listByBizNo(bizNo: string): Promise<EnrichmentCacheEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.bizNo === bizNo)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.scope.localeCompare(b.scope))
      .map(cloneCacheEntry);
  }

  async deleteByBizNo(input: DeleteEnrichmentCacheInput): Promise<number> {
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.bizNo !== input.bizNo) continue;
      if (input.provider && entry.provider !== input.provider) continue;
      if (input.scope && entry.scope !== input.scope) continue;
      this.entries.delete(key);
      deleted += 1;
    }
    return deleted;
  }
}

class RuntimeRegistryIndexRepository implements RegistryIndexRepository {
  private rows: RegistryRecord[] = [];

  async findCandidates(input: RegistryCandidateQuery): Promise<RegistryRecord[]> {
    const bizNo = input.bizNo ?? null;
    const corpNo = input.corpNo ?? null;
    const name = input.nameNormalized ?? null;
    if (!bizNo && !corpNo && !name) return [];
    return this.rows
      .filter((row) => {
        if (input.registryType && row.registryType !== input.registryType) return false;
        return (
          (bizNo !== null && row.bizNo === bizNo) ||
          (corpNo !== null && row.corpNo === corpNo) ||
          (name !== null && name !== "" && row.nameNormalized === name)
        );
      })
      .map(cloneRegistryRecord);
  }

  async hasSource(source: string): Promise<boolean> {
    return this.rows.some((row) => row.source === source);
  }

  async replaceBySource(source: string, records: RegistryRecord[]): Promise<number> {
    this.rows = this.rows.filter((row) => row.source !== source);
    this.rows.push(...records.map(cloneRegistryRecord));
    return records.length;
  }
}

function cloneRegistryRecord(record: RegistryRecord): RegistryRecord {
  return {
    ...record,
    validFrom: record.validFrom ? new Date(record.validFrom) : null,
    validUntil: record.validUntil ? new Date(record.validUntil) : null,
    sourceFetchedAt: new Date(record.sourceFetchedAt),
    detail: record.detail ? cloneRecord(record.detail) : null,
  };
}

function profileKey(companyId: string, userId?: string): string {
  return userId ? `${userId}:${companyId}` : `company:${companyId}`;
}

function mergeRuntimeProfiles(shared: CompanyProfile, personal: CompanyProfile): CompanyProfile {
  return {
    ...shared,
    ...personal,
    confidence: {
      ...(shared.confidence ?? {}),
      ...(personal.confidence ?? {}),
    },
  };
}

function cloneProfile(profile: CompanyProfile): CompanyProfile {
  return JSON.parse(JSON.stringify(profile)) as CompanyProfile;
}

function maskBizNo(value: string): string {
  try {
    return maskCorpNum(value);
  } catch {
    return "**********";
  }
}

function enrichmentCacheKey(input: Pick<EnrichmentCacheEntry, "provider" | "bizNo" | "scope">): string {
  return `${input.provider}:${input.bizNo}:${input.scope}`;
}

function cloneRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown> | null;
}

function cloneCacheEntry(entry: EnrichmentCacheEntry): EnrichmentCacheEntry {
  const cloned: EnrichmentCacheEntry = {
    provider: entry.provider,
    bizNo: entry.bizNo,
    scope: entry.scope,
    fetchedAt: new Date(entry.fetchedAt),
  };
  if (entry.rawPayload !== undefined) cloned.rawPayload = cloneRecord(entry.rawPayload);
  if (entry.canonicalPayload !== undefined) cloned.canonicalPayload = cloneRecord(entry.canonicalPayload);
  if (entry.providerResultCode !== undefined) cloned.providerResultCode = entry.providerResultCode;
  if (entry.providerResultMessage !== undefined) cloned.providerResultMessage = entry.providerResultMessage;
  if (entry.checkedAt !== undefined) cloned.checkedAt = entry.checkedAt ? new Date(entry.checkedAt) : null;
  if (entry.expiresAt !== undefined) cloned.expiresAt = entry.expiresAt ? new Date(entry.expiresAt) : null;
  if (entry.payloadHash !== undefined) cloned.payloadHash = entry.payloadHash;
  if (entry.lastError !== undefined) cloned.lastError = cloneRecord(entry.lastError);
  return cloned;
}

// ─────────────────────────────────────────────────────────────────────────────
// 크레딧 (in-memory mock). 설계 5.2/6.6. core 순수 함수로 원장 규칙을 그대로 재현한다.
// 데모/테스트용 — 프로세스 재시작 시 초기화. 코드 레벨 가드(4.13)는 여기서도 강제한다.
// ─────────────────────────────────────────────────────────────────────────────

interface MockWallet {
  id: string;
  userId: string;
  balanceCredits: number;
  status: "active" | "frozen";
  frozenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface MockLot {
  id: string;
  walletId: string;
  source: CreditLotRecord["source"];
  initialCredits: number;
  remainingCredits: number;
  expiresAt: Date | null;
  status: CreditLotRecord["status"];
  createdAt: Date;
}
interface MockLedger extends CreditLedgerEntryRecord {}
interface MockHold {
  id: string;
  walletId: string;
  usageEventId: string;
  heldCredits: number;
  capturedCredits: number | null;
  status: CreditHoldRecord["status"];
  expiresAt: Date;
  releasedReason: string | null;
  createdAt: Date;
}
interface MockUsageEvent {
  id: string;
  walletId: string;
  companyId: string | null;
  featureCode: string;
  status: "pending" | "settled" | "failed" | "free";
  creditsCharged: number;
  shortfall: number;
}

const GRANT_ENTRY_TYPES = new Set([
  "signup_bonus_grant", "purchase_grant", "plan_grant", "admin_grant", "promo_grant",
]);
const FROZEN_ALLOWED = new Set(["usage_capture", "refund_deduct", "admin_grant", "admin_deduct", "reversal"]);

class RuntimeCreditRepository implements CreditRepository {
  private readonly wallets = new Map<string, MockWallet>(); // userId → wallet
  private readonly lots = new Map<string, MockLot>();
  private readonly ledger: MockLedger[] = [];
  private readonly ledgerByKey = new Map<string, MockLedger>();
  private readonly holds = new Map<string, MockHold>();
  private readonly usageEventsFull = new Map<string, MockUsageEvent>();

  async ensureWalletWithSignupBonus(userId: string): Promise<CreditWalletRecord> {
    requireUserId(userId, "ensureWalletWithSignupBonus");
    const now = new Date();
    let wallet = this.wallets.get(userId);
    if (!wallet) {
      wallet = {
        id: crypto.randomUUID(), userId, balanceCredits: 0,
        status: "active", frozenReason: null, createdAt: now, updatedAt: now,
      };
      this.wallets.set(userId, wallet);
    }
    this.apply({
      walletId: wallet.id,
      entryType: "signup_bonus_grant",
      amountCredits: 1000,
      idempotencyKey: idempotencyKeys.signup(userId),
      actorType: "system",
      actorId: "system:signup-bonus",
      reason: "가입 보너스 지급",
      grantLot: { source: "signup_bonus", expiresAt: new Date(now.getTime() + 90 * 86400000) },
    });
    return this.toWalletRecord(this.wallets.get(userId)!);
  }

  async getWalletForUser(userId: string): Promise<CreditWalletRecord | null> {
    requireUserId(userId, "getWalletForUser");
    const w = this.wallets.get(userId);
    return w ? this.toWalletRecord(w) : null;
  }

  async listActiveLotsForUser(userId: string): Promise<CreditLotRecord[]> {
    requireUserId(userId, "listActiveLotsForUser");
    const w = this.wallets.get(userId);
    if (!w) return [];
    const active = [...this.lots.values()].filter((l) => l.walletId === w.id && l.status === "active");
    return sortLotsForConsumption(active).map((l) => ({ ...l }));
  }

  async applyLedgerEntry(userId: string, input: ApplyLedgerEntryInput): Promise<CreditLedgerEntryRecord> {
    requireUserId(userId, "applyLedgerEntry");
    const w = this.wallets.get(userId);
    if (!w || w.id !== input.walletId) {
      throw new InvalidLedgerEntryError("본인 지갑이 아니거나 지갑이 없습니다.", { walletId: input.walletId });
    }
    return this.apply(input);
  }

  // ── hold/capture (in-memory mock, 5.3 근사) ──────────────────────────

  async acquireHold(
    userId: string,
    input: { walletId: string; usageEventId: string; estimatedCredits: number; excludeBonusLots?: boolean },
  ): Promise<CreditHoldRecord> {
    requireUserId(userId, "acquireHold");
    const wallet = [...this.wallets.values()].find((x) => x.id === input.walletId);
    if (!wallet) throw new InvalidLedgerEntryError("지갑을 찾을 수 없습니다.");
    if (wallet.status === "frozen") throw new WalletFrozenError(input.walletId, wallet.frozenReason);
    const now = new Date();
    const pending = [...this.holds.values()]
      .filter((h) => h.walletId === input.walletId && h.status === "pending")
      .reduce((s, h) => s + h.heldCredits, 0);
    let basis = wallet.balanceCredits;
    if (input.excludeBonusLots) {
      const bonus = [...this.lots.values()]
        .filter((l) => l.walletId === input.walletId && l.status === "active" && l.source === "signup_bonus")
        .reduce((s, l) => s + l.remainingCredits, 0);
      basis -= bonus;
    }
    const available = basis - pending;
    const held = Math.ceil(input.estimatedCredits * 1.2);
    if (available < held) throw new InsufficientCreditsError({ required: held, available: Math.max(0, available) });
    const hold: MockHold = {
      id: crypto.randomUUID(), walletId: input.walletId, usageEventId: input.usageEventId,
      heldCredits: held, capturedCredits: null, status: "pending",
      expiresAt: new Date(now.getTime() + 600_000),
      releasedReason: input.excludeBonusLots ? "exclude_bonus" : null, createdAt: now,
    };
    this.holds.set(hold.id, hold);
    return { ...hold };
  }

  async captureHold(
    userId: string,
    input: { holdId: string; actualCredits: number; pricingSnapshot?: Record<string, unknown> | null; excludeBonusLots?: boolean },
  ): Promise<CaptureHoldResult> {
    requireUserId(userId, "captureHold");
    const hold = this.holds.get(input.holdId);
    if (!hold) throw new InvalidLedgerEntryError("hold 를 찾을 수 없습니다.");
    if (hold.status === "captured") {
      return { hold: { ...hold }, creditsCharged: hold.capturedCredits ?? 0, shortfall: 0, capturedLate: false };
    }
    const need = Math.max(0, input.actualCredits);
    const ttlExpired = hold.expiresAt.getTime() < Date.now();
    const excludeBonus = input.excludeBonusLots || hold.releasedReason === "exclude_bonus";
    // usage 키 멱등.
    const key = idempotencyKeys.usage(hold.usageEventId);
    let creditsCharged: number; let shortfall = 0;
    const existing = this.ledgerByKey.get(key);
    if (existing) {
      creditsCharged = -existing.amountCredits;
    } else {
      const active = [...this.lots.values()].filter(
        (l) => l.walletId === hold.walletId && l.status === "active" && l.remainingCredits > 0
          && (l.expiresAt === null || l.expiresAt.getTime() > hold.createdAt.getTime())
          && (!excludeBonus || l.source !== "signup_bonus"),
      );
      const { lines, shortfall: sf } = allocateFromLots(sortLotsForConsumption(active), need);
      shortfall = sf;
      const effectiveNeed = need - sf;
      creditsCharged = effectiveNeed;
      for (const line of lines) {
        const lot = this.lots.get(line.lotId)!;
        lot.remainingCredits -= line.amount;
        if (lot.remainingCredits <= 0) lot.status = "exhausted";
      }
      if (effectiveNeed > 0) {
        this.applyCaptureEntry(hold.walletId, -effectiveNeed, lines, hold.usageEventId, key, input.pricingSnapshot ?? null, userId);
      }
    }
    hold.status = "captured";
    hold.capturedCredits = creditsCharged;
    if (ttlExpired) hold.releasedReason = "captured_late";
    const ue = this.usageEventsFull.get(hold.usageEventId);
    if (ue) { ue.status = "settled"; ue.creditsCharged = creditsCharged; if (shortfall > 0) ue.shortfall = shortfall; }
    return { hold: { ...hold }, creditsCharged, shortfall, capturedLate: ttlExpired };
  }

  async releaseHold(userId: string, input: { holdId: string; reason: string }): Promise<CreditHoldRecord> {
    requireUserId(userId, "releaseHold");
    const hold = this.holds.get(input.holdId);
    if (!hold) throw new InvalidLedgerEntryError("hold 를 찾을 수 없습니다.");
    if (hold.status === "captured") return { ...hold };
    hold.status = "released";
    hold.releasedReason = input.reason;
    return { ...hold };
  }

  async createPendingUsageEvent(
    userId: string,
    input: { walletId: string; companyId: string | null; featureCode: string; provider: string; model: string | null; pricingRuleId: string | null; requestId: string; contextRef?: Record<string, unknown> },
  ): Promise<{ id: string }> {
    requireUserId(userId, "createPendingUsageEvent");
    const id = crypto.randomUUID();
    this.usageEventsFull.set(id, {
      id, walletId: input.walletId, companyId: input.companyId, featureCode: input.featureCode,
      status: "pending", creditsCharged: 0, shortfall: 0,
    });
    return { id };
  }

  async recordUsageTokens(): Promise<void> { /* in-memory: 토큰 기록 생략 */ }

  async markUsageEventFailed(userId: string, input: { usageEventId: string; errorCode: string }): Promise<void> {
    requireUserId(userId, "markUsageEventFailed");
    const ue = this.usageEventsFull.get(input.usageEventId);
    if (ue) ue.status = "failed";
  }

  async sumCompanyBonusConsumption(userId: string, companyId: string): Promise<number> {
    requireUserId(userId, "sumCompanyBonusConsumption");
    // in-memory 근사: usage_capture 분개의 lotBreakdown 중 signup_bonus lot 참조분을 companyId 로 좁혀 합산.
    let sum = 0;
    for (const entry of this.ledger) {
      if (entry.entryType !== "usage_capture") continue;
      const ueId = (entry as { usageEventId?: string }).usageEventId;
      const ue = ueId ? this.usageEventsFull.get(ueId) : undefined;
      if (ue && ue.companyId !== companyId) continue;
      for (const line of entry.lotBreakdown) {
        const lot = this.lots.get(line.lotId);
        if (lot?.source === "signup_bonus") sum += line.amount;
      }
    }
    return sum;
  }

  async sumPendingHolds(userId: string, walletId: string): Promise<number> {
    requireUserId(userId, "sumPendingHolds");
    return [...this.holds.values()]
      .filter((h) => h.walletId === walletId && h.status === "pending")
      .reduce((s, h) => s + h.heldCredits, 0);
  }

  async listLedgerForUser(
    userId: string,
    input: { walletId: string; limit: number; cursor?: string | null; entryType?: string | null },
  ): Promise<{ entries: LedgerListRow[]; nextCursor: string | null; hasMore: boolean }> {
    requireUserId(userId, "listLedgerForUser");
    const all = this.ledger
      .filter((e) => e.walletId === input.walletId && (!input.entryType || e.entryType === input.entryType))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const page = all.slice(0, limit);
    return {
      entries: page.map((e) => ({
        id: e.id, entryType: e.entryType, amountCredits: e.amountCredits,
        balanceAfter: e.balanceAfter, reason: e.reason, createdAt: e.createdAt,
      })),
      nextCursor: null,
      hasMore: all.length > limit,
    };
  }

  async listUsageForUser(
    userId: string,
    _input: { walletId: string; from?: Date | null; to?: Date | null; featureCode?: string | null; limit: number; cursor?: string | null },
  ): Promise<{
    events: UsageListRow[];
    summary: { totalCredits: number; byFeature: Array<{ featureCode: string; credits: number; count: number }> };
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    requireUserId(userId, "listUsageForUser");
    return { events: [], summary: { totalCredits: 0, byFeature: [] }, nextCursor: null, hasMore: false };
  }

  private applyCaptureEntry(
    walletId: string, amount: number, lotBreakdown: LotBreakdownLine[], usageEventId: string,
    key: string, pricingSnapshot: Record<string, unknown> | null, userId: string,
  ): void {
    const wallet = [...this.wallets.values()].find((x) => x.id === walletId)!;
    const balanceAfter = wallet.balanceCredits + amount;
    const now = new Date();
    const prev = [...this.ledger].reverse().find((e) => e.walletId === walletId);
    const prevChainHash = prev?.chainHash ?? genesisHash(walletId);
    const id = crypto.randomUUID();
    const chainHash = computeChainHash({
      prevChainHash, id, walletId, entryType: "usage_capture", amountCredits: amount, balanceAfter,
      idempotencyKey: key, createdAt: now,
    });
    const entry: MockLedger = {
      id, walletId, entryType: "usage_capture", amountCredits: amount, balanceAfter, lotBreakdown,
      idempotencyKey: key, chainHash, actorType: "user", actorId: userId, reason: null, createdAt: now,
    };
    (entry as { usageEventId?: string }).usageEventId = usageEventId;
    void pricingSnapshot;
    this.ledger.push(entry);
    this.ledgerByKey.set(key, entry);
    wallet.balanceCredits = balanceAfter;
    wallet.updatedAt = now;
  }

  private apply(input: ApplyLedgerEntryInput): CreditLedgerEntryRecord {
    if (input.amountCredits === 0) throw new InvalidLedgerEntryError("분개 금액은 0일 수 없습니다.");
    const wallet = [...this.wallets.values()].find((x) => x.id === input.walletId);
    if (!wallet) throw new InvalidLedgerEntryError("지갑을 찾을 수 없습니다.", { walletId: input.walletId });
    if (wallet.status === "frozen" && !FROZEN_ALLOWED.has(input.entryType)) {
      throw new WalletFrozenError(input.walletId, wallet.frozenReason);
    }
    const existing = this.ledgerByKey.get(input.idempotencyKey);
    if (existing) return { ...existing };

    const isGrant = input.amountCredits > 0;
    if (isGrant !== GRANT_ENTRY_TYPES.has(input.entryType)) {
      throw new InvalidLedgerEntryError("분개 유형과 금액 부호가 일치하지 않습니다.");
    }
    const now = new Date();
    let lotBreakdown: LotBreakdownLine[];
    let effectiveAmount = input.amountCredits;

    if (isGrant) {
      if (!input.grantLot) throw new InvalidLedgerEntryError("지급 분개에는 grantLot 이 필요합니다.");
      const lot: MockLot = {
        id: crypto.randomUUID(), walletId: input.walletId, source: input.grantLot.source,
        initialCredits: input.amountCredits, remainingCredits: input.amountCredits,
        expiresAt: input.grantLot.expiresAt, status: "active", createdAt: now,
      };
      this.lots.set(lot.id, lot);
      lotBreakdown = grantLotBreakdown(lot.id, input.amountCredits);
    } else {
      const need = -input.amountCredits;
      const selection = input.lotSelection ?? "consume_order";
      let lines: LotBreakdownLine[]; let shortfall: number;
      if (selection === "consume_order") {
        const active = [...this.lots.values()].filter(
          (l) => l.walletId === input.walletId && l.status === "active" && l.remainingCredits > 0
            && (l.expiresAt === null || l.expiresAt.getTime() > now.getTime()),
        );
        ({ lines, shortfall } = allocateFromLots(sortLotsForConsumption(active), need));
        if (shortfall > 0) {
          if (input.entryType === "usage_capture") effectiveAmount = -(need - shortfall);
          else throw new InsufficientCreditsError({ required: need, available: need - shortfall });
        }
      } else {
        const ordered = selection.targetLotIds
          .map((id) => this.lots.get(id)).filter((l): l is MockLot => Boolean(l));
        ({ lines, shortfall } = allocateFromTargetLots(ordered, need));
        if (shortfall > 0) effectiveAmount = -(need - shortfall);
      }
      for (const line of lines) {
        const lot = this.lots.get(line.lotId)!;
        lot.remainingCredits -= line.amount;
        if (lot.remainingCredits <= 0) lot.status = "exhausted";
      }
      lotBreakdown = lines;
    }

    const balanceAfter = wallet.balanceCredits + effectiveAmount;
    if (balanceAfter < 0) throw new InvalidLedgerEntryError("잔액이 음수가 될 수 없습니다.");
    const prev = [...this.ledger].reverse().find((e) => e.walletId === input.walletId);
    const prevChainHash = prev?.chainHash ?? genesisHash(input.walletId);
    const id = crypto.randomUUID();
    const chainHash = computeChainHash({
      prevChainHash, id, walletId: input.walletId, entryType: input.entryType,
      amountCredits: effectiveAmount, balanceAfter, idempotencyKey: input.idempotencyKey, createdAt: now,
    });
    const entry: MockLedger = {
      id, walletId: input.walletId, entryType: input.entryType, amountCredits: effectiveAmount,
      balanceAfter, lotBreakdown, idempotencyKey: input.idempotencyKey, chainHash,
      actorType: input.actorType, actorId: input.actorId ?? null, reason: input.reason ?? null, createdAt: now,
    };
    this.ledger.push(entry);
    this.ledgerByKey.set(input.idempotencyKey, entry);
    wallet.balanceCredits = balanceAfter;
    wallet.updatedAt = now;
    return { ...entry };
  }

  private toWalletRecord(w: MockWallet): CreditWalletRecord {
    return { ...w };
  }
}

class RuntimeCreditSystemRepository implements CreditSystemRepository {
  private readonly usageEvents: Array<{ id: string }> = [];
  private readonly pricingRules: PricingRule[] = [];

  async recordFreeUsageEvent(): Promise<{ id: string }> {
    const ev = { id: crypto.randomUUID() };
    this.usageEvents.push(ev);
    return ev;
  }

  async listEffectivePricingRules(at: Date): Promise<PricingRule[]> {
    return this.pricingRules.filter(
      (r) => r.effectiveFrom.getTime() <= at.getTime()
        && (!r.effectiveUntil || r.effectiveUntil.getTime() > at.getTime()),
    );
  }

  async readNumericSetting(_key: string, fallback: number): Promise<number> {
    return fallback;
  }

  async readJsonSetting(_key: string): Promise<Record<string, unknown> | null> {
    return null;
  }

  async recordOpsUsageEvent(_input: {
    featureCode: string;
    provider: string;
    model: string | null;
    usage: TokenUsage | null;
    providerCostUsdMicros?: number | null;
    requestId?: string | null;
    contextRef?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const ev = { id: crypto.randomUUID() };
    this.usageEvents.push(ev);
    return ev;
  }
}

/**
 * 결제(P3)는 실제 DB(drizzle 어댑터)에서만 동작한다. 런타임(데모/인메모리) 어댑터는
 * 조회는 빈 결과, 지급·환불·웹훅 경로는 명시적으로 미지원 오류(503 payment_unavailable)를 던진다.
 */
class RuntimePaymentRepository implements CreditPaymentRepository {
  async listActiveProducts(): Promise<CreditProductRecord[]> {
    return [];
  }
  async getActiveProductByCode(): Promise<CreditProductRecord | null> {
    return null;
  }
  async createOrder(): Promise<CreditOrderRecord> {
    throw new RuntimePaymentUnsupportedError("createOrder");
  }
  async getOrderByPaymentId(): Promise<CreditOrderRecord | null> {
    return null;
  }
  async listOrdersForWallet(): Promise<{ orders: CreditOrderRecord[]; nextCursor: string | null; hasMore: boolean }> {
    return { orders: [], nextCursor: null, hasMore: false };
  }
  async countOpenOrdersForUser(): Promise<number> {
    return 0;
  }
  async countRecentOrdersForUser(): Promise<number> {
    return 0;
  }
  async grantPurchaseForOrder(): Promise<{ grantedCredits: number; balance: number }> {
    throw new RuntimePaymentUnsupportedError("grantPurchaseForOrder");
  }
  async markOrderMismatch(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("markOrderMismatch");
  }
  async markOrderFailed(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("markOrderFailed");
  }
  async markOrderExpired(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("markOrderExpired");
  }
  async listDueOrders(): Promise<CreditOrderRecord[]> {
    return [];
  }
  async getOrderById(): Promise<CreditOrderRecord | null> {
    return null;
  }
  async getProductById(): Promise<CreditProductRecord | null> {
    return null;
  }
  async getOrderLots(): Promise<OrderLotSnapshot[]> {
    return [];
  }
  async syncRefundForOrder(): Promise<{ recovered: number; shortfall: number; frozen: boolean }> {
    throw new RuntimePaymentUnsupportedError("syncRefundForOrder");
  }
  async executeRefundForOrder(): Promise<{ recovered: number; shortfall: number; frozen: boolean; entryId: string | null }> {
    throw new RuntimePaymentUnsupportedError("executeRefundForOrder");
  }
  async recordRefundFailedAudit(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("recordRefundFailedAudit");
  }
  async insertWebhookEvent(): Promise<{ id: string; duplicate: boolean }> {
    throw new RuntimePaymentUnsupportedError("insertWebhookEvent");
  }
  async updateWebhookEvent(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("updateWebhookEvent");
  }
}

class RuntimePaymentUnsupportedError extends Error {
  readonly status = 503;
  readonly code = "payment_unavailable";
  constructor(operation: string) {
    super(`결제 기능은 실 DB 어댑터에서만 동작합니다(runtime.${operation}).`);
    this.name = "RuntimePaymentUnsupportedError";
  }
}

/** 플랜 구독은 실 DB 어댑터에서만 동작한다(P4). runtime 은 no-throwing 스텁. */
class RuntimeSubscriptionRepository implements CreditSubscriptionRepository {
  async listActivePlans(): Promise<CreditPlanRecord[]> {
    return [];
  }
  async getPlanByCode(): Promise<CreditPlanRecord | null> {
    return null;
  }
  async getPlanById(): Promise<CreditPlanRecord | null> {
    return null;
  }
  async getSubscriptionForUser(): Promise<CreditSubscriptionRecord | null> {
    return null;
  }
  async getActiveOrPastDueForUser(): Promise<CreditSubscriptionRecord | null> {
    return null;
  }
  async getSubscriptionById(): Promise<CreditSubscriptionRecord | null> {
    return null;
  }
  async getSubscriptionByNextSchedulePaymentId(): Promise<CreditSubscriptionRecord | null> {
    return null;
  }
  async getSubscriptionByCurrentBillingKey(): Promise<CreditSubscriptionRecord | null> {
    return null;
  }
  async upsertIncompleteSubscription(): Promise<CreditSubscriptionRecord> {
    throw new RuntimePaymentUnsupportedError("upsertIncompleteSubscription");
  }
  async activateSubscriptionWithGrant(): Promise<ActivateSubscriptionResult> {
    throw new RuntimePaymentUnsupportedError("activateSubscriptionWithGrant");
  }
  async renewSubscriptionWithGrant(): Promise<RenewSubscriptionResult> {
    throw new RuntimePaymentUnsupportedError("renewSubscriptionWithGrant");
  }
  async upgradeSubscriptionWithGrant(): Promise<UpgradeSubscriptionResult> {
    throw new RuntimePaymentUnsupportedError("upgradeSubscriptionWithGrant");
  }
  async markSubscriptionPastDue(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("markSubscriptionPastDue");
  }
  async markSubscriptionExpired(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("markSubscriptionExpired");
  }
  async forceCancelSubscription(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("forceCancelSubscription");
  }
  async setCancelAtPeriodEnd(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("setCancelAtPeriodEnd");
  }
  async setPendingPlan(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("setPendingPlan");
  }
  async updateBillingKey(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("updateBillingKey");
  }
  async recordBillingKeyDeleted(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("recordBillingKeyDeleted");
  }
  async updateSchedule(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("updateSchedule");
  }
  async createPlanOrder(): Promise<CreditOrderRecord> {
    throw new RuntimePaymentUnsupportedError("createPlanOrder");
  }
  async expireCreatedOrdersForSubscription(): Promise<void> {
    throw new RuntimePaymentUnsupportedError("expireCreatedOrdersForSubscription");
  }
  async listRenewalDueSubscriptions(): Promise<CreditSubscriptionRecord[]> {
    return [];
  }
  async listFailedWebhookEvents(): Promise<FailedWebhookEvent[]> {
    return [];
  }
}

function requireUserId(userId: unknown, operation: string): asserts userId is string {
  if (!userId || typeof userId !== "string") throw new CreditContextRequiredError(operation);
}
