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
  matchGrantCriteria,
  sortLotsForConsumption,
} from "@cunote/core";
import type {
  CompanyProfile,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import type {
  ApplyLedgerEntryInput,
  CompanyRecord,
  CompanyRepository,
  CreateCompanyInput,
  CreditLedgerEntryRecord,
  CreditLotRecord,
  CreditRepository,
  CreditSystemRepository,
  CreditWalletRecord,
  EnrichmentCacheEntry,
  EnrichmentCacheRepository,
  FeedbackReceipt,
  FeedbackRepository,
  GrantListOptions,
  GrantRepository,
  LotBreakdownLine,
  MatchEventReceipt,
  MatchRepository,
  PricingRule,
  ResolveCompanyProfileInput,
  ReadEnrichmentCacheInput,
  SaveMatchEventInput,
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
    credits: new RuntimeCreditRepository(),
    creditsSystem: new RuntimeCreditSystemRepository(),
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
    return matchGrantCriteria(input.grant.criteria, input.company);
  }

  async calculateGrantMatches(input: {
    company: CompanyProfile;
    grants: Array<NormalizedGrant<TPayload>>;
  }) {
    return input.grants.map((grant) => ({
      grant,
      match: matchGrantCriteria(grant.criteria, input.company),
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

const GRANT_ENTRY_TYPES = new Set([
  "signup_bonus_grant", "purchase_grant", "plan_grant", "admin_grant", "promo_grant",
]);
const FROZEN_ALLOWED = new Set(["usage_capture", "refund_deduct", "admin_grant", "admin_deduct", "reversal"]);

class RuntimeCreditRepository implements CreditRepository {
  private readonly wallets = new Map<string, MockWallet>(); // userId → wallet
  private readonly lots = new Map<string, MockLot>();
  private readonly ledger: MockLedger[] = [];
  private readonly ledgerByKey = new Map<string, MockLedger>();

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
}

function requireUserId(userId: unknown, operation: string): asserts userId is string {
  if (!userId || typeof userId !== "string") throw new CreditContextRequiredError(operation);
}
