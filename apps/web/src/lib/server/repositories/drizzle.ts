import type {
  CompanyProfile,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import type {
  CompanyRecord,
  CompanyRepository,
  FeedbackReceipt,
  FeedbackRepository,
  GrantListOptions,
  GrantRepository,
  MatchRepository,
  SaveCompanyProfileInput,
  ServiceRepositories,
  SubmitFeedbackInput,
} from "@cunote/core";

export interface DrizzleDatabaseClient {
  readonly dialect: "drizzle";
  readonly client: unknown;
}

export function createDrizzleRepositories<TPayload = unknown>(
  db: DrizzleDatabaseClient,
): ServiceRepositories<TPayload> {
  return {
    grants: new DrizzleGrantRepository<TPayload>(db),
    companies: new DrizzleCompanyRepository(db),
    matches: new DrizzleMatchRepository<TPayload>(db),
    feedback: new DrizzleFeedbackRepository(db),
  };
}

class DrizzleGrantRepository<TPayload> implements GrantRepository<TPayload> {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async listActiveGrants(_options: GrantListOptions = {}): Promise<Array<NormalizedGrant<TPayload>>> {
    throw notWired(this.db, "GrantRepository.listActiveGrants");
  }

  async findGrantById(_grantId: string, _options: GrantListOptions = {}): Promise<NormalizedGrant<TPayload> | null> {
    throw notWired(this.db, "GrantRepository.findGrantById");
  }
}

class DrizzleCompanyRepository implements CompanyRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async getDefaultCompanyProfile(): Promise<CompanyProfile> {
    throw notWired(this.db, "CompanyRepository.getDefaultCompanyProfile");
  }

  async resolveCompanyProfile(): Promise<CompanyProfile | null> {
    throw notWired(this.db, "CompanyRepository.resolveCompanyProfile");
  }

  async saveCompanyProfile(_input: SaveCompanyProfileInput): Promise<CompanyProfile> {
    throw notWired(this.db, "CompanyRepository.saveCompanyProfile");
  }

  async listUserCompanies(_userId: string): Promise<CompanyRecord[]> {
    throw notWired(this.db, "CompanyRepository.listUserCompanies");
  }
}

class DrizzleMatchRepository<TPayload> implements MatchRepository<TPayload> {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async calculateGrantMatch(): Promise<MatchResult> {
    throw notWired(this.db, "MatchRepository.calculateGrantMatch");
  }

  async calculateGrantMatches(): Promise<Array<{ grant: NormalizedGrant<TPayload>; match: MatchResult }>> {
    throw notWired(this.db, "MatchRepository.calculateGrantMatches");
  }

  async saveMatchState(): Promise<void> {
    throw notWired(this.db, "MatchRepository.saveMatchState");
  }
}

class DrizzleFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async submitFeedback(_input: SubmitFeedbackInput): Promise<FeedbackReceipt> {
    throw notWired(this.db, "FeedbackRepository.submitFeedback");
  }
}

function notWired(db: DrizzleDatabaseClient, method: string): Error {
  return new Error(`${method} is not wired to the ${db.dialect} adapter yet.`);
}
