import { eq, sql } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { postgresUuidArray } from "@/lib/server/deep-analysis/sqlArray";
import { activeGrantApplyEndCutoff } from "@/lib/server/repositories/activeGrantFilter";
import { APPLICATION_FIELD_PARSER_PREFIX } from "./applicationFieldVersion";
import type { ApplicationPrecomputeStatus } from "./applicationPrecomputeState";

export type ApplicationPrecomputeJob = typeof schema.grantApplicationPrecomputeJobs.$inferSelect;

interface EligibleSurfaceRow extends Record<string, unknown> {
  surface_id: string;
  grant_id: string;
  source_sha256: string;
  field_count: number;
  protected_count: number;
  extraction_version: string | null;
}

export interface ApplicationPrecomputeEnqueueResult {
  eligible: number;
  enqueued: number;
  reused: number;
  protected: number;
  current: number;
  jobIds: string[];
}

/** 봉인된 공고와 연결된 preview-ready HWP/HWPX surface만 전용 큐에 멱등 등록한다. */
export async function enqueueGrantApplicationPrecomputeJobs(input: {
  db: CunoteDbSession;
  grantId: string;
  analysisVersion: string;
  deepAnalysisRunId?: string | null;
  priority?: number;
  maxAttempts?: number;
}): Promise<ApplicationPrecomputeEnqueueResult> {
  const rows = await loadEligibleSurfaces(input.db, {
    grantId: input.grantId,
    limit: 25,
  });
  return enqueueEligibleRows({ ...input, rows });
}

/** 초기 관측용 과거 backlog. write=false가 기본이며 한번에 50 surface를 넘지 않는다. */
export async function planApplicationPrecomputeBackfill(input: {
  db: CunoteDbSession;
  analysisVersion: string;
  limit?: number;
  write?: boolean;
}): Promise<ApplicationPrecomputeEnqueueResult & { targets: string[] }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const rows = await loadEligibleSurfaces(input.db, { limit });
  if (!input.write) {
    const actionable = rows.filter((row) => row.protected_count === 0 && !isCurrent(row, input.analysisVersion));
    return {
      eligible: rows.length,
      enqueued: 0,
      reused: 0,
      protected: rows.filter((row) => row.protected_count > 0).length,
      current: rows.filter((row) => isCurrent(row, input.analysisVersion)).length,
      jobIds: [],
      targets: actionable.map((row) => row.surface_id),
    };
  }
  const result = await enqueueEligibleRows({
    db: input.db,
    analysisVersion: input.analysisVersion,
    priority: -100,
    maxAttempts: 3,
    rows,
  });
  return { ...result, targets: rows.map((row) => row.surface_id) };
}

async function enqueueEligibleRows(input: {
  db: CunoteDbSession;
  analysisVersion: string;
  rows: EligibleSurfaceRow[];
  deepAnalysisRunId?: string | null;
  priority?: number;
  maxAttempts?: number;
}): Promise<ApplicationPrecomputeEnqueueResult> {
  const result: ApplicationPrecomputeEnqueueResult = {
    eligible: input.rows.length,
    enqueued: 0,
    reused: 0,
    protected: 0,
    current: 0,
    jobIds: [],
  };
  for (const row of input.rows) {
    if (row.protected_count > 0) {
      result.protected += 1;
      continue;
    }
    if (isCurrent(row, input.analysisVersion)) {
      result.current += 1;
      continue;
    }
    const [job] = await input.db.insert(schema.grantApplicationPrecomputeJobs).values({
      surfaceId: row.surface_id,
      grantId: row.grant_id,
      deepAnalysisRunId: input.deepAnalysisRunId ?? null,
      sourceSha256: row.source_sha256,
      analysisVersion: input.analysisVersion,
      priority: input.priority ?? 100,
      maxAttempts: input.maxAttempts ?? 3,
    }).onConflictDoUpdate({
      target: [
        schema.grantApplicationPrecomputeJobs.surfaceId,
        schema.grantApplicationPrecomputeJobs.sourceSha256,
        schema.grantApplicationPrecomputeJobs.analysisVersion,
      ],
      set: {
        deepAnalysisRunId: sql`coalesce(
          ${schema.grantApplicationPrecomputeJobs.deepAnalysisRunId},
          excluded.deep_analysis_run_id
        )`,
        priority: sql`greatest(${schema.grantApplicationPrecomputeJobs.priority}, excluded.priority)`,
        updatedAt: new Date(),
      },
    }).returning({
      id: schema.grantApplicationPrecomputeJobs.id,
      createdAt: schema.grantApplicationPrecomputeJobs.createdAt,
      updatedAt: schema.grantApplicationPrecomputeJobs.updatedAt,
    });
    if (!job) throw new Error(`Application precompute enqueue failed: ${row.surface_id}`);
    result.jobIds.push(job.id);
    if (job.createdAt.getTime() === job.updatedAt.getTime()) result.enqueued += 1;
    else result.reused += 1;
  }
  return result;
}

async function loadEligibleSurfaces(
  db: CunoteDbSession,
  input: { grantId?: string; limit: number },
): Promise<EligibleSurfaceRow[]> {
  const grantFilter = input.grantId ? sql`AND surface.grant_id = ${input.grantId}::uuid` : sql``;
  const activeCutoffIso = activeGrantApplyEndCutoff().toISOString();
  return db.execute<EligibleSurfaceRow>(sql`
    SELECT
      surface.id::text AS surface_id,
      surface.grant_id::text AS grant_id,
      archive.sha256 AS source_sha256,
      count(field.id)::int AS field_count,
      count(field.id) FILTER (
        WHERE field.parser_version IS NULL
          OR field.parser_version NOT LIKE ${`${APPLICATION_FIELD_PARSER_PREFIX}%`}
      )::int AS protected_count,
      surface.extraction_version
    FROM grant_application_surfaces surface
    JOIN grants grant_row ON grant_row.id = surface.grant_id
    JOIN grant_attachment_archives archive
      ON archive.source = surface.source
      AND archive.source_id = surface.source_id
      AND archive.storage_key = surface.source_attachment
    LEFT JOIN grant_document_fields field ON field.surface_id = surface.id
    WHERE grant_row.serving_state = 'visible'
      AND grant_row.status IN ('open', 'upcoming')
      AND (grant_row.apply_end IS NULL OR grant_row.apply_end >= ${activeCutoffIso}::timestamptz)
      AND surface.type = 'file_template'
      AND surface.format IN ('hwp', 'hwpx')
      AND surface.extraction_status IN ('preview_ready', 'fields_ready')
      AND archive.storage_key IS NOT NULL
      AND archive.sha256 ~ '^[0-9a-f]{64}$'
      ${grantFilter}
    GROUP BY surface.id, surface.grant_id, archive.sha256, surface.extraction_version,
      grant_row.status, grant_row.apply_end, grant_row.updated_at
    ORDER BY
      CASE WHEN surface.extraction_status = 'preview_ready' THEN 0 ELSE 1 END,
      CASE
        WHEN grant_row.status = 'open' AND grant_row.apply_end <= now() + interval '7 days' THEN 0
        WHEN grant_row.status = 'open' AND grant_row.apply_end <= now() + interval '30 days' THEN 1
        WHEN grant_row.status = 'open' THEN 2
        ELSE 3
      END,
      grant_row.apply_end ASC NULLS LAST,
      grant_row.updated_at DESC,
      surface.id
    LIMIT ${input.limit}
  `);
}

function isCurrent(row: EligibleSurfaceRow, analysisVersion: string): boolean {
  return row.field_count > 0 && row.extraction_version === analysisVersion;
}

export async function claimApplicationPrecomputeJob(input: {
  db: CunoteDbSession;
  workerId: string;
  analysisVersion: string;
  leaseSeconds: number;
  maxConcurrentJobs: number;
  claimGrantIds?: readonly string[];
  now?: Date;
}): Promise<ApplicationPrecomputeJob | null> {
  if (!input.workerId.trim()) throw new Error("workerId is required");
  if (!input.analysisVersion.trim()) throw new Error("analysisVersion is required");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 3_600) {
    throw new Error("leaseSeconds must be an integer between 30 and 3600");
  }
  if (
    !Number.isInteger(input.maxConcurrentJobs)
    || input.maxConcurrentJobs < 1
    || input.maxConcurrentJobs > 2
  ) {
    throw new Error("maxConcurrentJobs must be an integer between 1 and 2");
  }
  if (input.claimGrantIds && input.claimGrantIds.length === 0) {
    throw new Error("claimGrantIds must be omitted or contain at least one grant ID");
  }
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1_000);
  const cohortFilter = input.claimGrantIds
    ? sql`AND candidate.grant_id = ANY(${postgresUuidArray(input.claimGrantIds)})`
    : sql``;
  const claimed = await input.db.execute<{ id: string }>(sql`
    WITH claim_lock AS (
      SELECT pg_advisory_xact_lock(hashtext('cunote:application-precompute:' || ${input.analysisVersion}))
    ), capacity AS (
      SELECT count(*)::int AS active_count
      FROM grant_application_precompute_jobs, claim_lock
      WHERE analysis_version = ${input.analysisVersion}
        AND status = 'leased'
        AND lease_expires_at > ${now.toISOString()}::timestamptz
    )
    UPDATE grant_application_precompute_jobs
    SET status = 'leased', leased_at = ${now.toISOString()}::timestamptz,
        lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
        worker_id = ${input.workerId}, attempt_count = attempt_count + 1,
        started_at = coalesce(started_at, ${now.toISOString()}::timestamptz), updated_at = now()
    WHERE id = (
      SELECT candidate.id
      FROM grant_application_precompute_jobs candidate, capacity
      WHERE capacity.active_count < ${input.maxConcurrentJobs}
        AND candidate.analysis_version = ${input.analysisVersion}
        ${cohortFilter}
        AND (
          (candidate.status IN ('pending', 'retry_wait') AND candidate.available_at <= now())
          OR (candidate.status = 'leased' AND candidate.lease_expires_at <= now())
        )
        AND candidate.attempt_count < candidate.max_attempts
      ORDER BY candidate.priority DESC, candidate.available_at, candidate.created_at
      LIMIT 1
      FOR UPDATE OF candidate SKIP LOCKED
    )
    RETURNING id::text AS id
  `);
  const id = claimed[0]?.id;
  if (!id) return null;
  const [job] = await input.db.select().from(schema.grantApplicationPrecomputeJobs)
    .where(eq(schema.grantApplicationPrecomputeJobs.id, id)).limit(1);
  return job ?? null;
}

export async function completeApplicationPrecomputeJob(input: {
  db: CunoteDbSession;
  jobId: string;
  resultStatus: ApplicationPrecomputeStatus;
  artifactId: string;
  resultSummary: Record<string, unknown>;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db.update(schema.grantApplicationPrecomputeJobs).set({
    status: "succeeded",
    resultStatus: input.resultStatus,
    resultArtifactId: input.artifactId,
    resultSummary: input.resultSummary,
    requestCount: input.requestCount,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd: input.costUsd === null ? null : input.costUsd.toFixed(6),
    completedAt: now,
    leaseExpiresAt: null,
    workerId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }).where(eq(schema.grantApplicationPrecomputeJobs.id, input.jobId));
}

export async function failApplicationPrecomputeJob(input: {
  db: CunoteDbSession;
  job: ApplicationPrecomputeJob;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  blocked?: boolean;
  now?: Date;
}): Promise<"retry_wait" | "blocked" | "dead_letter"> {
  const now = input.now ?? new Date();
  const status = input.blocked
    ? "blocked"
    : input.retryable && input.job.attemptCount < input.job.maxAttempts
      ? "retry_wait"
      : "dead_letter";
  await input.db.update(schema.grantApplicationPrecomputeJobs).set({
    status,
    resultStatus: status === "retry_wait" ? null : "failed",
    availableAt: status === "retry_wait"
      ? new Date(now.getTime() + Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, input.job.attemptCount - 1)))
      : now,
    completedAt: status === "retry_wait" ? null : now,
    leaseExpiresAt: null,
    workerId: null,
    lastErrorCode: input.errorCode.slice(0, 120),
    lastErrorMessage: input.errorMessage.slice(0, 2_000),
    updatedAt: now,
  }).where(eq(schema.grantApplicationPrecomputeJobs.id, input.job.id));
  return status;
}

export async function writeApplicationPrecomputeHeartbeat(input: {
  db: CunoteDbSession;
  workerId: string;
  serviceRevision: string;
  analysisVersion: string;
  status: "idle" | "running" | "degraded" | "stopped";
  currentJobId?: string | null;
  lastErrorCode?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db.insert(schema.grantApplicationPrecomputeWorkerHeartbeats).values({
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    analysisVersion: input.analysisVersion,
    status: input.status,
    currentJobId: input.currentJobId ?? null,
    lastErrorCode: input.lastErrorCode ?? null,
    metadata: input.metadata ?? {},
    startedAt: now,
    heartbeatAt: now,
  }).onConflictDoUpdate({
    target: schema.grantApplicationPrecomputeWorkerHeartbeats.workerId,
    set: {
      serviceRevision: input.serviceRevision,
      analysisVersion: input.analysisVersion,
      status: input.status,
      currentJobId: input.currentJobId ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      metadata: input.metadata ?? {},
      heartbeatAt: now,
    },
  });
}

export async function applicationPrecomputeDailySpendUsd(
  db: CunoteDbSession,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.execute<{ spent_usd: string | number | null }>(sql`
    SELECT coalesce(sum(cost_usd), 0) AS spent_usd
    FROM grant_application_precompute_jobs
    WHERE completed_at >= (
      date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul')
      AT TIME ZONE 'Asia/Seoul'
    )
      AND completed_at < (
        date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul') + interval '1 day'
      ) AT TIME ZONE 'Asia/Seoul'
  `);
  const value = Number(rows[0]?.spent_usd ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid application precompute spend");
  return value;
}
