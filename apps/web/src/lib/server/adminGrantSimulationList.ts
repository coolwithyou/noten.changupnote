import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  resolvePromotionServingEvidence,
  type PromotionServingEvidence,
} from "./analysis-lab/promotion-serving";
import { readLatestLabRun, readLatestLabRunIndex } from "./analysis-lab/run-store";
import { getCunoteDb } from "./db/client";
import * as schema from "./db/schema";

export const ADMIN_GRANT_SIMULATION_PAGE_SIZE = 40;

export type AdminGrantSimulationStatusFilter =
  | "all"
  | "active"
  | "open"
  | "upcoming"
  | "closed"
  | "unknown";

export type AdminGrantSimulationDeepFilter =
  | "all"
  | "complete"
  | "serving"
  | "attention"
  | "not_run";

export type AdminGrantSimulationTransportFilter = "all" | "subscription" | "api";

export type AdminGrantSimulationKordocFilter =
  | "all"
  | "complete"
  | "review"
  | "pending"
  | "failed"
  | "not_run";

export type AdminGrantSimulationQuickFilter = "all" | "ready" | "not_ready" | "no_template";
export type AdminGrantSimulationAttachmentFilter = "all" | "has" | "none";

export interface AdminGrantSimulationQuery {
  q: string;
  status: AdminGrantSimulationStatusFilter;
  deep: AdminGrantSimulationDeepFilter;
  transport: AdminGrantSimulationTransportFilter;
  kordoc: AdminGrantSimulationKordocFilter;
  quick: AdminGrantSimulationQuickFilter;
  attachments: AdminGrantSimulationAttachmentFilter;
  page: number;
}

export interface AdminGrantSimulationItem {
  id: string;
  title: string;
  source: "kstartup" | "bizinfo" | "bizinfo_event";
  sourceId: string;
  agency: string | null;
  status: "upcoming" | "open" | "closed" | "unknown";
  applyEnd: Date | null;
  authoringMode: string;
  updatedAt: Date;
  surfaceCount: number;
  templateSurfaceCount: number;
  fieldsReadySurfaceCount: number;
  fieldCount: number;
  deepAnalysis: AdminGrantDeepAnalysisState;
  kordoc: AdminGrantKordocState;
  attachments: AdminGrantSimulationAttachment[];
}

export interface AdminGrantDeepAnalysisState {
  status: "complete" | "outdated" | "running" | "failed" | "blocked" | "not_run";
  transport: "subscription" | "api" | null;
  model: string | null;
  serving: boolean;
}

export interface AdminGrantKordocState {
  status: string | null;
  transport: "subscription" | "api" | null;
  model: string | null;
}

export interface AdminGrantSimulationAttachment {
  key: string;
  filename: string;
  href: string | null;
  archived: boolean;
  conversionStatus: string | null;
}

export interface AdminGrantSimulationListResult {
  items: AdminGrantSimulationItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  visibleStatusCounts: Record<"open" | "upcoming" | "closed" | "unknown", number>;
}

const STATUS_FILTERS = new Set<AdminGrantSimulationStatusFilter>([
  "all",
  "active",
  "open",
  "upcoming",
  "closed",
  "unknown",
]);

const DEEP_FILTERS = new Set<AdminGrantSimulationDeepFilter>([
  "all",
  "complete",
  "serving",
  "attention",
  "not_run",
]);
const TRANSPORT_FILTERS = new Set<AdminGrantSimulationTransportFilter>(["all", "subscription", "api"]);
const KORDOC_FILTERS = new Set<AdminGrantSimulationKordocFilter>([
  "all",
  "complete",
  "review",
  "pending",
  "failed",
  "not_run",
]);
const QUICK_FILTERS = new Set<AdminGrantSimulationQuickFilter>(["all", "ready", "not_ready", "no_template"]);
const ATTACHMENT_FILTERS = new Set<AdminGrantSimulationAttachmentFilter>(["all", "has", "none"]);

export function normalizeAdminGrantSimulationQuery(input: {
  q?: string | string[];
  status?: string | string[];
  deep?: string | string[];
  transport?: string | string[];
  kordoc?: string | string[];
  quick?: string | string[];
  attachments?: string | string[];
  page?: string | string[];
}): AdminGrantSimulationQuery {
  const q = first(input.q).trim().slice(0, 100);
  const rawStatus = first(input.status);
  const status = STATUS_FILTERS.has(rawStatus as AdminGrantSimulationStatusFilter)
    ? rawStatus as AdminGrantSimulationStatusFilter
    : "all";
  const deep = normalizeFilter(first(input.deep), DEEP_FILTERS, "all");
  const transport = normalizeFilter(first(input.transport), TRANSPORT_FILTERS, "all");
  const kordoc = normalizeFilter(first(input.kordoc), KORDOC_FILTERS, "all");
  const quick = normalizeFilter(first(input.quick), QUICK_FILTERS, "all");
  const attachments = normalizeFilter(first(input.attachments), ATTACHMENT_FILTERS, "all");
  const rawPage = Number.parseInt(first(input.page), 10);
  const page = Number.isFinite(rawPage) ? Math.min(Math.max(rawPage, 1), 10_000) : 1;
  return { q, status, deep, transport, kordoc, quick, attachments, page };
}

export function adminGrantSimulationListHref(
  query: AdminGrantSimulationQuery,
  page = query.page,
): string {
  const search = new URLSearchParams();
  if (query.q) search.set("q", query.q);
  if (query.status !== "all") search.set("status", query.status);
  if (query.deep !== "all") search.set("deep", query.deep);
  if (query.transport !== "all") search.set("transport", query.transport);
  if (query.kordoc !== "all") search.set("kordoc", query.kordoc);
  if (query.quick !== "all") search.set("quick", query.quick);
  if (query.attachments !== "all") search.set("attachments", query.attachments);
  if (page > 1) search.set("page", String(page));
  const suffix = search.toString();
  return `/internal/review/grants${suffix ? `?${suffix}` : ""}`;
}

export function adminGrantSimulationDetailHref(grantId: string): string {
  return `/grants/${encodeURIComponent(grantId)}?adminPreview=1`;
}

export function adminGrantSimulationAttachmentHref(grantId: string, attachmentId: string): string {
  return `/internal/review/api/grants/${encodeURIComponent(grantId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export async function listAdminGrantSimulationGrants(
  query: AdminGrantSimulationQuery,
): Promise<AdminGrantSimulationListResult> {
  const db = getCunoteDb();
  const needsStateSnapshot = query.deep !== "all"
    || query.transport !== "all"
    || query.kordoc !== "all";
  const stateSnapshot = needsStateSnapshot ? await readAdminGrantFilterSnapshot() : null;
  const statusFilter = query.status === "active"
    ? inArray(schema.grants.status, ["open", "upcoming", "unknown"])
    : query.status === "all"
      ? undefined
      : eq(schema.grants.status, query.status);
  const searchFilter = query.q
    ? or(
        ilike(schema.grants.title, `%${query.q}%`),
        ilike(schema.grants.agencyPrimary, `%${query.q}%`),
        ilike(schema.grants.agencyOperator, `%${query.q}%`),
        ilike(schema.grants.sourceId, `%${query.q}%`),
      )
    : undefined;
  const deepFilter = stateSnapshot ? deepStateFilter(query.deep, stateSnapshot.deepByGrant) : undefined;
  const transportFilter = stateSnapshot
    ? transportStateFilter(query.transport, stateSnapshot.deepByGrant)
    : undefined;
  const kordocFilter = stateSnapshot ? kordocStateFilter(query.kordoc, stateSnapshot.kordocByGrant) : undefined;
  const quickFilter = quickStateFilter(query.quick);
  const hasAttachment = sql<boolean>`(
    ${schema.grants.source}, ${schema.grants.sourceId}
  ) in (
    select ${schema.grantRaw.source}, ${schema.grantRaw.sourceId}
    from ${schema.grantRaw}
    where coalesce(jsonb_array_length(${schema.grantRaw.attachments}), 0) > 0
    union
    select ${schema.grantAttachmentArchives.source}, ${schema.grantAttachmentArchives.sourceId}
    from ${schema.grantAttachmentArchives}
  )`;
  const attachmentFilter = query.attachments === "has"
    ? hasAttachment
    : query.attachments === "none"
      ? sql`not (${hasAttachment})`
      : undefined;
  const where = and(
    eq(schema.grants.servingState, "visible"),
    statusFilter,
    searchFilter,
    deepFilter,
    transportFilter,
    kordocFilter,
    quickFilter,
    attachmentFilter,
  );
  const offset = (query.page - 1) * ADMIN_GRANT_SIMULATION_PAGE_SIZE;

  const [pageRows, totalRows, visibleStatusRows] = await Promise.all([
    db.select({
      id: schema.grants.id,
      title: schema.grants.title,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      agencyPrimary: schema.grants.agencyPrimary,
      agencyOperator: schema.grants.agencyOperator,
      status: schema.grants.status,
      applyEnd: schema.grants.applyEnd,
      authoringMode: schema.grants.fAuthoringMode,
      updatedAt: schema.grants.updatedAt,
      rawAttachments: schema.grantRaw.attachments,
    })
      .from(schema.grants)
      .leftJoin(schema.grantRaw, and(
        eq(schema.grantRaw.source, schema.grants.source),
        eq(schema.grantRaw.sourceId, schema.grants.sourceId),
      ))
      .where(where)
      .orderBy(
        sql`case ${schema.grants.status}
          when 'open' then 0
          when 'upcoming' then 1
          when 'unknown' then 2
          else 3
        end`,
        asc(schema.grants.applyEnd),
        desc(schema.grants.updatedAt),
      )
      .limit(ADMIN_GRANT_SIMULATION_PAGE_SIZE)
      .offset(offset),
    db.select({ value: count() }).from(schema.grants).where(where),
    db.select({ status: schema.grants.status, value: count() })
      .from(schema.grants)
      .where(eq(schema.grants.servingState, "visible"))
      .groupBy(schema.grants.status),
  ]);

  const visibleStatusCounts = {
    open: 0,
    upcoming: 0,
    closed: 0,
    unknown: 0,
  };
  for (const row of visibleStatusRows) visibleStatusCounts[row.status] = row.value;
  const total = totalRows[0]?.value ?? 0;
  const grantIds = pageRows.map((row) => row.id);
  if (grantIds.length === 0) {
    return {
      items: [],
      total,
      page: query.page,
      pageSize: ADMIN_GRANT_SIMULATION_PAGE_SIZE,
      pageCount: Math.max(1, Math.ceil(total / ADMIN_GRANT_SIMULATION_PAGE_SIZE)),
      visibleStatusCounts,
    };
  }
  const [fieldRows, surfaceRows, attachmentRows, pageStateRows] = await Promise.all([
    db.select({ grantId: schema.grantDocumentFields.grantId, value: count() })
      .from(schema.grantDocumentFields)
      .where(inArray(schema.grantDocumentFields.grantId, grantIds))
      .groupBy(schema.grantDocumentFields.grantId),
    db.select({
      grantId: schema.grantApplicationSurfaces.grantId,
      value: count(),
      templateCount: sql<number>`count(*) filter (
        where ${schema.grantApplicationSurfaces.type} = 'file_template'
      )::int`,
      fieldsReady: sql<number>`count(*) filter (
        where ${schema.grantApplicationSurfaces.extractionStatus} = 'fields_ready'
      )::int`,
    })
      .from(schema.grantApplicationSurfaces)
      .where(inArray(schema.grantApplicationSurfaces.grantId, grantIds))
      .groupBy(schema.grantApplicationSurfaces.grantId),
    db.select({
      grantId: schema.grants.id,
      id: schema.grantAttachmentArchives.id,
      filename: schema.grantAttachmentArchives.filename,
      sourceUri: schema.grantAttachmentArchives.sourceUri,
      archiveUrl: schema.grantAttachmentArchives.archiveUrl,
      storageKey: schema.grantAttachmentArchives.storageKey,
      conversionStatus: schema.grantAttachmentArchives.conversionStatus,
    })
      .from(schema.grants)
      .innerJoin(schema.grantAttachmentArchives, and(
        eq(schema.grantAttachmentArchives.source, schema.grants.source),
        eq(schema.grantAttachmentArchives.sourceId, schema.grants.sourceId),
      ))
      .where(inArray(schema.grants.id, grantIds))
      .orderBy(asc(schema.grantAttachmentArchives.filename)),
    stateSnapshot
      ? Promise.resolve(null)
      : Promise.all([
          db.select({
            grantId: schema.grantApplicationPrecomputeJobs.grantId,
            surfaceId: schema.grantApplicationPrecomputeJobs.surfaceId,
            status: schema.grantApplicationPrecomputeJobs.status,
            resultStatus: schema.grantApplicationPrecomputeJobs.resultStatus,
            resultSummary: schema.grantApplicationPrecomputeJobs.resultSummary,
            completedAt: schema.grantApplicationPrecomputeJobs.completedAt,
            createdAt: schema.grantApplicationPrecomputeJobs.createdAt,
          })
            .from(schema.grantApplicationPrecomputeJobs)
            .where(inArray(schema.grantApplicationPrecomputeJobs.grantId, grantIds))
            .orderBy(
              desc(schema.grantApplicationPrecomputeJobs.completedAt),
              desc(schema.grantApplicationPrecomputeJobs.createdAt),
            ),
          db.select({
            id: schema.grantDeepAnalysisRuns.id,
            grantId: schema.grantDeepAnalysisRuns.grantId,
            status: schema.grantDeepAnalysisRuns.status,
            model: schema.grantDeepAnalysisRuns.model,
            startedAt: schema.grantDeepAnalysisRuns.startedAt,
          })
            .from(schema.grantDeepAnalysisRuns)
            .where(inArray(schema.grantDeepAnalysisRuns.grantId, grantIds))
            .orderBy(desc(schema.grantDeepAnalysisRuns.startedAt)),
          db.select({
            grantId: schema.analysisLabPromotionItems.grantId,
            runId: schema.analysisLabPromotionItems.runId,
            planSha256: schema.analysisLabPromotionItems.planSha256,
            deepAnalysisRunId: schema.analysisLabPromotionItems.deepAnalysisRunId,
            releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
            manifest: schema.analysisLabPromotionReleases.manifest,
            appliedAt: schema.analysisLabPromotionItems.appliedAt,
          })
            .from(schema.analysisLabPromotionItems)
            .innerJoin(
              schema.analysisLabPromotionReleases,
              eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id),
            )
            .where(and(
              inArray(schema.analysisLabPromotionItems.grantId, grantIds),
              eq(schema.analysisLabPromotionItems.status, "applied"),
              isNull(schema.analysisLabPromotionItems.rolledBackAt),
            ))
            .orderBy(desc(schema.analysisLabPromotionItems.appliedAt)),
          Promise.all(pageRows.map(async (row) => ({
            grantId: row.id,
            run: await readLatestLabRun(row.source, row.sourceId),
          }))),
        ]),
  ]);

  const fieldCountByGrant = new Map(fieldRows.map((row) => [row.grantId, row.value]));
  const surfaceByGrant = new Map(surfaceRows.map((row) => [row.grantId, row]));
  const deepByGrant = new Map(stateSnapshot?.deepByGrant);
  const kordocByGrant = new Map(stateSnapshot?.kordocByGrant);
  if (pageStateRows) {
    const [jobRows, deepRunRows, promotionRows, localRunRows] = pageStateRows;
    const jobsByGrant = new Map<string, typeof jobRows>();
    for (const row of jobRows) {
      const rows = jobsByGrant.get(row.grantId) ?? [];
      rows.push(row);
      jobsByGrant.set(row.grantId, rows);
    }
    const deepRunById = new Map(deepRunRows.map((row) => [row.id, row]));
    const latestDeepRunByGrant = new Map<string, (typeof deepRunRows)[number]>();
    for (const row of deepRunRows) {
      if (!latestDeepRunByGrant.has(row.grantId)) latestDeepRunByGrant.set(row.grantId, row);
    }
    const promotionByGrant = new Map<string, PromotionServingEvidence>();
    for (const row of promotionRows) {
      if (promotionByGrant.has(row.grantId)) continue;
      const evidence = resolvePromotionServingEvidence(row);
      if (evidence) promotionByGrant.set(row.grantId, evidence);
    }
    const localRunByGrant = new Map(localRunRows.map((row) => [row.grantId, row.run]));
    for (const row of pageRows) {
      deepByGrant.set(row.id, resolveDeepAnalysisState({
        localRun: localRunByGrant.get(row.id) ?? null,
        servingEvidence: promotionByGrant.get(row.id) ?? null,
        latestDbRun: latestDeepRunByGrant.get(row.id) ?? null,
        deepRunById,
      }));
      kordocByGrant.set(
        row.id,
        resolveKordocState(localRunByGrant.get(row.id) ?? null, jobsByGrant.get(row.id) ?? []),
      );
    }
  }
  const archivesByGrant = new Map<string, typeof attachmentRows>();
  for (const row of attachmentRows) {
    const rows = archivesByGrant.get(row.grantId) ?? [];
    rows.push(row);
    archivesByGrant.set(row.grantId, rows);
  }

  return {
    items: pageRows.map((row) => {
      const surfaces = surfaceByGrant.get(row.id);
      return {
        id: row.id,
        title: row.title,
        source: row.source,
        sourceId: row.sourceId,
        agency: row.agencyPrimary ?? row.agencyOperator,
        status: row.status,
        applyEnd: row.applyEnd,
        authoringMode: row.authoringMode,
        updatedAt: row.updatedAt,
        surfaceCount: surfaces?.value ?? 0,
        templateSurfaceCount: surfaces?.templateCount ?? 0,
        fieldsReadySurfaceCount: surfaces?.fieldsReady ?? 0,
        fieldCount: fieldCountByGrant.get(row.id) ?? 0,
        deepAnalysis: deepByGrant.get(row.id)
          ?? { status: "not_run", transport: null, model: null, serving: false },
        kordoc: kordocByGrant.get(row.id)
          ?? { status: null, transport: null, model: null },
        attachments: mergeGrantAttachments(
          row.id,
          row.rawAttachments,
          archivesByGrant.get(row.id) ?? [],
        ),
      };
    }),
    total,
    page: query.page,
    pageSize: ADMIN_GRANT_SIMULATION_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_GRANT_SIMULATION_PAGE_SIZE)),
    visibleStatusCounts,
  };
}

interface AdminGrantFilterSnapshot {
  deepByGrant: Map<string, AdminGrantDeepAnalysisState>;
  kordocByGrant: Map<string, AdminGrantKordocState>;
}

const ADMIN_GRANT_FILTER_SNAPSHOT_TTL_MS = 15_000;
let filterSnapshotCache: { expiresAt: number; value: AdminGrantFilterSnapshot } | null = null;
let filterSnapshotPromise: Promise<AdminGrantFilterSnapshot> | null = null;

async function readAdminGrantFilterSnapshot(): Promise<AdminGrantFilterSnapshot> {
  const now = Date.now();
  if (filterSnapshotCache && filterSnapshotCache.expiresAt > now) return filterSnapshotCache.value;
  if (filterSnapshotPromise) return filterSnapshotPromise;
  filterSnapshotPromise = buildAdminGrantFilterSnapshot();
  try {
    const value = await filterSnapshotPromise;
    filterSnapshotCache = { expiresAt: now + ADMIN_GRANT_FILTER_SNAPSHOT_TTL_MS, value };
    return value;
  } finally {
    filterSnapshotPromise = null;
  }
}

async function buildAdminGrantFilterSnapshot(): Promise<AdminGrantFilterSnapshot> {
  const db = getCunoteDb();
  const [localRunByGrant, deepRows, promotionRows, jobRows] = await Promise.all([
    readLatestLabRunIndex(),
    db.select({
      id: schema.grantDeepAnalysisRuns.id,
      grantId: schema.grantDeepAnalysisRuns.grantId,
      status: schema.grantDeepAnalysisRuns.status,
      model: schema.grantDeepAnalysisRuns.model,
      startedAt: schema.grantDeepAnalysisRuns.startedAt,
    })
      .from(schema.grantDeepAnalysisRuns)
      .orderBy(desc(schema.grantDeepAnalysisRuns.startedAt)),
    db.select({
      grantId: schema.analysisLabPromotionItems.grantId,
      runId: schema.analysisLabPromotionItems.runId,
      planSha256: schema.analysisLabPromotionItems.planSha256,
      deepAnalysisRunId: schema.analysisLabPromotionItems.deepAnalysisRunId,
      releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
      manifest: schema.analysisLabPromotionReleases.manifest,
      appliedAt: schema.analysisLabPromotionItems.appliedAt,
    })
      .from(schema.analysisLabPromotionItems)
      .innerJoin(
        schema.analysisLabPromotionReleases,
        eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id),
      )
      .where(and(
        eq(schema.analysisLabPromotionItems.status, "applied"),
        isNull(schema.analysisLabPromotionItems.rolledBackAt),
      ))
      .orderBy(desc(schema.analysisLabPromotionItems.appliedAt)),
    db.select({
      grantId: schema.grantApplicationPrecomputeJobs.grantId,
      surfaceId: schema.grantApplicationPrecomputeJobs.surfaceId,
      status: schema.grantApplicationPrecomputeJobs.status,
      resultStatus: schema.grantApplicationPrecomputeJobs.resultStatus,
      resultSummary: schema.grantApplicationPrecomputeJobs.resultSummary,
      completedAt: schema.grantApplicationPrecomputeJobs.completedAt,
      createdAt: schema.grantApplicationPrecomputeJobs.createdAt,
    })
      .from(schema.grantApplicationPrecomputeJobs)
      .orderBy(
        desc(schema.grantApplicationPrecomputeJobs.completedAt),
        desc(schema.grantApplicationPrecomputeJobs.createdAt),
      ),
  ]);

  const deepRunById = new Map(deepRows.map((row) => [row.id, row]));
  const latestDeepRunByGrant = new Map<string, (typeof deepRows)[number]>();
  for (const row of deepRows) {
    if (!latestDeepRunByGrant.has(row.grantId)) latestDeepRunByGrant.set(row.grantId, row);
  }
  const promotionByGrant = new Map<string, PromotionServingEvidence>();
  for (const row of promotionRows) {
    if (promotionByGrant.has(row.grantId)) continue;
    const evidence = resolvePromotionServingEvidence(row);
    if (evidence) promotionByGrant.set(row.grantId, evidence);
  }

  const deepGrantIds = new Set([
    ...localRunByGrant.keys(),
    ...latestDeepRunByGrant.keys(),
    ...promotionByGrant.keys(),
  ]);
  const deepByGrant = new Map<string, AdminGrantDeepAnalysisState>();
  for (const grantId of deepGrantIds) {
    deepByGrant.set(grantId, resolveDeepAnalysisState({
      localRun: localRunByGrant.get(grantId) ?? null,
      servingEvidence: promotionByGrant.get(grantId) ?? null,
      latestDbRun: latestDeepRunByGrant.get(grantId) ?? null,
      deepRunById,
    }));
  }

  const jobsByGrant = new Map<string, typeof jobRows>();
  for (const row of jobRows) {
    const rows = jobsByGrant.get(row.grantId) ?? [];
    rows.push(row);
    jobsByGrant.set(row.grantId, rows);
  }
  const kordocGrantIds = new Set([
    ...jobsByGrant.keys(),
    ...[...localRunByGrant.entries()]
      .filter(([, run]) => Boolean(run.applicationRoundtrip))
      .map(([grantId]) => grantId),
  ]);
  const kordocByGrant = new Map<string, AdminGrantKordocState>();
  for (const grantId of kordocGrantIds) {
    kordocByGrant.set(
      grantId,
      resolveKordocState(localRunByGrant.get(grantId) ?? null, jobsByGrant.get(grantId) ?? []),
    );
  }

  return { deepByGrant, kordocByGrant };
}

function deepStateFilter(
  filter: AdminGrantSimulationDeepFilter,
  states: ReadonlyMap<string, AdminGrantDeepAnalysisState>,
) {
  if (filter === "all") return undefined;
  if (filter === "not_run") return excludeIds([...states.keys()]);
  return includeIds([...states.entries()]
    .filter(([, state]) => filter === "complete"
      ? state.status === "complete"
      : filter === "serving"
        ? state.serving
        : state.status === "outdated"
          || state.status === "running"
          || state.status === "failed"
          || state.status === "blocked")
    .map(([grantId]) => grantId));
}

function transportStateFilter(
  filter: AdminGrantSimulationTransportFilter,
  states: ReadonlyMap<string, AdminGrantDeepAnalysisState>,
) {
  if (filter === "all") return undefined;
  return includeIds([...states.entries()]
    .filter(([, state]) => state.transport === filter)
    .map(([grantId]) => grantId));
}

function kordocStateFilter(
  filter: AdminGrantSimulationKordocFilter,
  states: ReadonlyMap<string, AdminGrantKordocState>,
) {
  if (filter === "all") return undefined;
  if (filter === "not_run") return excludeIds([...states.keys()]);
  return includeIds([...states.entries()]
    .filter(([, state]) => filter === "complete"
      ? state.status === "complete"
      : filter === "review"
        ? state.status === "partial" || state.status === "review_required"
        : filter === "pending"
          ? state.status === "pending" || state.status === "running"
          : state.status === "failed" || state.status === "blocked")
    .map(([grantId]) => grantId));
}

function quickStateFilter(filter: AdminGrantSimulationQuickFilter) {
  if (filter === "all") return undefined;
  const ready = sql<boolean>`(
    exists (
      select 1 from ${schema.grantApplicationSurfaces}
      where ${schema.grantApplicationSurfaces.grantId} = ${schema.grants.id}
        and ${schema.grantApplicationSurfaces.extractionStatus} = 'fields_ready'
    ) and exists (
      select 1 from ${schema.grantDocumentFields}
      where ${schema.grantDocumentFields.grantId} = ${schema.grants.id}
    )
  )`;
  if (filter === "ready") return ready;
  if (filter === "not_ready") return sql`not (${ready})`;
  return sql`not exists (
    select 1 from ${schema.grantApplicationSurfaces}
    where ${schema.grantApplicationSurfaces.grantId} = ${schema.grants.id}
      and ${schema.grantApplicationSurfaces.type} = 'file_template'
  )`;
}

function includeIds(ids: string[]) {
  return ids.length > 0 ? inArray(schema.grants.id, ids) : sql`false`;
}

function excludeIds(ids: string[]) {
  return ids.length > 0 ? notInArray(schema.grants.id, ids) : undefined;
}

interface DeepAnalysisDbRun {
  id: string;
  status: string;
  model: string;
}

export function resolveDeepAnalysisState(input: {
  localRun: Pick<LabRun, "error" | "model" | "promptVersion" | "transport"> | null;
  servingEvidence: PromotionServingEvidence | null;
  latestDbRun: DeepAnalysisDbRun | null;
  deepRunById: ReadonlyMap<string, DeepAnalysisDbRun>;
}): AdminGrantDeepAnalysisState {
  if (input.servingEvidence?.kind === "verified_local_lab") {
    return {
      status: "complete",
      transport: "subscription",
      model: input.servingEvidence.evidence.model,
      serving: true,
    };
  }
  if (input.servingEvidence?.kind === "production_deep_run") {
    return {
      status: "complete",
      transport: "api",
      model: input.deepRunById.get(input.servingEvidence.deepAnalysisRunId)?.model ?? null,
      serving: true,
    };
  }
  if (input.localRun) {
    return {
      status: input.localRun.error
        ? "failed"
        : input.localRun.promptVersion === ANALYSIS_LAB_PROMPT_VERSION
          ? "complete"
          : "outdated",
      transport: input.localRun.transport === "claude-cli" ? "subscription" : "api",
      model: input.localRun.model,
      serving: false,
    };
  }
  const dbRun = input.latestDbRun;
  if (!dbRun) return { status: "not_run", transport: null, model: null, serving: false };
  return {
    status: deepAnalysisDbStatus(dbRun.status),
    transport: "api",
    model: dbRun.model,
    serving: false,
  };
}

function resolveKordocState(
  localRun: LabRun | null,
  rows: Array<{
    surfaceId: string;
    status: string;
    resultStatus: string | null;
    resultSummary: Record<string, unknown>;
  }>,
): AdminGrantKordocState {
  const local = localRun?.applicationRoundtrip;
  if (local) {
    return {
      status: local.status,
      transport: local.transport === "claude-cli" ? "subscription" : "api",
      model: local.model,
    };
  }
  if (rows.length === 0) return { status: null, transport: null, model: null };

  const latestBySurface = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestBySurface.has(row.surfaceId)) latestBySurface.set(row.surfaceId, row);
  }
  const latest = [...latestBySurface.values()];
  const status = aggregateKordocStatus(latest);
  const summary = latest.find((row) => readString(row.resultSummary.transport))?.resultSummary;
  const transport = readString(summary?.transport) === "claude-cli" ? "subscription" : "api";
  return {
    status,
    transport,
    model: readString(summary?.model),
  };
}

function aggregateKordocStatus(rows: Array<{ status: string; resultStatus: string | null }>): string {
  if (rows.some((row) => row.status === "leased")) return "running";
  if (rows.some((row) => row.status === "pending" || row.status === "retry_wait")) return "pending";
  if (rows.some((row) => row.status === "blocked")) return "blocked";
  if (rows.some((row) => row.status === "dead_letter" || row.status === "canceled")) return "failed";
  const results = rows.map((row) => row.resultStatus);
  if (results.every((status) => status === "complete")) return "complete";
  if (results.every((status) => status === "not_applicable")) return "not_applicable";
  if (results.some((status) => status === "review_required")) return "review_required";
  if (results.some((status) => status === "failed")) return "failed";
  return "partial";
}

function mergeGrantAttachments(
  grantId: string,
  rawAttachments: Array<Record<string, unknown>> | null,
  archives: Array<{
    id: string;
    filename: string;
    sourceUri: string;
    archiveUrl: string | null;
    storageKey: string | null;
    conversionStatus: string | null;
  }>,
): AdminGrantSimulationAttachment[] {
  const archiveQueues = new Map<string, typeof archives>();
  for (const archive of archives) {
    const key = attachmentFilenameKey(archive.filename);
    const queue = archiveQueues.get(key) ?? [];
    queue.push(archive);
    archiveQueues.set(key, queue);
  }

  const result: AdminGrantSimulationAttachment[] = [];
  for (const [index, raw] of (rawAttachments ?? []).entries()) {
    const filename = readString(raw.filename) ?? `첨부파일 ${index + 1}`;
    const archive = archiveQueues.get(attachmentFilenameKey(filename))?.shift();
    if (archive) {
      result.push(archiveAttachment(grantId, archive));
      continue;
    }
    result.push({
      key: `raw-${index}-${filename}`,
      filename,
      href: safeHttpUrl(readString(raw.source_uri) ?? readString(raw.url)),
      archived: false,
      conversionStatus: readString((raw.conversion as Record<string, unknown> | undefined)?.status),
    });
  }
  for (const queue of archiveQueues.values()) {
    for (const archive of queue) result.push(archiveAttachment(grantId, archive));
  }
  return result;
}

function archiveAttachment(
  grantId: string,
  archive: {
    id: string;
    filename: string;
    sourceUri: string;
    archiveUrl: string | null;
    storageKey: string | null;
    conversionStatus: string | null;
  },
): AdminGrantSimulationAttachment {
  return {
    key: archive.id,
    filename: archive.filename,
    href: archive.storageKey
      ? adminGrantSimulationAttachmentHref(grantId, archive.id)
      : safeHttpUrl(archive.sourceUri || archive.archiveUrl),
    archived: Boolean(archive.storageKey),
    conversionStatus: archive.conversionStatus,
  };
}

function deepAnalysisDbStatus(status: string): AdminGrantDeepAnalysisState["status"] {
  if (status === "passed") return "complete";
  if (status === "running") return "running";
  if (status === "blocked") return "blocked";
  if (status === "stale" || status === "legacy_imported") return "outdated";
  return "failed";
}

function attachmentFilenameKey(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function normalizeFilter<T extends string>(value: string, allowed: ReadonlySet<T>, fallback: T): T {
  return allowed.has(value as T) ? value as T : fallback;
}
