import { and, desc, eq, or } from "drizzle-orm";
import type {
  CompanyProfile,
  CriterionDimension,
  Grant,
  GrantCriterion,
  GrantRaw,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import { matchGrantCriteria } from "@cunote/core";
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
  SaveMatchEventInput,
  SaveCompanyProfileInput,
  ServiceRepositories,
  SubmitFeedbackInput,
} from "@cunote/core";
import type { CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface DrizzleDatabaseClient {
  readonly dialect: "drizzle";
  readonly client: CunoteDb;
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

  async listActiveGrants(options: GrantListOptions = {}): Promise<Array<NormalizedGrant<TPayload>>> {
    const rows = await this.db.client
      .select({
        grant: schema.grants,
        criterion: schema.grantCriteria,
        raw: schema.grantRaw,
      })
      .from(schema.grants)
      .leftJoin(schema.grantCriteria, eq(schema.grantCriteria.grantId, schema.grants.id))
      .leftJoin(
        schema.grantRaw,
        and(
          eq(schema.grantRaw.source, schema.grants.source),
          eq(schema.grantRaw.sourceId, schema.grants.sourceId),
        ),
      )
      .where(or(
        eq(schema.grants.status, "open"),
        eq(schema.grants.status, "upcoming"),
        eq(schema.grants.status, "unknown"),
      ))
      .orderBy(desc(schema.grants.updatedAt))
      .limit(options.limit ?? 100);

    return hydrateGrants<TPayload>(rows);
  }

  async findGrantById(grantId: string, _options: GrantListOptions = {}): Promise<NormalizedGrant<TPayload> | null> {
    const parsed = parseGrantId(grantId);
    const rows = await this.db.client
      .select({
        grant: schema.grants,
        criterion: schema.grantCriteria,
        raw: schema.grantRaw,
      })
      .from(schema.grants)
      .leftJoin(schema.grantCriteria, eq(schema.grantCriteria.grantId, schema.grants.id))
      .leftJoin(
        schema.grantRaw,
        and(
          eq(schema.grantRaw.source, schema.grants.source),
          eq(schema.grantRaw.sourceId, schema.grants.sourceId),
        ),
      )
      .where(parsed
        ? and(eq(schema.grants.source, parsed.source), eq(schema.grants.sourceId, parsed.sourceId))
        : or(eq(schema.grants.id, grantId), eq(schema.grants.sourceId, grantId)))
      .limit(100);

    return hydrateGrants<TPayload>(rows)[0] ?? null;
  }
}

class DrizzleCompanyRepository implements CompanyRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async getDefaultCompanyProfile(): Promise<CompanyProfile> {
    const company = await this.db.client.select().from(schema.companies).limit(1);
    const first = company[0];
    if (!first) throw new Error("등록된 회사가 없습니다.");
    const profile = await this.resolveCompanyProfile({ companyId: first.id });
    if (!profile) throw new Error("회사 프로필을 찾지 못했습니다.");
    return profile;
  }

  async resolveCompanyProfile(input: {
    companyId?: string;
    bizNo?: string;
  } = {}): Promise<CompanyProfile | null> {
    const companyRows = await this.db.client
      .select()
      .from(schema.companies)
      .where(companyWhere(input))
      .limit(1);
    const company = companyRows[0];
    if (!company) return null;

    const profileRows = await this.db.client
      .select()
      .from(schema.companyProfiles)
      .where(eq(schema.companyProfiles.companyId, company.id));

    return toCompanyProfile(company, profileRows);
  }

  async saveCompanyProfile(input: SaveCompanyProfileInput): Promise<CompanyProfile> {
    const now = new Date();
    const rows = companyProfileRows(input.companyId, input.profile, now);
    const [company, profileRows] = await this.db.client.transaction(async (tx) => {
      const kind: "active" | "preliminary" = input.profile.is_preliminary ? "preliminary" : "active";
      const [updatedCompany] = await tx
        .update(schema.companies)
        .set({
          kind,
          name: input.profile.name ?? null,
        })
        .where(eq(schema.companies.id, input.companyId))
        .returning();
      if (!updatedCompany) throw new Error("회사를 찾지 못했습니다.");

      await tx.delete(schema.companyProfiles).where(eq(schema.companyProfiles.companyId, input.companyId));
      const savedRows = rows.length > 0
        ? await tx.insert(schema.companyProfiles).values(rows).returning()
        : [];
      return [updatedCompany, savedRows] as const;
    });

    return toCompanyProfile(company, profileRows);
  }

  async createCompany(input: CreateCompanyInput): Promise<CompanyRecord> {
    const now = new Date();
    const kind: "active" | "preliminary" = input.profile.is_preliminary ? "preliminary" : "active";
    const [company, profileRows] = await this.db.client.transaction(async (tx) => {
      const [createdCompany] = await tx
        .insert(schema.companies)
        .values({
          kind,
          name: input.profile.name ?? null,
          createdBy: input.userId,
        })
        .returning();
      if (!createdCompany) throw new Error("회사 생성 결과가 없습니다.");

      await tx.insert(schema.userCompany).values({
        userId: input.userId,
        companyId: createdCompany.id,
        role: "owner",
      });

      const rows = companyProfileRows(createdCompany.id, input.profile, now);
      const savedRows = rows.length > 0
        ? await tx.insert(schema.companyProfiles).values(rows).returning()
        : [];
      return [createdCompany, savedRows] as const;
    });

    return {
      id: company.id,
      name: company.name,
      profile: toCompanyProfile(company, profileRows),
      role: "owner",
    };
  }

  async listUserCompanies(userId: string): Promise<CompanyRecord[]> {
    const rows = await this.db.client
      .select({
        company: schema.companies,
        userCompany: schema.userCompany,
      })
      .from(schema.userCompany)
      .innerJoin(schema.companies, eq(schema.userCompany.companyId, schema.companies.id))
      .where(eq(schema.userCompany.userId, userId));

    return Promise.all(rows.map(async (row): Promise<CompanyRecord> => {
      const profile = await this.resolveCompanyProfile({ companyId: row.company.id });
      if (!profile) throw new Error(`회사 프로필을 찾지 못했습니다: ${row.company.id}`);
      return {
        id: row.company.id,
        name: row.company.name,
        profile,
        role: row.userCompany.role,
      };
    }));
  }
}

class DrizzleMatchRepository<TPayload> implements MatchRepository<TPayload> {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async calculateGrantMatch(input: {
    company: CompanyProfile;
    grant: NormalizedGrant<TPayload>;
  }): Promise<MatchResult> {
    return matchGrantCriteria(input.grant.criteria, input.company);
  }

  async calculateGrantMatches(input: {
    company: CompanyProfile;
    grants: Array<NormalizedGrant<TPayload>>;
  }): Promise<Array<{ grant: NormalizedGrant<TPayload>; match: MatchResult }>> {
    return input.grants.map((grant) => ({
      grant,
      match: matchGrantCriteria(grant.criteria, input.company),
    }));
  }

  async saveMatchState(input: {
    companyId: string;
    grantId: string;
    match: MatchResult;
  }): Promise<void> {
    const grantId = await this.resolveGrantRowId(input.grantId);
    if (!grantId) throw new Error("공고를 찾지 못했습니다.");

    await this.db.client
      .insert(schema.matchState)
      .values({
        companyId: input.companyId,
        grantId,
        eligibility: input.match.eligibility,
        matchScore: Math.round(input.match.fit_score),
        fitScore: Math.round(input.match.fit_score),
        competitiveness: null,
        valueScore: null,
        ruleTrace: input.match.rule_trace as unknown as Array<Record<string, unknown>>,
        matchConfidence: matchConfidence(input.match),
        eligibleFrom: null,
        eligibleUntil: null,
        rulesetVer: input.match.ruleset_ver,
        scoringVer: input.match.scoring_ver,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.matchState.companyId, schema.matchState.grantId],
        set: {
          eligibility: input.match.eligibility,
          matchScore: Math.round(input.match.fit_score),
          fitScore: Math.round(input.match.fit_score),
          competitiveness: null,
          valueScore: null,
          ruleTrace: input.match.rule_trace as unknown as Array<Record<string, unknown>>,
          matchConfidence: matchConfidence(input.match),
          eligibleFrom: null,
          eligibleUntil: null,
          rulesetVer: input.match.ruleset_ver,
          scoringVer: input.match.scoring_ver,
          updatedAt: new Date(),
        },
      });
  }

  async saveMatchEvent(input: SaveMatchEventInput): Promise<MatchEventReceipt> {
    const grantId = await this.resolveGrantRowId(input.grantId);
    if (!grantId) throw new Error("공고를 찾지 못했습니다.");

    const [row] = await this.db.client
      .insert(schema.matchEvents)
      .values({
        companyId: input.companyId,
        grantId,
        event: input.event,
        rulesetVer: input.rulesetVer ?? "unknown",
      })
      .returning({ id: schema.matchEvents.id, ts: schema.matchEvents.ts });
    if (!row) throw new Error("매칭 이벤트 저장 결과가 없습니다.");

    return {
      id: row.id,
      acceptedAt: row.ts.toISOString(),
    };
  }

  private async resolveGrantRowId(grantId: string): Promise<string | null> {
    const parsed = parseGrantId(grantId);
    const rows = await this.db.client
      .select({ id: schema.grants.id })
      .from(schema.grants)
      .where(parsed
        ? and(eq(schema.grants.source, parsed.source), eq(schema.grants.sourceId, parsed.sourceId))
        : or(eq(schema.grants.id, grantId), eq(schema.grants.sourceId, grantId)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}

class DrizzleFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackReceipt> {
    const [row] = await this.db.client
      .insert(schema.feedback)
      .values({
        targetType: "match",
        targetId: `${input.companyId}:${input.grantId}`,
        type: feedbackTypeFor(input.kind),
        value: {
          kind: input.kind,
          companyId: input.companyId,
          grantId: input.grantId,
          userId: input.userId ?? null,
          message: input.message ?? null,
        },
        actor: "user",
      })
      .returning({ id: schema.feedback.id, ts: schema.feedback.ts });

    if (!row) throw new Error("피드백 저장 결과가 없습니다.");
    return {
      id: row.id,
      receivedAt: row.ts.toISOString(),
    };
  }
}

type GrantRow = typeof schema.grants.$inferSelect;
type GrantCriteriaRow = typeof schema.grantCriteria.$inferSelect;
type GrantRawRow = typeof schema.grantRaw.$inferSelect;
type CompanyRow = typeof schema.companies.$inferSelect;
type CompanyProfileRow = typeof schema.companyProfiles.$inferSelect;
type CompanyProfileInsert = typeof schema.companyProfiles.$inferInsert;

function hydrateGrants<TPayload>(
  rows: Array<{
    grant: GrantRow;
    criterion: GrantCriteriaRow | null;
    raw: GrantRawRow | null;
  }>,
): Array<NormalizedGrant<TPayload>> {
  const grouped = new Map<string, {
    grant: GrantRow;
    raw: GrantRawRow | null;
    criteria: GrantCriteriaRow[];
  }>();

  for (const row of rows) {
    const current = grouped.get(row.grant.id) ?? {
      grant: row.grant,
      raw: row.raw,
      criteria: [],
    };
    if (row.criterion) current.criteria.push(row.criterion);
    grouped.set(row.grant.id, current);
  }

  return [...grouped.values()].map((entry) => ({
    raw: toGrantRaw<TPayload>(entry.raw, entry.grant),
    grant: toGrant(entry.grant),
    criteria: entry.criteria.map(toGrantCriterion),
  }));
}

function toGrant(row: GrantRow): Grant {
  const grant: Grant = {
    id: row.id,
    source: row.source,
    source_id: row.sourceId,
    title: row.title,
    url: row.url,
    agency_jurisdiction: row.agencyJurisdiction,
    agency_operator: row.agencyOperator,
    category_l1: row.categoryL1,
    category_l2: row.categoryL2,
    apply_start: dateString(row.applyStart),
    apply_end: dateString(row.applyEnd),
    support_amount: row.supportAmount,
    required_documents: (row.requiredDocuments ?? null) as unknown as NonNullable<Grant["required_documents"]>,
    status: row.status,
    f_regions: row.fRegions,
    f_industries: row.fIndustries,
    f_biz_age_min_months: row.fBizAgeMinMonths,
    f_biz_age_max_months: row.fBizAgeMaxMonths,
    f_sizes: row.fSizes,
    f_founder_traits: row.fFounderTraits,
    f_required_certs: row.fRequiredCerts,
    overall_confidence: row.overallConfidence,
    model_ver: row.modelVer,
    prompt_ver: row.promptVer,
    updated_at: row.updatedAt.toISOString(),
  };
  if (row.applyMethod) grant.apply_method = row.applyMethod;
  if (row.parserVersion) grant.parser_version = row.parserVersion;
  return grant;
}

function toGrantCriterion(row: GrantCriteriaRow): GrantCriterion {
  const criterion: GrantCriterion = {
    id: row.id,
    grant_id: row.grantId,
    dimension: row.dimension,
    operator: row.operator,
    value: row.value,
    kind: row.kind,
    confidence: row.confidence,
    needs_review: row.needsReview,
  };
  if (row.weight !== null) criterion.weight = row.weight;
  if (row.sourceSpan) criterion.source_span = row.sourceSpan;
  if (row.rawText) criterion.raw_text = row.rawText;
  if (row.sourceField) criterion.source_field = row.sourceField;
  if (row.parserVersion) criterion.parser_version = row.parserVersion;
  return criterion;
}

function toGrantRaw<TPayload>(raw: GrantRawRow | null, grant: GrantRow): GrantRaw<TPayload> {
  if (!raw) {
    return {
      source: grant.source,
      source_id: grant.sourceId,
      payload: {} as TPayload,
      status: "normalized",
    };
  }

  const result: GrantRaw<TPayload> = {
    source: raw.source,
    source_id: raw.sourceId,
    payload: raw.payload as TPayload,
    status: raw.status,
    collected_at: raw.collectedAt.toISOString(),
  };
  if (raw.rawHash) result.raw_hash = raw.rawHash;
  return result;
}

function toCompanyProfile(company: CompanyRow, rows: CompanyProfileRow[]): CompanyProfile {
  const profile: CompanyProfile = {
    id: company.id,
    is_preliminary: company.kind === "preliminary",
    confidence: {},
  };
  if (company.name) profile.name = company.name;

  for (const row of rows) {
    const value = row.value;
    profile.confidence![row.dimension] = row.confidence;
    if (row.dimension === "region") {
      const code = stringValue(value.code ?? value.region ?? value.sido);
      if (code) profile.region = { code, label: stringValue(value.label) ?? code };
    }
    if (row.dimension === "biz_age") {
      const months = numberValue(value.biz_age_months ?? value.months);
      if (months !== null) profile.biz_age_months = months;
    }
    if (row.dimension === "founder_age") {
      const age = numberValue(value.founder_age ?? value.age);
      if (age !== null) profile.founder_age = age;
    }
    if (row.dimension === "industry") {
      profile.industries = stringArray(value.industries ?? value.tags ?? value.policy_tags);
    }
    if (row.dimension === "size") {
      profile.size = stringValue(value.size ?? value.label) ?? null;
    }
    if (row.dimension === "certification") {
      profile.certs = stringArray(value.certs ?? value.certifications);
    }
    if (row.dimension === "founder_trait") {
      profile.traits = stringArray(value.traits);
    }
    if (row.dimension === "prior_award") {
      profile.prior_awards = stringArray(value.programs ?? value.prior_awards);
    }
    if (row.dimension === "business_status") {
      const status: NonNullable<CompanyProfile["business_status"]> = {
        active: Boolean(value.active),
      };
      const label = stringValue(value.label);
      if (label) status.label = label;
      profile.business_status = status;
    }
  }

  return profile;
}

function companyWhere(input: { companyId?: string; bizNo?: string }) {
  if (input.companyId) return eq(schema.companies.id, input.companyId);
  if (input.bizNo) return eq(schema.companies.bizNo, input.bizNo);
  return undefined;
}

function companyProfileRows(
  companyId: string,
  profile: CompanyProfile,
  now: Date,
): CompanyProfileInsert[] {
  const rows: CompanyProfileInsert[] = [];
  const push = (dimension: CriterionDimension, value: Record<string, unknown>) => {
    rows.push({
      companyId,
      dimension,
      value,
      source: "self_declared",
      confidence: profileConfidence(profile, dimension),
      asOf: now,
      updatedAt: now,
    });
  };

  if (profile.region?.code) {
    const value: Record<string, unknown> = { code: profile.region.code };
    if (profile.region.label) value.label = profile.region.label;
    push("region", value);
  }
  if (profile.biz_age_months !== null && profile.biz_age_months !== undefined) {
    push("biz_age", { biz_age_months: profile.biz_age_months, months: profile.biz_age_months });
  }
  if (profile.founder_age !== null && profile.founder_age !== undefined) {
    push("founder_age", { founder_age: profile.founder_age, age: profile.founder_age });
  }
  if (profile.industries?.length) {
    push("industry", { industries: profile.industries, tags: profile.industries });
  }
  if (profile.size) {
    push("size", { size: profile.size, label: profile.size });
  }
  if (profile.traits?.length) {
    push("founder_trait", { traits: profile.traits });
  }
  if (profile.certs?.length) {
    push("certification", { certs: profile.certs, certifications: profile.certs });
  }
  if (profile.prior_awards?.length) {
    push("prior_award", { prior_awards: profile.prior_awards, programs: profile.prior_awards });
  }
  if (profile.business_status) {
    push("business_status", compactRecord(profile.business_status as Record<string, unknown>));
  }

  return rows;
}

function profileConfidence(profile: CompanyProfile, dimension: CriterionDimension): number {
  const value = profile.confidence?.[dimension];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.8;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function matchConfidence(match: MatchResult): number {
  if (match.rule_trace.length === 0) return 0;
  const unknownCount = match.rule_trace.filter((trace) => trace.result === "unknown").length;
  const ratio = 1 - unknownCount / match.rule_trace.length;
  return Math.round(Math.max(0.3, ratio) * 100) / 100;
}

function parseGrantId(value: string): { source: "kstartup" | "bizinfo" | "bizinfo_event"; sourceId: string } | null {
  const [source, sourceId] = value.split(":");
  if (!sourceId) return null;
  if (source === "kstartup" || source === "bizinfo" || source === "bizinfo_event") {
    return { source, sourceId };
  }
  return null;
}

function dateString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function feedbackTypeFor(kind: SubmitFeedbackInput["kind"]) {
  if (kind === "saved" || kind === "applied") return "explicit_relevant";
  if (kind === "dismissed" || kind === "wrong") return "explicit_irrelevant";
  return "implicit";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
