import { grantKey, maskCorpNum, matchGrantCriteria } from "@cunote/core";
import type {
  CompanyProfile,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import type {
  CompanyRecord,
  CompanyRepository,
  CreateCompanyInput,
  EnrichmentCacheEntry,
  EnrichmentCacheRepository,
  FeedbackReceipt,
  FeedbackRepository,
  GrantListOptions,
  GrantRepository,
  MatchEventReceipt,
  MatchRepository,
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
    const saved = this.getSavedProfile(demoCompanyId());
    if (saved) return saved;
    return this.loaders.loadCompanyProfile();
  }

  async resolveCompanyProfile(input: ResolveCompanyProfileInput = {}) {
    if (input.companyId && input.companyId !== demoCompanyId()) return null;
    if (input.companyId) {
      const saved = this.getSavedProfile(input.companyId, input.userId);
      if (saved) return saved;
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
    const profile = this.getSavedProfile(demoCompanyId(), _userId) ?? await this.loaders.loadCompanyProfile();
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

  private getSavedProfile(companyId: string, userId?: string): CompanyProfile | null {
    const profile = userId
      ? this.savedProfiles.get(profileKey(companyId, userId)) ?? this.savedProfiles.get(profileKey(companyId))
      : this.savedProfiles.get(profileKey(companyId));
    return profile ? cloneProfile(profile) : null;
  }

  private setSavedProfile(companyId: string, profile: CompanyProfile, userId?: string) {
    const cloned = cloneProfile(profile);
    this.savedProfiles.set(profileKey(companyId), cloned);
    if (userId) this.savedProfiles.set(profileKey(companyId, userId), cloned);
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
