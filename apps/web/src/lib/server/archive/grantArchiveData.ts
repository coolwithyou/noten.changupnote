import { and, arrayOverlaps, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { ApplyMethodChannel, AuthoringMode, Grant, GrantCriterion } from "@cunote/contracts";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb } from "@/lib/server/db/client";
import { withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  listRuntimeApplicationManagementFeedback,
} from "@/lib/server/applications/applicationManagementFeedback";
import { getRepositoryAdapterName } from "@/lib/server/repositories/factory";
import { loadServiceGrants } from "@/lib/server/serviceData";
import {
  buildGrantArchiveFacets,
  buildGrantArchiveResult,
  type GrantArchiveApplicationStage,
  type GrantArchiveAttachmentSummary,
  type GrantArchiveFacets,
  type GrantArchiveQuery,
  type GrantArchiveResult,
} from "./grantArchiveSearch";

const DEFAULT_DB_CANDIDATE_LIMIT = 20_000;
const DEFAULT_AGENCY_SEARCH_LIMIT = 20;
const MAX_AGENCY_SEARCH_LIMIT = 50;

type GrantRow = typeof schema.grants.$inferSelect;
type CriterionRow = typeof schema.grantCriteria.$inferSelect;

export interface GrantAgencyOption {
  value: string;
  label: string;
  count: number;
}

export interface GrantAgencySearchResult {
  generatedAt: string;
  options: GrantAgencyOption[];
}

export async function loadGrantArchive(input: {
  access?: CompanyAccess;
  query?: GrantArchiveQuery;
  asOf?: Date;
} = {}): Promise<GrantArchiveResult> {
  const asOf = input.asOf ?? new Date();
  if (getRepositoryAdapterName() === "drizzle") {
    try {
      const entries = await loadGrantArchiveEntriesFromDb(input.access, input.query, asOf);
      return buildGrantArchiveResult(buildResultInput(entries, input.query, asOf));
    } catch (error) {
      if (process.env.NODE_ENV === "production") throw error;
      console.warn(`Grant archive DB search failed. Falling back to service grants: ${errorMessage(error)}`);
    }
  }

  const entries = await loadServiceGrants({ asOf, limit: 400 });
  return buildGrantArchiveResult(buildResultInput(entries, input.query, asOf));
}

export async function loadGrantArchiveFacets(input: {
  access?: CompanyAccess;
  query?: GrantArchiveQuery;
  asOf?: Date;
} = {}): Promise<GrantArchiveFacets> {
  const asOf = input.asOf ?? new Date();
  if (getRepositoryAdapterName() === "drizzle") {
    try {
      const entries = await loadGrantArchiveEntriesFromDb(input.access, input.query, asOf);
      return buildGrantArchiveFacets(buildFacetsInput(entries, input.query, asOf));
    } catch (error) {
      if (process.env.NODE_ENV === "production") throw error;
      console.warn(`Grant archive facet DB search failed. Falling back to service grants: ${errorMessage(error)}`);
    }
  }

  const entries = await loadServiceGrants({ asOf, limit: 400 });
  return buildGrantArchiveFacets(buildFacetsInput(entries, input.query, asOf));
}

// 주관기관명 자동완성 — grants.agency_primary 를 count 내림차순으로 집계한다.
// drizzle 어댑터에서는 DB 그룹 집계를, 비-drizzle 환경에서는 서비스 샘플 in-memory 집계로 폴백한다.
export async function searchGrantAgencies(input: {
  q?: string;
  limit?: number;
} = {}): Promise<GrantAgencySearchResult> {
  const generatedAt = new Date().toISOString();
  const q = input.q?.trim() ? input.q.trim() : undefined;
  const limit = clampAgencySearchLimit(input.limit);

  if (getRepositoryAdapterName() === "drizzle") {
    try {
      const db = getCunoteDb();
      const conditions: SQL[] = [sql`${schema.grants.agencyPrimary} is not null`];
      if (q) conditions.push(ilike(schema.grants.agencyPrimary, likePattern(q)));
      const rows = await db
        .select({
          value: schema.grants.agencyPrimary,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.grants)
        .where(and(...conditions))
        .groupBy(schema.grants.agencyPrimary)
        .orderBy(desc(sql`count(*)`), schema.grants.agencyPrimary)
        .limit(limit);
      return {
        generatedAt,
        options: rows
          .filter((row): row is { value: string; count: number } => Boolean(row.value))
          .map((row) => ({ value: row.value, label: row.value, count: row.count })),
      };
    } catch (error) {
      if (process.env.NODE_ENV === "production") throw error;
      console.warn(`Grant agency search DB query failed. Falling back to service grants: ${errorMessage(error)}`);
    }
  }

  const entries = await loadServiceGrants({ limit: 400 });
  const counts = new Map<string, number>();
  const needle = q?.toLowerCase();
  for (const entry of entries) {
    const value = entry.grant.agency_primary ?? null;
    if (!value) continue;
    if (needle && !value.toLowerCase().includes(needle)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const options = [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ko-KR"))
    .slice(0, limit);
  return { generatedAt, options };
}

function clampAgencySearchLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_AGENCY_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_AGENCY_SEARCH_LIMIT, Math.trunc(value)));
}

async function loadGrantArchiveEntriesFromDb(
  access: CompanyAccess | undefined,
  query: GrantArchiveQuery | undefined,
  asOf: Date,
) {
  const db = getCunoteDb();
  const where = buildGrantArchiveWhere(query, asOf);
  const baseQuery = db
    .select({
      grant: schema.grants,
      criterion: schema.grantCriteria,
    })
    .from(schema.grants)
    .leftJoin(schema.grantCriteria, eq(schema.grantCriteria.grantId, schema.grants.id));
  const rows = await (where ? baseQuery.where(where) : baseQuery)
    .orderBy(desc(schema.grants.updatedAt))
    .limit(dbCandidateLimit());

  const attachmentRows = await db
    .select({
      source: schema.grantAttachmentArchives.source,
      sourceId: schema.grantAttachmentArchives.sourceId,
      archivedCount: sql<number>`count(*)::int`,
      convertedCount: sql<number>`count(*) filter (where ${schema.grantAttachmentArchives.conversionStatus} = 'converted')::int`,
      failedCount: sql<number>`count(*) filter (where ${schema.grantAttachmentArchives.conversionStatus} = 'failed')::int`,
      skippedCount: sql<number>`count(*) filter (where ${schema.grantAttachmentArchives.conversionStatus} = 'skipped')::int`,
    })
    .from(schema.grantAttachmentArchives)
    .groupBy(schema.grantAttachmentArchives.source, schema.grantAttachmentArchives.sourceId);

  const attachments = new Map<string, GrantArchiveAttachmentSummary>();
  for (const row of attachmentRows) {
    attachments.set(attachmentKey(row.source, row.sourceId), {
      archivedCount: row.archivedCount,
      convertedCount: row.convertedCount,
      failedCount: row.failedCount,
      skippedCount: row.skippedCount,
    });
  }

  const grouped = new Map<string, {
    grant: GrantRow;
    criteria: CriterionRow[];
  }>();
  for (const row of rows) {
    const current = grouped.get(row.grant.id) ?? { grant: row.grant, criteria: [] };
    if (row.criterion) current.criteria.push(row.criterion);
    grouped.set(row.grant.id, current);
  }
  const stages = access ? await loadApplicationStages(access, [...grouped.keys()]) : new Map<string, GrantArchiveApplicationStage>();

  return [...grouped.values()].map((entry) => {
    const item = {
      grant: toGrant(entry.grant),
      criteria: entry.criteria.map(toCriterion),
    };
    const attachmentSummary = attachments.get(attachmentKey(entry.grant.source, entry.grant.sourceId));
    const stage = stages.get(entry.grant.id);
    return {
      ...item,
      ...(attachmentSummary ? { attachments: attachmentSummary } : {}),
      ...(stage ? { applicationStage: stage } : {}),
    };
  });
}

async function loadApplicationStages(
  access: CompanyAccess,
  grantIds: string[],
): Promise<Map<string, GrantArchiveApplicationStage>> {
  const result = new Map<string, GrantArchiveApplicationStage>();
  if (grantIds.length === 0) return result;
  mergeRuntimeStages(result, access, grantIds);
  const targetIds = grantIds.map((grantId) => `${access.companyId}:${grantId}`);
  const db = getCunoteDb();
  const rows = await withCunoteDbUser(db, access.userId, async (tx) => tx
    .select({
      targetId: schema.feedback.targetId,
      value: schema.feedback.value,
      ts: schema.feedback.ts,
    })
    .from(schema.feedback)
    .where(and(
      eq(schema.feedback.targetType, "match"),
      inArray(schema.feedback.targetId, targetIds),
    ))
    .orderBy(desc(schema.feedback.ts)));

  for (const row of rows) {
    const grantId = grantIdFromTarget(row.targetId, access.companyId);
    if (!grantId || result.has(grantId)) continue;
    const stage = applicationStageFromFeedbackKind(row.value.kind);
    if (stage) result.set(grantId, stage);
  }
  return result;
}

function mergeRuntimeStages(
  result: Map<string, GrantArchiveApplicationStage>,
  access: CompanyAccess,
  grantIds: string[],
): void {
  const snapshots = listRuntimeApplicationManagementFeedback({
    companyId: access.companyId,
    userId: access.userId,
    grantIds,
  });
  for (const [grantId, snapshot] of snapshots) {
    const stage = applicationStageFromFeedbackKind(snapshot.kind);
    if (stage) result.set(grantId, stage);
  }
}

function grantIdFromTarget(targetId: string, companyId: string): string | null {
  const prefix = `${companyId}:`;
  return targetId.startsWith(prefix) ? targetId.slice(prefix.length) : null;
}

function applicationStageFromFeedbackKind(kind: unknown): GrantArchiveApplicationStage | null {
  if (kind === "saved") return "saved";
  if (kind === "applied") return "submitted";
  if (kind === "selected") return "selected";
  if (kind === "rejected") return "rejected";
  if (kind === "blocked") return "blocked";
  if (kind === "dismissed" || kind === "wrong") return "dismissed";
  if (kind === "note") return "preparing";
  return null;
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

function toCriterion(row: CriterionRow): GrantCriterion {
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

function buildResultInput(
  entries: Parameters<typeof buildGrantArchiveResult>[0]["entries"],
  query: GrantArchiveQuery | undefined,
  asOf: Date,
): Parameters<typeof buildGrantArchiveResult>[0] {
  return query ? { entries, query, asOf } : { entries, asOf };
}

function buildFacetsInput(
  entries: Parameters<typeof buildGrantArchiveFacets>[0]["entries"],
  query: GrantArchiveQuery | undefined,
  asOf: Date,
): Parameters<typeof buildGrantArchiveFacets>[0] {
  return query ? { entries, query, asOf } : { entries, asOf };
}

function attachmentKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

function dateString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildGrantArchiveWhere(query: GrantArchiveQuery | undefined, asOf: Date): SQL | undefined {
  const conditions: SQL[] = [];
  if (!query) return undefined;

  if (query.sources?.length) conditions.push(inArray(schema.grants.source, query.sources));
  if (query.statuses?.length) conditions.push(inArray(schema.grants.status, query.statuses));
  if (query.agencyJurisdictions?.length) {
    conditions.push(inArray(schema.grants.agencyJurisdiction, query.agencyJurisdictions));
  }
  if (query.agencyOperators?.length) conditions.push(inArray(schema.grants.agencyOperator, query.agencyOperators));
  if (query.agencies?.length) conditions.push(inArray(schema.grants.agencyPrimary, query.agencies));
  if (query.categoryL1?.length) conditions.push(inArray(schema.grants.categoryL1, query.categoryL1));
  if (query.categoryL2?.length) conditions.push(inArray(schema.grants.categoryL2, query.categoryL2));
  if (query.applyMethods?.length) conditions.push(arrayOverlaps(schema.grants.fApplyMethods, query.applyMethods));
  if (query.authoringModes?.length) conditions.push(inArray(schema.grants.fAuthoringMode, query.authoringModes));
  if (query.minConfidence !== undefined) conditions.push(gte(schema.grants.overallConfidence, query.minConfidence));
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(or(
      ilike(schema.grants.title, pattern),
      ilike(schema.grants.sourceId, pattern),
      ilike(schema.grants.agencyJurisdiction, pattern),
      ilike(schema.grants.agencyOperator, pattern),
      ilike(schema.grants.agencyPrimary, pattern),
      ilike(schema.grants.categoryL1, pattern),
      ilike(schema.grants.categoryL2, pattern),
    )!);
  }

  addDateRangeCondition(conditions, schema.grants.applyStart, query.applyStartFrom, query.applyStartTo);
  addDateRangeCondition(conditions, schema.grants.applyEnd, query.applyEndFrom, query.applyEndTo);
  if (query.deadlineWithinDays !== undefined) {
    conditions.push(gte(schema.grants.applyEnd, asOf));
    conditions.push(lte(schema.grants.applyEnd, addDays(asOf, query.deadlineWithinDays)));
  }

  if (query.hasRequiredDocuments !== undefined) {
    const comparison = query.hasRequiredDocuments ? sql`>` : sql`=`;
    conditions.push(sql`jsonb_array_length(coalesce(${schema.grants.requiredDocuments}, '[]'::jsonb)) ${comparison} 0`);
  }
  if (query.needsReview !== undefined) {
    conditions.push(criteriaExists(sql`${schema.grantCriteria.needsReview} = true`, query.needsReview));
  }
  if (query.textOnly !== undefined) {
    conditions.push(criteriaExists(sql`${schema.grantCriteria.operator} = 'text_only'`, query.textOnly));
  }
  if (query.criterionFilters?.length) {
    for (const filter of query.criterionFilters) {
      const valueConditions = (filter.values ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => sql`(
          ${schema.grantCriteria.value}::text ilike ${likePattern(value)}
          or ${schema.grantCriteria.rawText} ilike ${likePattern(value)}
          or ${schema.grantCriteria.sourceSpan} ilike ${likePattern(value)}
        )`);
      const valueCondition = valueConditions.length === 0
        ? undefined
        : filter.operator === "all"
          ? and(...valueConditions)
          : or(...valueConditions);
      const criterionCondition = and(
        sql`${schema.grantCriteria.dimension} = ${filter.dimension}`,
        ...(valueCondition ? [valueCondition] : []),
      );
      if (criterionCondition) conditions.push(criteriaExists(criterionCondition, true));
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function addDateRangeCondition(
  conditions: SQL[],
  column: typeof schema.grants.applyStart | typeof schema.grants.applyEnd,
  from: string | undefined,
  to: string | undefined,
): void {
  const fromDate = parseDateBound(from);
  const toDate = parseDateBound(to);
  if (fromDate) conditions.push(gte(column, fromDate));
  if (toDate) conditions.push(lte(column, toDate));
}

function criteriaExists(condition: SQL, expected: boolean): SQL {
  const existsClause = sql`exists (
    select 1
    from ${schema.grantCriteria}
    where ${schema.grantCriteria.grantId} = ${schema.grants.id}
      and ${condition}
  )`;
  return expected ? existsClause : sql`not ${existsClause}`;
}

function parseDateBound(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function likePattern(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function dbCandidateLimit(): number {
  const value = Number(process.env.CUNOTE_GRANT_ARCHIVE_SCAN_LIMIT);
  if (Number.isInteger(value) && value >= 1) return value;
  return DEFAULT_DB_CANDIDATE_LIMIT;
}
