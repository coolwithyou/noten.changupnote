import { and, asc, count, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Grant, LandingGrantBanner, LandingGrantData, LandingGrantStats, NormalizedGrant } from "@cunote/contracts";
import { daysUntil, deriveGrantBenefits, supportAmountMax } from "@cunote/core";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { loadServiceGrants, type LoadServiceGrantsOptions } from "@/lib/server/serviceData";
import { activeGrantApplyEndCutoff } from "@/lib/server/repositories/activeGrantFilter";
import { getRepositoryAdapterName } from "@/lib/server/repositories/factory";

const LANDING_BANNER_LIMIT = 8;
const ACTIVE_GRANT_AGGREGATE_LIMIT = 5_000;

type LandingGrantPayload = unknown;

export async function loadLandingGrantData({
  asOf = new Date(),
}: Pick<LoadServiceGrantsOptions, "asOf"> = {}): Promise<LandingGrantData> {
  await loadEnvInDevelopment();

  if (getRepositoryAdapterName() === "drizzle") {
    try {
      return await loadLandingGrantDataFromDb(asOf);
    } catch (error) {
      if (process.env.NODE_ENV === "production") throw error;
      console.warn(`Landing grant DB aggregate failed. Falling back to service grants: ${errorMessage(error)}`);
    }
  }

  const grants = await loadServiceGrants({ asOf, limit: 40 });
  return buildLandingGrantDataFromEntries(grants, asOf);
}

async function loadLandingGrantDataFromDb(asOf: Date): Promise<LandingGrantData> {
  const db = getCunoteDb();
  const activeWhere = activeGrantWhere(asOf);

  const [totalRow] = await db.select({ value: count() }).from(schema.grants);
  const sourceRows = await db
    .select({ source: schema.grants.source, value: count() })
    .from(schema.grants)
    .groupBy(schema.grants.source);
  const [attachmentRow] = await db
    .select({
      archived: count(),
      markdown: sql<number>`count(*) filter (where ${schema.grantAttachmentArchives.markdownUrl} is not null)::int`,
    })
    .from(schema.grantAttachmentArchives);
  const cursorRows = await db
    .select({ lastCollectedAt: schema.sourceCursor.lastCollectedAt })
    .from(schema.sourceCursor);

  const activeRows = await db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      url: schema.grants.url,
      agencyJurisdiction: schema.grants.agencyJurisdiction,
      agencyOperator: schema.grants.agencyOperator,
      categoryL1: schema.grants.categoryL1,
      categoryL2: schema.grants.categoryL2,
      applyEnd: schema.grants.applyEnd,
      status: schema.grants.status,
      fRegions: schema.grants.fRegions,
      supportAmount: schema.grants.supportAmount,
      updatedAt: schema.grants.updatedAt,
    })
    .from(schema.grants)
    .where(activeWhere)
    .orderBy(
      sql`case ${schema.grants.status} when 'open' then 0 when 'upcoming' then 1 else 2 end`,
      sql`case when ${schema.grants.applyEnd} is null then 1 else 0 end`,
      asc(schema.grants.applyEnd),
      desc(schema.grants.updatedAt),
    )
    .limit(ACTIVE_GRANT_AGGREGATE_LIMIT);

  const activeEntries = activeRows.map((row) => ({
    grant: {
      id: row.id,
      source: row.source,
      source_id: row.sourceId,
      title: row.title,
      url: row.url,
      agency_jurisdiction: row.agencyJurisdiction,
      agency_operator: row.agencyOperator,
      category_l1: row.categoryL1,
      category_l2: row.categoryL2,
      apply_start: null,
      apply_end: dateString(row.applyEnd),
      apply_method: {},
      support_amount: row.supportAmount,
      required_documents: null,
      status: row.status,
      f_regions: row.fRegions,
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0,
      parser_version: "landing-db-aggregate",
    } satisfies Grant,
  }));

  const latestCollectedAt = latestDate(cursorRows.map((row) => row.lastCollectedAt));
  const stats = buildLandingStats({
    grants: activeEntries,
    asOf,
    totalCount: totalRow?.value ?? activeRows.length,
    sourceCount: sourceRows.length,
    archivedAttachmentCount: attachmentRow?.archived ?? 0,
    markdownAttachmentCount: attachmentRow?.markdown ?? 0,
    updatedAt: latestCollectedAt?.toISOString() ?? asOf.toISOString(),
  });

  return {
    stats,
    banners: activeEntries.slice(0, LANDING_BANNER_LIMIT).map((entry) => toLandingBanner(entry, asOf)),
  };
}

function buildLandingGrantDataFromEntries(
  grants: Array<NormalizedGrant<LandingGrantPayload>>,
  asOf: Date,
): LandingGrantData {
  const stats = buildLandingStats({
    grants,
    asOf,
    totalCount: grants.length,
    sourceCount: new Set(grants.map((entry) => entry.grant.source)).size,
    archivedAttachmentCount: 0,
    markdownAttachmentCount: 0,
    updatedAt: asOf.toISOString(),
  });

  return {
    stats,
    banners: grants.slice(0, LANDING_BANNER_LIMIT).map((entry) => toLandingBanner(entry, asOf)),
  };
}

function buildLandingStats(input: {
  grants: Array<{ grant: Grant }>;
  asOf: Date;
  totalCount: number;
  sourceCount: number;
  archivedAttachmentCount: number;
  markdownAttachmentCount: number;
  updatedAt: string;
}): LandingGrantStats {
  const openGrants = input.grants.filter((entry) => entry.grant.status === "open");
  const upcomingGrants = input.grants.filter((entry) => entry.grant.status === "upcoming");
  const unknownGrants = input.grants.filter((entry) => entry.grant.status === "unknown");
  const deadlineSoonCount = openGrants.filter((entry) => {
    const dDay = daysUntil(entry.grant.apply_end ?? null, input.asOf);
    return dDay !== null && dDay >= 0 && dDay <= 7;
  }).length;

  return {
    totalCount: input.totalCount,
    activeCount: input.grants.length,
    openCount: openGrants.length,
    upcomingCount: upcomingGrants.length,
    unknownCount: unknownGrants.length,
    deadlineSoonCount,
    totalAmount: openGrants.reduce((sum, entry) => sum + supportAmountMax(entry.grant.support_amount), 0),
    sourceCount: input.sourceCount,
    archivedAttachmentCount: input.archivedAttachmentCount,
    markdownAttachmentCount: input.markdownAttachmentCount,
    updatedAt: input.updatedAt,
  };
}

function toLandingBanner(entry: { grant: Grant }, asOf: Date): LandingGrantBanner {
  const { grant } = entry;
  return {
    grantId: grant.id ?? `${grant.source}:${grant.source_id}`,
    source: grant.source,
    sourceId: grant.source_id,
    title: grant.title,
    agency: grant.agency_operator ?? grant.agency_jurisdiction ?? null,
    category: [grant.category_l1, grant.category_l2].filter(Boolean).join(" / ") || null,
    status: grant.status,
    applyEnd: grant.apply_end ?? null,
    dDay: daysUntil(grant.apply_end ?? null, asOf),
    supportAmountMax: supportAmountMax(grant.support_amount),
    benefits: deriveGrantBenefits(grant),
    regions: grant.f_regions,
    url: grant.url ?? null,
  };
}

function activeGrantWhere(asOf: Date) {
  const applyEndWhere = or(
    isNull(schema.grants.applyEnd),
    gte(schema.grants.applyEnd, activeGrantApplyEndCutoff(asOf)),
  );

  return or(
    and(eq(schema.grants.status, "open"), applyEndWhere),
    and(eq(schema.grants.status, "upcoming"), applyEndWhere),
    and(eq(schema.grants.status, "unknown"), applyEndWhere),
  );
}

function latestDate(values: Array<Date | null>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    if (!latest || value.getTime() > latest.getTime()) return value;
    return latest;
  }, null);
}

function dateString(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

async function loadEnvInDevelopment() {
  if (process.env.NODE_ENV !== "production") {
    const { loadMonorepoEnv } = await import("../loadMonorepoEnv");
    loadMonorepoEnv();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "unknown error";
}
