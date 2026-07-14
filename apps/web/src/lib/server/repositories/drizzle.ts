import { and, asc, desc, eq, gte, inArray, isNull, lte, notExists, or } from "drizzle-orm";
import {
  CRITERION_DIMENSIONS,
  type CompanyProfileFieldEvidence,
  type CompanyProfileQuestionAnswerState,
  type CompanyProfileEvidenceObservation,
  type CompanyProfile,
  type CriterionDimension,
} from "@cunote/contracts";
import type {
  ApplyMethodChannel,
  AuthoringMode,
  Grant,
  GrantCriterion,
  GrantRaw,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import {
  buildGrantExtractionManifest,
  assembleCompanyProfile,
  canonicalCompanyProfileObservationIdentity,
  collapseConfirmedGrantOccurrences,
  companyProfileValueForDimension,
  companyProfileToFieldUpdates,
  maskCorpNum,
  matchNormalizedGrant,
  normalizeCompanyIndustryProfile,
  resolveEvidencePrecedence,
  stableCanonicalStringify,
  type CompanyProfileFieldUpdate,
} from "@cunote/core";
import type {
  CompanyRecord,
  CompanyRepository,
  CreateCompanyInput,
  DeleteEnrichmentCacheInput,
  EnrichmentCacheEntry,
  EnrichmentCacheRepository,
  FeedbackReceipt,
  FeedbackRepository,
  GrantListOptions,
  GrantRepository,
  MatchEventReceipt,
  MatchRepository,
  ProfileQuestionEventReceipt,
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
import type { CunoteDb, CunoteDbSession } from "@/lib/server/db/client";
import { withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  activeGrantApplyEndCutoff,
  isClearlyStaleUndatedGrant,
  isKStartupRecruitmentClosedPayload,
} from "./activeGrantFilter";
import { DrizzleCreditRepository, DrizzleCreditSystemRepository } from "./creditRepository";
import { DrizzlePaymentRepository } from "./paymentRepository";
import { DrizzleSubscriptionRepository } from "./subscriptionRepository";

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
    enrichmentCache: new DrizzleEnrichmentCacheRepository(db),
    registryIndex: new DrizzleRegistryIndexRepository(db),
    credits: new DrizzleCreditRepository({ client: db.client }),
    creditsSystem: new DrizzleCreditSystemRepository({ client: db.client }),
    creditsPayment: new DrizzlePaymentRepository({ client: db.client }),
    creditsSubscription: new DrizzleSubscriptionRepository({ client: db.client }),
  };
}

class DrizzleGrantRepository<TPayload> implements GrantRepository<TPayload> {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async listActiveGrants(options: GrantListOptions = {}): Promise<Array<NormalizedGrant<TPayload>>> {
    // limit 은 조인 전 "공고 수" 기준이어야 한다. criteria LEFT JOIN 결과 행에 limit 을 걸면
    // 공고당 조건 수만큼 실제 공고 수가 줄어드는 버그가 있었다(limit 40 요청 시 ~13건).
    // 그래서 1단계에서 공고 id 만 limit 으로 뽑고, 2단계에서 criteria·raw 를 조인한다.
    const activeWhere = or(
      and(eq(schema.grants.status, "open"), activeGrantApplyEndWhere(options.asOf)),
      and(eq(schema.grants.status, "upcoming"), activeGrantApplyEndWhere(options.asOf)),
      and(eq(schema.grants.status, "unknown"), activeGrantApplyEndWhere(options.asOf)),
    );
    const requestedLimit = options.limit ?? 100;
    const confirmedMemberFilter = options.includeConfirmedDuplicates
      ? undefined
      : notExists(this.db.client
        .select({ memberGrantId: schema.dedupLinks.memberGrantId })
        .from(schema.dedupLinks)
        .where(and(
          eq(schema.dedupLinks.memberGrantId, schema.grants.id),
          eq(schema.dedupLinks.confirmed, true),
        )));
    const candidateRows = await this.db.client
      .select({
        id: schema.grants.id,
        source: schema.grants.source,
        status: schema.grants.status,
        title: schema.grants.title,
        applyEnd: schema.grants.applyEnd,
        rawPayload: schema.grantRaw.payload,
      })
      .from(schema.grants)
      .leftJoin(
        schema.grantRaw,
        and(
          eq(schema.grantRaw.source, schema.grants.source),
          eq(schema.grantRaw.sourceId, schema.grants.sourceId),
        ),
      )
      .where(and(activeWhere, confirmedMemberFilter))
      .orderBy(desc(schema.grants.updatedAt))
      .limit(requestedLimit + 500);
    const idRows = candidateRows
      .filter((row) =>
        !isClearlyStaleUndatedGrant({
          source: row.source,
          status: row.status,
          title: row.title,
          apply_end: row.applyEnd?.toISOString() ?? null,
        }, options.asOf) &&
        !isKStartupRecruitmentClosedPayload(row.source, row.rawPayload)
      )
      .slice(0, requestedLimit);
    if (idRows.length === 0) return [];
    const confirmedLinks = options.includeConfirmedDuplicates
      ? []
      : await this.db.client
        .select({
          canonicalGrantKey: schema.dedupLinks.canonicalGrantId,
          memberGrantKey: schema.dedupLinks.memberGrantId,
        })
        .from(schema.dedupLinks)
        .where(eq(schema.dedupLinks.confirmed, true));
    const hydrationIds = reachableDedupIds(idRows.map((row) => row.id), confirmedLinks);

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
      .where(inArray(schema.grants.id, hydrationIds))
      .orderBy(desc(schema.grants.updatedAt));

    const grants = hydrateGrants<TPayload>(rows);
    const [archives, surfaces] = await Promise.all([
      this.loadAttachmentArchives(grants),
      this.loadApplicationSurfaces(grants),
    ]);
    const hydrated = await this.hydrateReviewedExtractionManifests(
      mergeCurrentAttachmentArchiveState(grants, archives, surfaces),
    );
    return options.includeConfirmedDuplicates
      ? hydrated
      : collapseConfirmedGrantOccurrences(hydrated, confirmedLinks);
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

    const grants = hydrateGrants<TPayload>(rows);
    const [archives, surfaces] = await Promise.all([
      this.loadAttachmentArchives(grants),
      this.loadApplicationSurfaces(grants),
    ]);
    const hydrated = await this.hydrateReviewedExtractionManifests(
      mergeCurrentAttachmentArchiveState(grants, archives, surfaces),
    );
    return hydrated[0] ?? null;
  }

  private async hydrateReviewedExtractionManifests(
    grants: Array<NormalizedGrant<TPayload>>,
  ): Promise<Array<NormalizedGrant<TPayload>>> {
    const grantIds = grants.flatMap((entry) => entry.grant.id ? [entry.grant.id] : []);
    if (grantIds.length === 0) return grants;
    const rows = await this.db.client
      .select({
        grantId: schema.extractionLog.grantId,
        output: schema.extractionLog.output,
        ts: schema.extractionLog.ts,
        modelVer: schema.extractionLog.modelVer,
      })
      .from(schema.extractionLog)
      .where(and(
        eq(schema.extractionLog.status, "labeled"),
        inArray(schema.extractionLog.grantId, grantIds),
      ))
      .orderBy(desc(schema.extractionLog.ts));
    return mergeReviewedExtractionManifestState(grants, rows);
  }

  private async loadAttachmentArchives(
    grants: Array<NormalizedGrant<TPayload>>,
  ): Promise<Array<typeof schema.grantAttachmentArchives.$inferSelect>> {
    const sourceIds = uniqueStrings(grants.map((entry) => entry.grant.source_id));
    if (sourceIds.length === 0) return [];
    return this.db.client
      .select()
      .from(schema.grantAttachmentArchives)
      .where(inArray(schema.grantAttachmentArchives.sourceId, sourceIds));
  }

  private async loadApplicationSurfaces(
    grants: Array<NormalizedGrant<TPayload>>,
  ): Promise<Array<typeof schema.grantApplicationSurfaces.$inferSelect>> {
    const sourceIds = uniqueStrings(grants.map((entry) => entry.grant.source_id));
    if (sourceIds.length === 0) return [];
    return this.db.client
      .select()
      .from(schema.grantApplicationSurfaces)
      .where(inArray(schema.grantApplicationSurfaces.sourceId, sourceIds));
  }
}

export interface ReviewedExtractionMetadataRow {
  grantId: string | null;
  output: unknown;
  ts: Date;
  modelVer: string;
}

export function mergeReviewedExtractionManifestState<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
  rows: ReviewedExtractionMetadataRow[],
): Array<NormalizedGrant<TPayload>> {
  const latestByGrant = new Map<string, ReviewedExtractionMetadataRow>();
  for (const row of rows) {
    if (row.grantId && !latestByGrant.has(row.grantId)) latestByGrant.set(row.grantId, row);
  }
  return grants.map((entry) => {
    if (!entry.grant.id) return entry;
    const review = latestByGrant.get(entry.grant.id);
    if (!review) return entry;
    const output = isPlainRecord(review.output) ? review.output : {};
    const reviewedAt = typeof output.reviewedAt === "string" ? output.reviewedAt : review.ts.toISOString();
    return {
      ...entry,
      extraction_manifest: buildGrantExtractionManifest(entry, {
        reviewedAt,
        extractorVersion: typeof output.parserVersion === "string" ? output.parserVersion : review.modelVer,
      }),
    };
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeGrantApplyEndWhere(asOf: Date | undefined) {
  return or(
    isNull(schema.grants.applyEnd),
    gte(schema.grants.applyEnd, activeGrantApplyEndCutoff(asOf)),
  );
}

function reachableDedupIds(
  seedIds: string[],
  links: Array<{ canonicalGrantKey: string; memberGrantKey: string }>,
): string[] {
  const reachable = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (!reachable.has(link.canonicalGrantKey) || reachable.has(link.memberGrantKey)) continue;
      reachable.add(link.memberGrantKey);
      changed = true;
    }
  }
  return [...reachable];
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
    userId?: string;
  } = {}): Promise<CompanyProfile | null> {
    return this.withOptionalUser(input.userId, async (db) => {
      const companyRows = await db
      .select()
      .from(schema.companies)
      .where(companyWhere(input))
      .limit(1);
      const company = companyRows[0];
      if (!company) return null;

      const sharedProfileRows = await db
        .select()
        .from(schema.companyProfiles)
        .where(and(
          eq(schema.companyProfiles.companyId, company.id),
          isNull(schema.companyProfiles.userId),
        ));
      const userProfileRows = input.userId
        ? await db
          .select()
          .from(schema.companyProfiles)
          .where(and(
            eq(schema.companyProfiles.companyId, company.id),
            eq(schema.companyProfiles.userId, input.userId),
          ))
        : [];

      return decodeCompanyProfileRows(company, [...sharedProfileRows, ...userProfileRows]);
    });
  }

  async saveCompanyProfile(input: SaveCompanyProfileInput): Promise<CompanyProfile> {
    const now = new Date();
    const rows = encodeCompanyProfileRows(input.companyId, input.profile, now, input.userId);
    const [company, profileRows] = await this.transactionWithOptionalUser(input.userId, async (tx) => {
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

      await tx.delete(schema.companyProfiles).where(companyProfileScopeWhere(input.companyId, input.userId));
      const savedRows = rows.length > 0
        ? await tx.insert(schema.companyProfiles).values(rows).returning()
        : [];
      return [updatedCompany, savedRows] as const;
    });

    return decodeCompanyProfileRows(company, profileRows);
  }

  async createCompany(input: CreateCompanyInput): Promise<CompanyRecord> {
    const now = new Date();
    const kind: "active" | "preliminary" = input.profile.is_preliminary ? "preliminary" : "active";
    const [company, profileRows] = await withCunoteDbUser(this.db.client, input.userId, async (tx) => {
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

      const rows = encodeCompanyProfileRows(createdCompany.id, input.profile, now, input.userId);
      const savedRows = rows.length > 0
        ? await tx.insert(schema.companyProfiles).values(rows).returning()
        : [];
      return [createdCompany, savedRows] as const;
    });

    return {
      id: company.id,
      name: company.name,
      profile: decodeCompanyProfileRows(company, profileRows),
      role: "owner",
      verified: company.verified,
      verifiedAt: company.verifiedAt?.toISOString() ?? null,
      verifyMethod: company.verifyMethod,
      bizNoMasked: company.bizNo ? maskBizNo(company.bizNo) : null,
    };
  }

  async listUserCompanies(userId: string): Promise<CompanyRecord[]> {
    const rows = await withCunoteDbUser(this.db.client, userId, async (db) => db
      .select({
        company: schema.companies,
        userCompany: schema.userCompany,
      })
      .from(schema.userCompany)
      .innerJoin(schema.companies, eq(schema.userCompany.companyId, schema.companies.id))
      .where(eq(schema.userCompany.userId, userId)));

    return Promise.all(rows.map(async (row): Promise<CompanyRecord> => {
      const profile = await this.resolveCompanyProfile({ companyId: row.company.id, userId });
      if (!profile) throw new Error(`회사 프로필을 찾지 못했습니다: ${row.company.id}`);
      return {
        id: row.company.id,
        name: row.company.name,
        profile,
        role: row.userCompany.role,
        verified: row.company.verified,
        verifiedAt: row.company.verifiedAt?.toISOString() ?? null,
        verifyMethod: row.company.verifyMethod,
        bizNoMasked: row.company.bizNo ? maskBizNo(row.company.bizNo) : null,
      };
    }));
  }

  async verifyCompany(input: VerifyCompanyInput): Promise<CompanyVerificationRecord> {
    const now = new Date();
    const [row] = await withCunoteDbUser(this.db.client, input.userId, async (db) => db
      .update(schema.companies)
      .set({
        bizNo: input.bizNo,
        verified: true,
        verifiedAt: now,
        verifyMethod: input.verifyMethod ?? "dev_self_declared",
      })
      .where(eq(schema.companies.id, input.companyId))
      .returning({
        id: schema.companies.id,
        bizNo: schema.companies.bizNo,
        verified: schema.companies.verified,
        verifiedAt: schema.companies.verifiedAt,
        verifyMethod: schema.companies.verifyMethod,
      }));
    if (!row || !row.bizNo || !row.verifiedAt || !row.verifyMethod) {
      throw new Error("회사 검증 결과가 없습니다.");
    }
    return {
      companyId: row.id,
      bizNo: row.bizNo,
      verified: row.verified,
      verifiedAt: row.verifiedAt.toISOString(),
      verifyMethod: row.verifyMethod,
    };
  }

  private async withOptionalUser<T>(
    userId: string | undefined,
    run: (db: CunoteDbSession) => Promise<T>,
  ): Promise<T> {
    if (userId) return withCunoteDbUser(this.db.client, userId, run);
    return run(this.db.client);
  }

  private async transactionWithOptionalUser<T>(
    userId: string | undefined,
    run: (db: CunoteDbSession) => Promise<T>,
  ): Promise<T> {
    if (userId) return withCunoteDbUser(this.db.client, userId, run);
    return this.db.client.transaction(async (tx) => run(tx as unknown as CunoteDbSession));
  }
}

class DrizzleMatchRepository<TPayload> implements MatchRepository<TPayload> {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async calculateGrantMatch(input: {
    company: CompanyProfile;
    grant: NormalizedGrant<TPayload>;
  }): Promise<MatchResult> {
    return matchNormalizedGrant(input.grant, input.company);
  }

  async calculateGrantMatches(input: {
    company: CompanyProfile;
    grants: Array<NormalizedGrant<TPayload>>;
  }): Promise<Array<{ grant: NormalizedGrant<TPayload>; match: MatchResult }>> {
    return input.grants.map((grant) => ({
      grant,
      match: matchNormalizedGrant(grant, input.company),
    }));
  }

  async saveMatchState(input: {
    companyId: string;
    grantId: string;
    match: MatchResult;
    eligibleFrom?: Date | null;
    eligibleUntil?: Date | null;
    userId?: string;
  }): Promise<void> {
    const grantId = await this.resolveGrantRowId(input.grantId);
    if (!grantId) throw new Error("공고를 찾지 못했습니다.");

    await this.withOptionalUser(input.userId, async (db) => {
      await db
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
        eligibleFrom: input.eligibleFrom ?? null,
        eligibleUntil: input.eligibleUntil ?? null,
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
          eligibleFrom: input.eligibleFrom ?? null,
          eligibleUntil: input.eligibleUntil ?? null,
          rulesetVer: input.match.ruleset_ver,
          scoringVer: input.match.scoring_ver,
          updatedAt: new Date(),
        },
      });
    });
  }

  async listDueMatchTransitions(input: {
    asOf: Date;
    limit?: number;
    userId?: string;
  }) {
    const rows = await this.withOptionalUser(input.userId, async (db) => db
      .select({
        companyId: schema.matchState.companyId,
        grantId: schema.matchState.grantId,
        eligibility: schema.matchState.eligibility,
        eligibleFrom: schema.matchState.eligibleFrom,
        eligibleUntil: schema.matchState.eligibleUntil,
        updatedAt: schema.matchState.updatedAt,
      })
      .from(schema.matchState)
      .where(or(
        and(
          eq(schema.matchState.eligibility, "ineligible"),
          lte(schema.matchState.eligibleFrom, input.asOf),
        ),
        and(
          or(
            eq(schema.matchState.eligibility, "eligible"),
            eq(schema.matchState.eligibility, "conditional"),
          ),
          lte(schema.matchState.eligibleUntil, input.asOf),
        ),
      ))
      .orderBy(asc(schema.matchState.eligibleFrom), asc(schema.matchState.eligibleUntil))
      .limit(input.limit ?? 500));

    return rows.map((row) => ({
      companyId: row.companyId,
      grantId: row.grantId,
      eligibility: row.eligibility,
      eligibleFrom: row.eligibleFrom,
      eligibleUntil: row.eligibleUntil,
      updatedAt: row.updatedAt,
    }));
  }

  async saveMatchEvent(input: SaveMatchEventInput): Promise<MatchEventReceipt> {
    const grantId = await this.resolveGrantRowId(input.grantId);
    if (!grantId) throw new Error("공고를 찾지 못했습니다.");

    const [row] = await this.withOptionalUser(input.userId, async (db) => db
      .insert(schema.matchEvents)
      .values({
        companyId: input.companyId,
        grantId,
        event: input.event,
        rulesetVer: input.rulesetVer ?? "unknown",
      })
      .returning({ id: schema.matchEvents.id, ts: schema.matchEvents.ts }));
    if (!row) throw new Error("매칭 이벤트 저장 결과가 없습니다.");

    return {
      id: row.id,
      acceptedAt: row.ts.toISOString(),
    };
  }


  async saveProfileQuestionEvent(input: SaveProfileQuestionEventInput): Promise<ProfileQuestionEventReceipt> {
    const impact = input.impact;
    const [row] = await this.withOptionalUser(input.userId, async (db) => db
      .insert(schema.profileQuestionEvents)
      .values({
        companyId: input.companyId,
        sessionId: input.sessionId,
        dimension: impact.dimension,
        windowLimit: impact.windowLimit,
        evaluatedGrantCount: impact.evaluatedGrantCount,
        targetedConditionalCount: impact.targetedConditionalCount,
        dimensionResolvedGrantCount: impact.dimensionResolvedGrantCount,
        eligibilityResolvedCount: impact.eligibilityResolvedCount,
        conditionalToEligibleCount: impact.conditionalToEligibleCount,
        conditionalToIneligibleCount: impact.conditionalToIneligibleCount,
        remainingConditionalCount: impact.remainingConditionalCount,
        conditionalResolutionRate: impact.conditionalResolutionRate,
        rulesetVer: input.rulesetVer,
      })
      .returning({ id: schema.profileQuestionEvents.id, ts: schema.profileQuestionEvents.ts }));
    if (!row) throw new Error("프로필 질문 이벤트 저장 결과가 없습니다.");
    return {
      id: row.id,
      sessionId: input.sessionId,
      recordedAt: row.ts.toISOString(),
      persisted: true,
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

  private async withOptionalUser<T>(
    userId: string | undefined,
    run: (db: CunoteDbSession) => Promise<T>,
  ): Promise<T> {
    if (userId) return withCunoteDbUser(this.db.client, userId, run);
    return run(this.db.client);
  }
}

class DrizzleFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackReceipt> {
    const [row] = await this.withOptionalUser(input.userId, async (db) => db
      .insert(schema.feedback)
      .values({
        targetType: "match",
        targetId: `${input.companyId}:${input.grantId}`,
        type: feedbackTypeFor(input),
        value: feedbackValue(input),
        actor: "user",
      })
      .returning({ id: schema.feedback.id, ts: schema.feedback.ts }));

    if (!row) throw new Error("피드백 저장 결과가 없습니다.");
    return {
      id: row.id,
      receivedAt: row.ts.toISOString(),
    };
  }

  private async withOptionalUser<T>(
    userId: string | undefined,
    run: (db: CunoteDbSession) => Promise<T>,
  ): Promise<T> {
    if (userId) return withCunoteDbUser(this.db.client, userId, run);
    return run(this.db.client);
  }
}

class DrizzleEnrichmentCacheRepository implements EnrichmentCacheRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null> {
    const rows = await this.db.client
      .select()
      .from(schema.companyEnrichmentCache)
      .where(and(
        eq(schema.companyEnrichmentCache.provider, input.provider),
        eq(schema.companyEnrichmentCache.bizNo, input.bizNo),
        eq(schema.companyEnrichmentCache.scope, input.scope),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const now = input.now ?? new Date();
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
    return toEnrichmentCacheEntry(row);
  }

  async put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry> {
    const values = {
      provider: input.provider,
      bizNo: input.bizNo,
      scope: input.scope,
      rawPayload: input.rawPayload ?? null,
      canonicalPayload: input.canonicalPayload ?? null,
      providerResultCode: input.providerResultCode ?? null,
      providerResultMessage: input.providerResultMessage ?? null,
      checkedAt: input.checkedAt ?? null,
      fetchedAt: input.fetchedAt ?? new Date(),
      expiresAt: input.expiresAt ?? null,
      payloadHash: input.payloadHash ?? null,
      lastError: input.lastError ?? null,
    };
    const [row] = await this.db.client
      .insert(schema.companyEnrichmentCache)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.companyEnrichmentCache.provider,
          schema.companyEnrichmentCache.bizNo,
          schema.companyEnrichmentCache.scope,
        ],
        set: values,
      })
      .returning();
    if (!row) throw new Error("기업정보 보강 캐시 저장 결과가 없습니다.");
    return toEnrichmentCacheEntry(row);
  }

  async listByBizNo(bizNo: string): Promise<EnrichmentCacheEntry[]> {
    const rows = await this.db.client
      .select()
      .from(schema.companyEnrichmentCache)
      .where(eq(schema.companyEnrichmentCache.bizNo, bizNo))
      .orderBy(
        asc(schema.companyEnrichmentCache.provider),
        asc(schema.companyEnrichmentCache.scope),
      );
    return rows.map(toEnrichmentCacheEntry);
  }

  async deleteByBizNo(input: DeleteEnrichmentCacheInput): Promise<number> {
    const filters = [eq(schema.companyEnrichmentCache.bizNo, input.bizNo)];
    if (input.provider) filters.push(eq(schema.companyEnrichmentCache.provider, input.provider));
    if (input.scope) filters.push(eq(schema.companyEnrichmentCache.scope, input.scope));
    const rows = await this.db.client
      .delete(schema.companyEnrichmentCache)
      .where(and(...filters))
      .returning({ provider: schema.companyEnrichmentCache.provider });
    return rows.length;
  }
}

class DrizzleRegistryIndexRepository implements RegistryIndexRepository {
  constructor(private readonly db: DrizzleDatabaseClient) {}

  async findCandidates(input: RegistryCandidateQuery): Promise<RegistryRecord[]> {
    const or_conds = [];
    if (input.bizNo) or_conds.push(eq(schema.registryIndex.bizNo, input.bizNo));
    if (input.corpNo) or_conds.push(eq(schema.registryIndex.corpNo, input.corpNo));
    if (input.nameNormalized) {
      or_conds.push(eq(schema.registryIndex.nameNormalized, input.nameNormalized));
    }
    if (or_conds.length === 0) return [];
    const match = or(...or_conds);
    const activeRunIds = this.db.client
      .select({ id: schema.registrySourceState.activeRunId })
      .from(schema.registrySourceState);
    // 마이그레이션 직후 기존 build.ts 적재분(import_run_id=null)은 source_state가 아직 없을
    // 때만 읽는다. ops에서 첫 버전을 publish하면 active_run_id 행만 조회해 이전 버전과 격리한다.
    const visible = or(
      inArray(schema.registryIndex.importRunId, activeRunIds),
      and(
        isNull(schema.registryIndex.importRunId),
        notExists(
          this.db.client
            .select({ source: schema.registrySourceState.source })
            .from(schema.registrySourceState)
            .where(eq(schema.registrySourceState.source, schema.registryIndex.source)),
        ),
      ),
    );
    const where = input.registryType
      ? and(eq(schema.registryIndex.registryType, input.registryType), match, visible)
      : and(match, visible);
    const rows = await this.db.client.select().from(schema.registryIndex).where(where);
    return rows.map(toRegistryRecord);
  }

  async hasSource(source: string): Promise<boolean> {
    const state = await this.db.client
      .select({ freshUntil: schema.registrySourceState.freshUntil })
      .from(schema.registrySourceState)
      .where(eq(schema.registrySourceState.source, source))
      .limit(1);
    if (state[0]) return state[0].freshUntil.getTime() > Date.now();

    // 첫 ops publish 전의 레거시 적재분 호환. source_state 생성 후에는 freshness를 강제한다.
    const rows = await this.db.client
      .select({ id: schema.registryIndex.id })
      .from(schema.registryIndex)
      .where(and(eq(schema.registryIndex.source, source), isNull(schema.registryIndex.importRunId)))
      .limit(1);
    return rows.length > 0;
  }

  async replaceBySource(source: string, records: RegistryRecord[]): Promise<number> {
    return this.db.client.transaction(async (tx) => {
      await tx.delete(schema.registryIndex).where(eq(schema.registryIndex.source, source));
      if (records.length === 0) return 0;
      const values = records.map(toRegistryInsert);
      for (let i = 0; i < values.length; i += 1000) {
        await tx.insert(schema.registryIndex).values(values.slice(i, i + 1000));
      }
      return records.length;
    });
  }
}

type GrantRow = typeof schema.grants.$inferSelect;
type GrantCriteriaRow = typeof schema.grantCriteria.$inferSelect;
type GrantRawRow = typeof schema.grantRaw.$inferSelect;
type CompanyRow = typeof schema.companies.$inferSelect;
type CompanyProfileRow = typeof schema.companyProfiles.$inferSelect;
export type CompanyProfilePersistenceInsert = typeof schema.companyProfiles.$inferInsert;
type CompanyEnrichmentCacheRow = typeof schema.companyEnrichmentCache.$inferSelect;
type RegistryIndexRow = typeof schema.registryIndex.$inferSelect;
type RegistryIndexInsert = typeof schema.registryIndex.$inferInsert;

function toRegistryRecord(row: RegistryIndexRow): RegistryRecord {
  return {
    registryType: row.registryType,
    flagOrCert: row.flagOrCert,
    polarity: row.polarity,
    bizNo: row.bizNo,
    corpNo: row.corpNo,
    nameNormalized: row.nameNormalized,
    representative: row.representative,
    regionSido: row.regionSido,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    detail: row.detail,
    source: row.source,
    sourceFetchedAt: row.sourceFetchedAt,
    confidence: row.confidence,
  };
}

function toRegistryInsert(record: RegistryRecord): RegistryIndexInsert {
  return {
    registryType: record.registryType,
    flagOrCert: record.flagOrCert,
    polarity: record.polarity,
    bizNo: record.bizNo,
    corpNo: record.corpNo,
    nameNormalized: record.nameNormalized,
    representative: record.representative,
    regionSido: record.regionSido,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    detail: record.detail,
    source: record.source,
    sourceFetchedAt: record.sourceFetchedAt,
    confidence: record.confidence,
  };
}

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

export function mergeCurrentAttachmentArchiveState<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
  archiveRows: Array<Pick<
    typeof schema.grantAttachmentArchives.$inferSelect,
    | "source" | "sourceId" | "filename" | "sourceUri" | "archiveUrl" | "storageKey"
    | "contentType" | "bytes" | "sha256" | "fetchedAt" | "conversionStatus"
    | "markdownUrl" | "markdownStorageKey" | "markdownSha256" | "markdownBytes"
    | "converter" | "convertedAt" | "conversionError"
  >>,
  surfaceRows: Array<Pick<
    typeof schema.grantApplicationSurfaces.$inferSelect,
    "source" | "sourceId" | "title" | "sourceAttachment" | "extractionStatus"
  >> = [],
): Array<NormalizedGrant<TPayload>> {
  const rowsByGrant = new Map<string, typeof archiveRows>();
  for (const row of archiveRows) {
    const key = `${row.source}:${row.sourceId}`;
    rowsByGrant.set(key, [...(rowsByGrant.get(key) ?? []), row]);
  }

  return grants.map((entry) => {
    const rows = rowsByGrant.get(`${entry.grant.source}:${entry.grant.source_id}`) ?? [];
    if (rows.length === 0 || !entry.raw.attachments?.length) return entry;
    return {
      ...entry,
      raw: {
        ...entry.raw,
        attachments: entry.raw.attachments.map((attachment) => {
          const sourceUri = attachment.source_uri ?? attachment.url ?? "";
          const row = rows.find((candidate) =>
            candidate.filename === attachment.filename &&
            (!candidate.sourceUri || !sourceUri || candidate.sourceUri === sourceUri)) ??
            rows.find((candidate) => candidate.filename === attachment.filename);
          if (!row) return attachment;
          const surface = surfaceRows.find((candidate) =>
            candidate.source === entry.grant.source &&
            candidate.sourceId === entry.grant.source_id &&
            (
              candidate.title === attachment.filename ||
              (candidate.sourceAttachment !== null && candidate.sourceAttachment === row.storageKey)
            ));
          const conversionStatus = surfaceConversionStatus(surface?.extractionStatus) ??
            normalizedConversionStatus(row.conversionStatus);
          return {
            ...attachment,
            ...(row.archiveUrl !== null ? { archive_url: row.archiveUrl } : {}),
            ...(row.storageKey !== null ? { storage_key: row.storageKey } : {}),
            ...(row.contentType !== null ? { content_type: row.contentType } : {}),
            ...(row.bytes !== null ? { bytes: row.bytes } : {}),
            ...(row.sha256 !== null ? { sha256: row.sha256 } : {}),
            ...(row.fetchedAt !== null ? { fetched_at: row.fetchedAt.toISOString() } : {}),
            ...(conversionStatus ? {
              conversion: {
                status: conversionStatus,
                markdown_url: row.markdownUrl,
                markdown_storage_key: row.markdownStorageKey,
                markdown_sha256: row.markdownSha256,
                markdown_bytes: row.markdownBytes,
                converter: row.converter,
                converted_at: row.convertedAt?.toISOString() ?? null,
                error: row.conversionError,
              },
            } : {}),
          };
        }),
      },
    };
  });
}

function normalizedConversionStatus(value: string | null): "converted" | "skipped" | "failed" | null {
  return value === "converted" || value === "skipped" || value === "failed" ? value : null;
}

function surfaceConversionStatus(value: string | undefined): "converted" | "failed" | null {
  if (value === "preview_ready" || value === "fields_ready") return "converted";
  if (value === "failed") return "failed";
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
    agency_primary: row.agencyPrimary,
    category_l1: row.categoryL1,
    category_l2: row.categoryL2,
    apply_start: dateString(row.applyStart),
    apply_end: dateString(row.applyEnd),
    support_amount: row.supportAmount,
    benefits: (row.benefits ?? null) as unknown as NonNullable<Grant["benefits"]>,
    required_documents: (row.requiredDocuments ?? null) as unknown as NonNullable<Grant["required_documents"]>,
    status: row.status,
    f_regions: row.fRegions,
    f_industries: row.fIndustries,
    f_biz_age_min_months: row.fBizAgeMinMonths,
    f_biz_age_max_months: row.fBizAgeMaxMonths,
    f_sizes: row.fSizes,
    f_founder_traits: row.fFounderTraits,
    f_required_certs: row.fRequiredCerts,
    f_apply_methods: row.fApplyMethods as ApplyMethodChannel[],
    f_authoring_mode: row.fAuthoringMode as AuthoringMode,
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
  if (raw.attachments) {
    result.attachments = raw.attachments as NonNullable<GrantRaw<TPayload>["attachments"]>;
  }
  if (raw.rawHash) result.raw_hash = raw.rawHash;
  return result;
}

export interface CompanyProfilePersistenceCompany {
  id: string;
  kind: "active" | "preliminary";
  name: string | null;
}

export interface CompanyProfilePersistenceRow {
  dimension: CriterionDimension;
  value: Record<string, unknown>;
  source: CompanyProfilePersistenceInsert["source"];
  confidence: number;
  asOf: Date;
  userId?: string | null;
}

const PROFILE_EVIDENCE_META_KEY = "_cunote_profile_evidence";
const QUESTION_STATE_META_KEY = "_cunote_question_answer_state";
const VALUE_PRESENT_META_KEY = "_cunote_value_present";

export function decodeCompanyProfileRows(
  company: CompanyProfilePersistenceCompany,
  rows: CompanyProfilePersistenceRow[],
): CompanyProfile {
  const baseProfile: CompanyProfile = {
    id: company.id,
    is_preliminary: company.kind === "preliminary",
    confidence: {},
  };
  if (company.name) baseProfile.name = company.name;
  const updates: CompanyProfileFieldUpdate[] = [];
  const questionStates = new Map<CriterionDimension, Array<{
    state: CompanyProfileQuestionAnswerState;
    sortKey: string;
  }>>();
  const metadataOnlyEvidence = new Map<CriterionDimension, CompanyProfileFieldEvidence[]>();

  for (const row of rows) {
    const decoded = decodeCompanyProfileRowsLegacy(company, [row]);
    const evidence = decoded.profile_evidence?.[row.dimension];
    const state = decoded.question_answer_state?.[row.dimension];
    if (state) {
      const values = questionStates.get(row.dimension) ?? [];
      values.push({
        state,
        sortKey: `${state.answeredAt}|${row.asOf.toISOString()}|${stableCanonicalStringify({ state, value: row.value })}`,
      });
      questionStates.set(row.dimension, values);
    }
    if (row.value[VALUE_PRESENT_META_KEY] === false) {
      if (evidence) {
        const values = metadataOnlyEvidence.get(row.dimension) ?? [];
        values.push(evidence);
        metadataOnlyEvidence.set(row.dimension, values);
      }
      continue;
    }
    if (!evidence) continue;
    updates.push(...companyProfileToFieldUpdates(decoded, {
      scope: evidence.scope ?? (row.userId ? "user" : "shared"),
      persistenceClass: evidence.persistenceClass ?? (
        evidence.sourceKind === "self_declared"
          ? "portable_user_answer"
          : "versioned_provider_observation"
      ),
      resolverVersion: evidence.resolverVersion ?? "p1-v1",
    }));
  }

  const asOf = rows
    .map((row) => row.asOf.toISOString())
    .sort()
    .at(-1) ?? "1970-01-01T00:00:00.000Z";
  const result = assembleCompanyProfile({ baseProfile, updates, asOf }).profile;
  for (const [dimension, candidates] of metadataOnlyEvidence) {
    if (result.profile_evidence?.[dimension]) continue;
    const evidence = preferredMetadataOnlyEvidence(dimension, candidates);
    if (!evidence) continue;
    result.profile_evidence = { ...(result.profile_evidence ?? {}), [dimension]: evidence };
  }
  for (const [dimension, candidates] of questionStates) {
    const selected = [...candidates].sort((left, right) => left.sortKey.localeCompare(right.sortKey)).at(-1);
    if (!selected) continue;
    result.question_answer_state = {
      ...(result.question_answer_state ?? {}),
      [dimension]: selected.state,
    };
  }
  return result;
}

/** P0 row-order decoder retained as the N-1 rollback adapter. */
export function decodeCompanyProfileRowsLegacy(
  company: CompanyProfilePersistenceCompany,
  rows: CompanyProfilePersistenceRow[],
): CompanyProfile {
  const profile: CompanyProfile = {
    id: company.id,
    is_preliminary: company.kind === "preliminary",
    confidence: {},
  };
  if (company.name) profile.name = company.name;

  for (const row of rows) {
    const persistedValue = row.value;
    const valuePresent = persistedValue[VALUE_PRESENT_META_KEY] !== false;
    const value = withoutProfilePersistenceMetadata(persistedValue);
    const evidence = profileEvidenceFromRow(row, persistedValue, valuePresent);
    if (evidence) {
      profile.profile_evidence = {
        ...(profile.profile_evidence ?? {}),
        [row.dimension]: evidence,
      };
    }
    const questionState = parseQuestionAnswerState(persistedValue[QUESTION_STATE_META_KEY]);
    if (questionState) {
      profile.question_answer_state = {
        ...(profile.question_answer_state ?? {}),
        [row.dimension]: questionState,
      };
    }
    if (!valuePresent) continue;
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
      profile.industry_codes = stringArray(value.industry_codes ?? value.codes);
      setListCompleteness(profile, "industry", value.list_completeness);
    }
    if (row.dimension === "size") {
      profile.size = stringValue(value.size ?? value.label) ?? null;
    }
    if (row.dimension === "revenue") {
      const revenue = numberValue(value.revenue_krw ?? value.annual_revenue_krw ?? value.amount_krw);
      if (revenue !== null) profile.revenue_krw = revenue;
    }
    if (row.dimension === "employees") {
      const employees = numberValue(value.employees_count ?? value.count);
      if (employees !== null) profile.employees_count = employees;
    }
    if (row.dimension === "certification") {
      profile.certs = stringArray(value.certs ?? value.certifications);
      setListCompleteness(profile, "certification", value.list_completeness);
    }
    if (row.dimension === "founder_trait") {
      profile.traits = stringArray(value.traits);
      setListCompleteness(profile, "founder_trait", value.list_completeness);
    }
    if (row.dimension === "prior_award") {
      profile.prior_awards = stringArray(value.programs ?? value.prior_awards);
      const history = toPriorAwardProfileValue(value.prior_award_history);
      if (history) profile.prior_award_history = history;
      setListCompleteness(profile, "prior_award", value.list_completeness);
    }
    if (row.dimension === "ip") {
      profile.ip = stringArray(value.ip ?? value.types);
      setListCompleteness(profile, "ip", value.list_completeness);
    }
    if (row.dimension === "target_type") {
      profile.target_types = stringArray(value.target_types ?? value.targets);
      setListCompleteness(profile, "target_type", value.list_completeness);
    }
    if (row.dimension === "other") {
      profile.other_conditions = value;
    }
    if (row.dimension === "business_status") {
      const status: NonNullable<CompanyProfile["business_status"]> = {};
      if (typeof value.active === "boolean") status.active = value.active;
      const label = stringValue(value.label);
      if (label) status.label = label;
      const closeDownState = stringOrNumberOrNull(value.close_down_state);
      if (closeDownState !== null || value.close_down_state === null) status.close_down_state = closeDownState;
      const closeDownTaxType = stringOrNumberOrNull(value.close_down_tax_type);
      if (closeDownTaxType !== null || value.close_down_tax_type === null) status.close_down_tax_type = closeDownTaxType;
      profile.business_status = status;
    }
    // ── 결격·재무·고용·투자 축 (공고매칭 차원 확장, M3 역직렬화) ──────────────
    if (row.dimension === "tax_compliance") {
      profile.tax_compliance = toDisqualificationProfileValue(value);
    }
    if (row.dimension === "credit_status") {
      profile.credit_status = toDisqualificationProfileValue(value);
    }
    if (row.dimension === "sanction") {
      profile.sanction = toDisqualificationProfileValue(value);
    }
    if (row.dimension === "financial_health") {
      profile.financial_health = toFinancialHealthProfileValue(value);
    }
    if (row.dimension === "insured_workforce") {
      profile.insured_workforce = toInsuredWorkforceProfileValue(value);
    }
    if (row.dimension === "investment") {
      profile.investment = toInvestmentProfileValue(value);
    }
  }

  return profile;
}

function withoutProfilePersistenceMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== PROFILE_EVIDENCE_META_KEY &&
    key !== QUESTION_STATE_META_KEY &&
    key !== VALUE_PRESENT_META_KEY));
}

function profileEvidenceFromRow(
  row: CompanyProfilePersistenceRow,
  persistedValue: Record<string, unknown>,
  valuePresent: boolean,
): CompanyProfileFieldEvidence | null {
  const embedded = parseProfileEvidence(persistedValue[PROFILE_EVIDENCE_META_KEY]);
  if (embedded) return embedded;
  if (!valuePresent) return null;

  const sourceKind = legacyEvidenceSourceKind(row.source, row.dimension);
  const listDimension = row.dimension === "industry" ||
    row.dimension === "founder_trait" ||
    row.dimension === "certification" ||
    row.dimension === "prior_award" ||
    row.dimension === "ip" ||
    row.dimension === "target_type";
  return {
    sourceKind,
    provider: row.source === "self_declared" ? "legacy_company_profile" : row.source,
    asOf: row.asOf.toISOString(),
    axisCompleteness: listDimension && persistedValue.list_completeness !== "complete"
      ? "partial"
      : "complete",
    confidence: row.confidence,
  };
}

function legacyEvidenceSourceKind(
  source: CompanyProfilePersistenceRow["source"],
  dimension: CriterionDimension,
): CompanyProfileFieldEvidence["sourceKind"] {
  if (source === "self_declared") return "self_declared";
  if (source === "ocr") return "derived";
  if (source === "codef" && (dimension === "founder_age" || dimension === "founder_trait")) {
    return "auth_supplied";
  }
  return "authoritative_api";
}

function parseProfileEvidence(value: unknown): CompanyProfileFieldEvidence | null {
  const primary = parseEvidenceObservation(value);
  if (!primary) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return primary;
  const supplemental = Array.isArray((value as Record<string, unknown>).supplemental)
    ? ((value as Record<string, unknown>).supplemental as unknown[])
      .flatMap((item) => {
        const parsed = parseEvidenceObservation(item);
        return parsed ? [parsed] : [];
      })
    : [];
  return supplemental.length > 0 ? { ...primary, supplemental } : primary;
}

function parseEvidenceObservation(value: unknown): CompanyProfileEvidenceObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.sourceKind !== "authoritative_api" &&
    row.sourceKind !== "public_registry" &&
    row.sourceKind !== "auth_supplied" &&
    row.sourceKind !== "self_declared" &&
    row.sourceKind !== "derived"
  ) return null;
  const provider = stringValue(row.provider);
  if (!provider) return null;
  if (row.axisCompleteness !== "partial" && row.axisCompleteness !== "complete") return null;
  const asOf = row.asOf === null || typeof row.asOf === "string" ? row.asOf : null;
  const confidence = row.confidence === null ||
    (typeof row.confidence === "number" && Number.isFinite(row.confidence))
    ? row.confidence
    : null;
  const scope = row.scope === "shared" || row.scope === "user" ? row.scope : undefined;
  const observationId = stringValue(row.observationId) ?? undefined;
  const observationVersion = stringValue(row.observationVersion) ?? undefined;
  const canonicalValue = typeof row.canonicalValue === "string" ? row.canonicalValue : undefined;
  const persistenceClass = row.persistenceClass === "portable_user_answer" ||
      row.persistenceClass === "versioned_provider_observation"
    ? row.persistenceClass
    : undefined;
  const resolverVersion = stringValue(row.resolverVersion) ?? undefined;
  return {
    sourceKind: row.sourceKind,
    provider,
    asOf,
    axisCompleteness: row.axisCompleteness,
    confidence,
    ...(scope ? { scope } : {}),
    ...(observationId ? { observationId } : {}),
    ...(observationVersion ? { observationVersion } : {}),
    ...(canonicalValue !== undefined ? { canonicalValue } : {}),
    ...(persistenceClass ? { persistenceClass } : {}),
    ...(resolverVersion ? { resolverVersion } : {}),
  };
}

function parseQuestionAnswerState(value: unknown): CompanyProfileQuestionAnswerState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.status !== "unknown" && row.status !== "range") return null;
  if (typeof row.answeredAt !== "string" || typeof row.expiresAt !== "string") return null;
  if (row.sourceKind !== "self_declared") return null;
  if (row.rulesetVer !== null && typeof row.rulesetVer !== "string") return null;
  const state: CompanyProfileQuestionAnswerState = {
    status: row.status,
    answeredAt: row.answeredAt,
    expiresAt: row.expiresAt,
    sourceKind: "self_declared",
    rulesetVer: row.rulesetVer,
  };
  if (typeof row.min === "number" && Number.isFinite(row.min)) state.min = row.min;
  if (row.max === null || (typeof row.max === "number" && Number.isFinite(row.max))) state.max = row.max;
  if (row.unit === "krw" || row.unit === "people") state.unit = row.unit;
  return state;
}

function toDisqualificationProfileValue(
  value: Record<string, unknown>,
): NonNullable<CompanyProfile["tax_compliance"]> {
  return {
    flags: stringArray(value.flags),
    known_flags: stringArray(value.known_flags),
    exceptions: stringArray(value.exceptions),
  };
}

function toPriorAwardProfileValue(value: unknown): CompanyProfile["prior_award_history"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const records = Array.isArray(row.records) ? row.records.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (record.state !== "participating" && record.state !== "completed" && record.state !== "graduated") return [];
    const result: NonNullable<CompanyProfile["prior_award_history"]>["records"][number] = { state: record.state };
    const program = stringValue(record.program);
    if (program) result.program = program;
    const agency = stringValue(record.agency);
    if (agency) result.agency = agency;
    const year = numberValue(record.year);
    if (year !== null) result.year = year;
    else if (record.year === null) result.year = null;
    return [result];
  }) : [];
  const selfFlagsRow = row.self_flags && typeof row.self_flags === "object" && !Array.isArray(row.self_flags)
    ? row.self_flags as Record<string, unknown>
    : null;
  const selfFlags: NonNullable<CompanyProfile["prior_award_history"]>["self_flags"] = {};
  for (const key of ["current_similar", "same_project", "same_business_prior", "same_year_other_support"] as const) {
    if (typeof selfFlagsRow?.[key] === "boolean") selfFlags[key] = selfFlagsRow[key];
  }
  return {
    records,
    ...(Object.keys(selfFlags).length > 0 ? { self_flags: selfFlags } : {}),
    ...(typeof row.has_incubation_tenancy === "boolean" ? { has_incubation_tenancy: row.has_incubation_tenancy } : {}),
    known_programs: stringArray(row.known_programs),
    known_program_types: stringArray(row.known_program_types),
  };
}

function toFinancialHealthProfileValue(
  value: Record<string, unknown>,
): NonNullable<CompanyProfile["financial_health"]> {
  const result: NonNullable<CompanyProfile["financial_health"]> = {};
  const debtRatio = numberValue(value.debt_ratio_pct);
  if (debtRatio !== null) result.debt_ratio_pct = debtRatio;
  else if (value.debt_ratio_pct === null) result.debt_ratio_pct = null;
  const interestCoverage = numberValue(value.interest_coverage_ratio);
  if (interestCoverage !== null) result.interest_coverage_ratio = interestCoverage;
  else if (value.interest_coverage_ratio === null) result.interest_coverage_ratio = null;
  const impairment = stringValue(value.impairment);
  if (impairment === "none" || impairment === "partial" || impairment === "full") {
    result.impairment = impairment;
  }
  const totalAssets = numberValue(value.total_assets_krw);
  if (totalAssets !== null) result.total_assets_krw = totalAssets;
  else if (value.total_assets_krw === null) result.total_assets_krw = null;
  const equity = numberValue(value.equity_krw);
  if (equity !== null) result.equity_krw = equity;
  else if (value.equity_krw === null) result.equity_krw = null;
  const capital = numberValue(value.capital_krw);
  if (capital !== null) result.capital_krw = capital;
  else if (value.capital_krw === null) result.capital_krw = null;
  const fiscalYear = stringValue(value.fiscal_year);
  if (fiscalYear) result.fiscal_year = fiscalYear;
  return result;
}

function toInsuredWorkforceProfileValue(
  value: Record<string, unknown>,
): NonNullable<CompanyProfile["insured_workforce"]> {
  const result: NonNullable<CompanyProfile["insured_workforce"]> = {};
  if (typeof value.employment_insurance_active === "boolean") {
    result.employment_insurance_active = value.employment_insurance_active;
  }
  const insuredCount = numberValue(value.insured_count);
  if (insuredCount !== null) result.insured_count = insuredCount;
  else if (value.insured_count === null) result.insured_count = null;
  const monthsSince = numberValue(value.months_since_last_layoff);
  if (monthsSince !== null) result.months_since_last_layoff = monthsSince;
  else if (value.months_since_last_layoff === null) result.months_since_last_layoff = null;
  if (typeof value.no_layoff === "boolean") result.no_layoff = value.no_layoff;
  return result;
}

function toInvestmentProfileValue(
  value: Record<string, unknown>,
): NonNullable<CompanyProfile["investment"]> {
  const result: NonNullable<CompanyProfile["investment"]> = {};
  const totalRaised = numberValue(value.total_raised_krw);
  if (totalRaised !== null) result.total_raised_krw = totalRaised;
  else if (value.total_raised_krw === null) result.total_raised_krw = null;
  const lastRound = stringValue(value.last_round);
  if (lastRound) result.last_round = lastRound;
  else if (value.last_round === null) result.last_round = null;
  if (typeof value.tips_backed === "boolean") result.tips_backed = value.tips_backed;
  return result;
}

function companyWhere(input: { companyId?: string; bizNo?: string }) {
  if (input.companyId) return eq(schema.companies.id, input.companyId);
  if (input.bizNo) return eq(schema.companies.bizNo, input.bizNo);
  return undefined;
}

function companyProfileScopeWhere(companyId: string, userId: string | undefined) {
  const companyFilter = eq(schema.companyProfiles.companyId, companyId);
  const userFilter = userId
    ? eq(schema.companyProfiles.userId, userId)
    : isNull(schema.companyProfiles.userId);
  return and(companyFilter, userFilter);
}

export function encodeCompanyProfileRows(
  companyId: string,
  profile: CompanyProfile,
  now: Date,
  userId?: string,
): CompanyProfilePersistenceInsert[] {
  const rows: CompanyProfilePersistenceInsert[] = [];
  const pushedDimensions = new Set<CriterionDimension>();
  const push = (
    dimension: CriterionDimension,
    value: Record<string, unknown>,
    valuePresent = true,
  ) => {
    rows.push({
      companyId,
      ...(userId ? { userId } : {}),
      dimension: dimension,
      value: withProfilePersistenceMetadata(profile, dimension, value, valuePresent, now, userId),
      source: profilePersistenceSource(profile, dimension),
      confidence: valuePresent ? profileConfidence(profile, dimension) : 0,
      asOf: now,
      updatedAt: now,
    });
    pushedDimensions.add(dimension);
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
  if (profile.industries?.length || profile.industry_codes?.length) {
    push("industry", withListCompleteness(profile, "industry", {
      industries: profile.industries ?? [],
      tags: profile.industries ?? [],
      industry_codes: profile.industry_codes ?? [],
      codes: profile.industry_codes ?? [],
    }));
  }
  if (profile.size) {
    push("size", { size: profile.size, label: profile.size });
  }
  if (profile.revenue_krw !== null && profile.revenue_krw !== undefined) {
    push("revenue", { revenue_krw: profile.revenue_krw, amount_krw: profile.revenue_krw });
  }
  if (profile.employees_count !== null && profile.employees_count !== undefined) {
    push("employees", { employees_count: profile.employees_count, count: profile.employees_count });
  }
  if (Array.isArray(profile.traits)) {
    push("founder_trait", withListCompleteness(profile, "founder_trait", { traits: profile.traits }));
  }
  if (Array.isArray(profile.certs)) {
    push("certification", withListCompleteness(profile, "certification", { certs: profile.certs, certifications: profile.certs }));
  }
  if (Array.isArray(profile.prior_awards) || profile.prior_award_history) {
    push("prior_award", withListCompleteness(profile, "prior_award", {
      prior_awards: profile.prior_awards ?? [],
      programs: profile.prior_awards ?? [],
      ...(profile.prior_award_history ? { prior_award_history: profile.prior_award_history } : {}),
    }));
  }
  if (Array.isArray(profile.ip)) {
    push("ip", withListCompleteness(profile, "ip", { ip: profile.ip, types: profile.ip }));
  }
  if (profile.target_types?.length) {
    push("target_type", withListCompleteness(profile, "target_type", { target_types: profile.target_types, targets: profile.target_types }));
  }
  // ── 결격·재무·고용·투자 축 (공고매칭 차원 확장, M3 직렬화) ──────────────────
  // 이 블록이 없으면 다른 필드 저장 시 결격 답변이 silent drop으로 증발한다.
  if (profile.tax_compliance) {
    push("tax_compliance", disqualificationRowValue(profile.tax_compliance));
  }
  if (profile.credit_status) {
    push("credit_status", disqualificationRowValue(profile.credit_status));
  }
  if (profile.sanction) {
    push("sanction", disqualificationRowValue(profile.sanction));
  }
  if (profile.financial_health) {
    push("financial_health", compactRecord(profile.financial_health as Record<string, unknown>));
  }
  if (profile.insured_workforce) {
    push("insured_workforce", compactRecord(profile.insured_workforce as Record<string, unknown>));
  }
  if (profile.investment) {
    push("investment", compactRecord(profile.investment as Record<string, unknown>));
  }
  if (profile.other_conditions) {
    push("other", compactRecord(profile.other_conditions));
  }
  if (profile.business_status) {
    push("business_status", compactRecord(profile.business_status as Record<string, unknown>));
  }

  for (const dimension of CRITERION_DIMENSIONS) {
    if (pushedDimensions.has(dimension)) continue;
    if (!profile.profile_evidence?.[dimension] && !profile.question_answer_state?.[dimension]) continue;
    push(dimension, {}, false);
  }

  return rows;
}

function withProfilePersistenceMetadata(
  profile: CompanyProfile,
  dimension: CriterionDimension,
  value: Record<string, unknown>,
  valuePresent: boolean,
  now: Date,
  userId: string | undefined,
): Record<string, unknown> {
  const evidence = profile.profile_evidence?.[dimension];
  const questionState = profile.question_answer_state?.[dimension];
  const persistedEvidence = evidence
    ? versionedPersistenceEvidence(evidence, profile, dimension, valuePresent, now, userId)
    : null;
  return {
    ...value,
    ...(persistedEvidence ? { [PROFILE_EVIDENCE_META_KEY]: persistedEvidence } : {}),
    ...(questionState ? { [QUESTION_STATE_META_KEY]: questionState } : {}),
    ...(!valuePresent ? { [VALUE_PRESENT_META_KEY]: false } : {}),
  };
}

function versionedPersistenceEvidence(
  evidence: CompanyProfileFieldEvidence,
  profile: CompanyProfile,
  dimension: CriterionDimension,
  valuePresent: boolean,
  now: Date,
  userId: string | undefined,
): CompanyProfileFieldEvidence {
  const sourceKind = evidence.sourceKind;
  const scope = evidence.scope ?? (userId ? "user" : "shared");
  const persistenceClass = evidence.persistenceClass ?? (
    sourceKind === "self_declared"
      ? "portable_user_answer"
      : "versioned_provider_observation"
  );
  const resolverVersion = evidence.resolverVersion ?? "p1-v1";
  const observationVersion = evidence.observationVersion ?? "1";
  const asOf = evidence.asOf && !Number.isNaN(Date.parse(evidence.asOf))
    ? evidence.asOf
    : now.toISOString();
  const normalizedProfile = dimension === "industry"
    ? normalizeCompanyIndustryProfile(profile)
    : profile;
  const canonicalValue = valuePresent
    ? companyProfileValueForDimension(normalizedProfile, dimension)
    : undefined;
  const identity = canonicalCompanyProfileObservationIdentity({
    dimension,
    sourceKind,
    provider: evidence.provider,
    scope,
    asOf,
    value: canonicalValue,
    ...(evidence.observationId ? { observationId: evidence.observationId } : {}),
    observationVersion,
  });
  return {
    ...evidence,
    provider: identity.provider,
    asOf,
    scope,
    observationId: identity.observationId,
    observationVersion,
    canonicalValue: identity.canonicalValue,
    persistenceClass,
    resolverVersion,
  };
}

function preferredMetadataOnlyEvidence(
  dimension: CriterionDimension,
  candidates: readonly CompanyProfileFieldEvidence[],
): CompanyProfileFieldEvidence | undefined {
  const maximal = candidates.filter((candidate) => !candidates.some((other) => {
    if (other === candidate) return false;
    return resolveEvidencePrecedence({ dimension, current: candidate, incoming: other }).decision === "replace";
  }));
  return [...maximal].sort((left, right) =>
    stableCanonicalStringify(left).localeCompare(stableCanonicalStringify(right))).at(0);
}

function profilePersistenceSource(
  profile: CompanyProfile,
  dimension: CriterionDimension,
): CompanyProfilePersistenceInsert["source"] {
  if (profile.profile_evidence?.[dimension]?.sourceKind === "self_declared") return "self_declared";
  const provider = profile.profile_evidence?.[dimension]?.provider.trim().toLowerCase();
  if (provider === "popbill" || provider === "nts" || provider === "codef") return provider;
  if (provider === "ocr" || provider?.includes("ocr")) return "ocr";
  // The enum is a legacy transport column. Provider semantics remain in the
  // versioned JSON evidence above, so unsupported providers are never decoded
  // as self-declared merely because this compatibility value is required.
  return "self_declared";
}

function disqualificationRowValue(
  value: NonNullable<CompanyProfile["tax_compliance"]>,
): Record<string, unknown> {
  return {
    flags: value.flags ?? [],
    known_flags: value.known_flags ?? [],
    exceptions: value.exceptions ?? [],
  };
}

function profileConfidence(profile: CompanyProfile, dimension: CriterionDimension): number {
  const value = profile.confidence?.[dimension];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.8;
}

function setListCompleteness(
  profile: CompanyProfile,
  dimension: "industry" | "founder_trait" | "certification" | "prior_award" | "ip" | "target_type",
  value: unknown,
): void {
  if (value !== "partial" && value !== "complete") return;
  profile.list_completeness = {
    ...(profile.list_completeness ?? {}),
    [dimension]: value,
  };
}

function withListCompleteness(
  profile: CompanyProfile,
  dimension: "industry" | "founder_trait" | "certification" | "prior_award" | "ip" | "target_type",
  value: Record<string, unknown>,
): Record<string, unknown> {
  const completeness = profile.list_completeness?.[dimension];
  return completeness ? { ...value, list_completeness: completeness } : value;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function maskBizNo(value: string): string {
  try {
    return maskCorpNum(value);
  } catch {
    return "**********";
  }
}

function matchConfidence(match: MatchResult): number {
  if (match.rule_trace.length === 0) return 0;
  const unknownCount = match.rule_trace.filter((trace) => trace.result === "unknown").length;
  const ratio = 1 - unknownCount / match.rule_trace.length;
  return Math.round(Math.max(0.3, ratio) * 100) / 100;
}

function toEnrichmentCacheEntry(row: CompanyEnrichmentCacheRow): EnrichmentCacheEntry {
  const entry: EnrichmentCacheEntry = {
    provider: row.provider,
    bizNo: row.bizNo,
    scope: row.scope,
    fetchedAt: row.fetchedAt,
  };
  if (row.rawPayload !== null) entry.rawPayload = row.rawPayload;
  if (row.canonicalPayload !== null) entry.canonicalPayload = row.canonicalPayload;
  if (row.providerResultCode !== null) entry.providerResultCode = row.providerResultCode;
  if (row.providerResultMessage !== null) entry.providerResultMessage = row.providerResultMessage;
  if (row.checkedAt !== null) entry.checkedAt = row.checkedAt;
  if (row.expiresAt !== null) entry.expiresAt = row.expiresAt;
  if (row.payloadHash !== null) entry.payloadHash = row.payloadHash;
  if (row.lastError !== null) entry.lastError = row.lastError;
  return entry;
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

function feedbackTypeFor(input: SubmitFeedbackInput) {
  if (input.kind === "selected" || input.kind === "rejected" || input.kind === "blocked") return "outcome";
  if (input.outcome && input.outcome !== "pending") return "outcome";
  if (input.kind === "saved" || input.kind === "applied") return "explicit_relevant";
  if (input.kind === "dismissed" || input.kind === "wrong") return "explicit_irrelevant";
  return "implicit";
}

function feedbackValue(input: SubmitFeedbackInput): Record<string, unknown> {
  return compactRecord({
    kind: input.kind,
    companyId: input.companyId,
    grantId: input.grantId,
    userId: input.userId ?? null,
    message: input.message ?? null,
    reasonCode: input.reasonCode ?? null,
    outcome: input.outcome ?? outcomeForKind(input.kind),
    occurredAt: input.occurredAt ?? null,
    correction: input.correction ?? null,
    payload: input.payload ?? null,
    provenance: input.provenance ?? null,
  });
}

function outcomeForKind(kind: SubmitFeedbackInput["kind"]) {
  if (kind === "selected" || kind === "rejected" || kind === "blocked") return kind;
  if (kind === "applied") return "pending";
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNumberOrNull(value: unknown): string | number | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
