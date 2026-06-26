import type {
  CompanyProfile,
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

export interface CompanyRepository {
  getDefaultCompanyProfile(): Promise<CompanyProfile>;
  resolveCompanyProfile(input?: ResolveCompanyProfileInput): Promise<CompanyProfile | null>;
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
  }): Promise<void>;
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

export interface RoadmapRepository {
  listCompanyRoadmap(companyId: string): Promise<RoadmapNode[]>;
}

export interface ServiceRepositories<TPayload = unknown> {
  grants: GrantRepository<TPayload>;
  companies: CompanyRepository;
  matches: MatchRepository<TPayload>;
  feedback: FeedbackRepository;
}
