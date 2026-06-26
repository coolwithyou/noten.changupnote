import type {
  CompanyProfile,
  MatchEventKind,
  MatchResult,
  NormalizedGrant,
  RoadmapNode,
} from "@cunote/contracts";

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

export interface CompanyRepository {
  getDefaultCompanyProfile(): Promise<CompanyProfile>;
  resolveCompanyProfile(input?: ResolveCompanyProfileInput): Promise<CompanyProfile | null>;
  createCompany(input: CreateCompanyInput): Promise<CompanyRecord>;
  saveCompanyProfile(input: SaveCompanyProfileInput): Promise<CompanyProfile>;
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
    userId?: string;
  }): Promise<void>;
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

export type FeedbackKind = "saved" | "dismissed" | "wrong" | "applied" | "note";

export interface SubmitFeedbackInput {
  companyId: string;
  grantId: string;
  kind: FeedbackKind;
  userId?: string;
  message?: string | null;
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

export interface EnrichmentCacheRepository {
  getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry>;
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
}
