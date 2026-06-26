import { grantKey, matchGrantCriteria } from "@cunote/core";
import type {
  CompanyProfile,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import type {
  CompanyRecord,
  CompanyRepository,
  CreateCompanyInput,
  FeedbackReceipt,
  FeedbackRepository,
  GrantListOptions,
  GrantRepository,
  MatchEventReceipt,
  MatchRepository,
  ResolveCompanyProfileInput,
  SaveMatchEventInput,
  SaveCompanyProfileInput,
  ServiceRepositories,
  SubmitFeedbackInput,
} from "@cunote/core";

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
  };
}

class RuntimeGrantRepository<TPayload> implements GrantRepository<TPayload> {
  constructor(private readonly loaders: RuntimeRepositoryLoaders<TPayload>) {}

  async listActiveGrants(options: GrantListOptions = {}) {
    return this.loaders.loadGrants(options);
  }

  async findGrantById(grantId: string, options: GrantListOptions = {}) {
    const grants = await this.loaders.loadGrants(options);
    return grants.find((entry) => grantKey(entry.grant) === grantId || entry.grant.source_id === grantId) ?? null;
  }
}

class RuntimeCompanyRepository implements CompanyRepository {
  private readonly savedProfiles = new Map<string, CompanyProfile>();

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
    };
  }

  async listUserCompanies(_userId: string): Promise<CompanyRecord[]> {
    const profile = this.getSavedProfile(demoCompanyId(), _userId) ?? await this.loaders.loadCompanyProfile();
    return [{
      id: demoCompanyId(),
      name: profile.name ?? "샘플 기업",
      profile,
      role: "owner",
    }];
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

function profileKey(companyId: string, userId?: string): string {
  return userId ? `${userId}:${companyId}` : `company:${companyId}`;
}

function cloneProfile(profile: CompanyProfile): CompanyProfile {
  return JSON.parse(JSON.stringify(profile)) as CompanyProfile;
}
