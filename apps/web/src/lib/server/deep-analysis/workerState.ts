import { eq, sql } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { retryAvailableAt, type DeepAnalysisFailureClass } from "./workerPolicy";

export type DeepAnalysisWorkerHeartbeatStatus = "idle" | "running" | "degraded" | "stopped";

export async function writeDeepAnalysisWorkerHeartbeat(
  db: CunoteDbSession,
  input: {
    workerId: string;
    serviceRevision: string;
    modelPolicyVersion: string;
    status: DeepAnalysisWorkerHeartbeatStatus;
    currentJobId?: string | null;
    lastErrorCode?: string | null;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.insert(schema.grantDeepAnalysisWorkerHeartbeats).values({
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    modelPolicyVersion: input.modelPolicyVersion,
    status: input.status,
    currentJobId: input.currentJobId ?? null,
    lastErrorCode: input.lastErrorCode ?? null,
    metadata: input.metadata ?? {},
    startedAt: now,
    heartbeatAt: now,
  }).onConflictDoUpdate({
    target: schema.grantDeepAnalysisWorkerHeartbeats.workerId,
    set: {
      serviceRevision: input.serviceRevision,
      modelPolicyVersion: input.modelPolicyVersion,
      status: input.status,
      currentJobId: input.currentJobId ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      metadata: input.metadata ?? {},
      heartbeatAt: now,
    },
  });
}

export async function deepAnalysisDailySpendUsd(
  db: CunoteDbSession,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.execute<{ spent_usd: string | number | null }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS spent_usd
    FROM grant_deep_analysis_runs
    WHERE completed_at >= (
      date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul')
      AT TIME ZONE 'Asia/Seoul'
    )
      AND completed_at < (
        date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul')
        + interval '1 day'
      ) AT TIME ZONE 'Asia/Seoul'
  `);
  const value = Number(rows[0]?.spent_usd ?? 0);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid deep analysis daily spend value");
  }
  return value;
}

/** 새 KST 일자에 budget 대기 job을 다시 claimable 상태로 연다. */
export async function releaseDeepAnalysisBudgetJobs(
  db: CunoteDbSession,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE grant_deep_analysis_jobs
    SET status = 'pending', available_at = ${now.toISOString()}::timestamptz,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE status = 'pending_budget'
      AND (updated_at AT TIME ZONE 'Asia/Seoul')::date
          < (${now.toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul')::date
    RETURNING id
  `);
  return rows.length;
}

/**
 * 구버전 worker가 Error.name만 저장한 job을 최신 terminal run의 운영 error code로
 * 좁힌다. receipt/exception/run 원장은 건드리지 않고 mutable queue projection만 보정한다.
 */
export async function repairGenericDeepAnalysisJobErrorCodes(
  db: CunoteDbSession,
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    WITH latest_terminal AS (
      SELECT DISTINCT ON (run.job_id)
        run.job_id,
        run.error_code
      FROM grant_deep_analysis_runs run
      WHERE run.error_code IS NOT NULL
        AND run.status IN ('failed', 'blocked')
      ORDER BY run.job_id, run.started_at DESC, run.id DESC
    )
    UPDATE grant_deep_analysis_jobs job
    SET last_error_code = latest.error_code
    FROM latest_terminal latest
    WHERE latest.job_id = job.id
      AND job.status IN ('retry_wait', 'pending_budget', 'blocked', 'dead_letter')
      AND job.last_error_code IN ('Error', 'DeepAnalysisWorkerError')
      AND latest.error_code IS NOT NULL
    RETURNING job.id
  `);
  return rows.length;
}

/**
 * 일별 비용 상한에 도달하면 아직 claim되지 않은 대상을 명시적인 budget 대기 상태로
 * 옮긴다. leased job은 건드리지 않아 동시 worker의 실행권을 침범하지 않는다.
 */
export async function deferDeepAnalysisJobsForBudget(
  db: CunoteDbSession,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE grant_deep_analysis_jobs
    SET status = 'pending_budget',
        available_at = ${now.toISOString()}::timestamptz,
        lease_expires_at = NULL,
        worker_id = NULL,
        last_error_code = 'daily_cost_cap',
        last_error_message = 'Daily deep analysis cost cap reached',
        updated_at = ${now.toISOString()}::timestamptz
    WHERE status IN ('pending', 'retry_wait')
      AND available_at <= ${now.toISOString()}::timestamptz
    RETURNING id
  `);
  return rows.length;
}

export async function completeDeepAnalysisJob(
  db: CunoteDbSession,
  jobId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.update(schema.grantDeepAnalysisJobs).set({
    status: "succeeded",
    leaseExpiresAt: null,
    workerId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }).where(eq(schema.grantDeepAnalysisJobs.id, jobId));
}

export async function failDeepAnalysisJob(
  db: CunoteDbSession,
  input: {
    job: typeof schema.grantDeepAnalysisJobs.$inferSelect;
    failureClass: DeepAnalysisFailureClass;
    errorCode: string;
    errorMessage: string;
    now?: Date;
  },
): Promise<"retry_wait" | "pending_budget" | "blocked" | "dead_letter"> {
  const now = input.now ?? new Date();
  const exhausted = input.job.attemptCount >= input.job.maxAttempts;
  const status = resolveDeepAnalysisFailureStatus({
    failureClass: input.failureClass,
    exhausted,
  });
  await db.update(schema.grantDeepAnalysisJobs).set({
    status,
    availableAt: status === "retry_wait"
      ? retryAvailableAt(input.job.attemptCount, now)
      : now,
    leaseExpiresAt: null,
    workerId: null,
    lastErrorCode: input.errorCode.slice(0, 120),
    lastErrorMessage: input.errorMessage.slice(0, 2_000),
    updatedAt: now,
  }).where(eq(schema.grantDeepAnalysisJobs.id, input.job.id));
  return status;
}

export function resolveDeepAnalysisFailureStatus(input: {
  failureClass: DeepAnalysisFailureClass;
  exhausted: boolean;
}): "retry_wait" | "pending_budget" | "blocked" | "dead_letter" {
  if (input.failureClass === "budget") return "pending_budget";
  if (input.failureClass === "input_blocked") return "blocked";
  return input.failureClass === "retryable" && !input.exhausted
    ? "retry_wait"
    : "dead_letter";
}

export function isDeepAnalysisHeartbeatStale(
  heartbeatAt: Date,
  staleSeconds: number,
  now: Date = new Date(),
): boolean {
  return now.getTime() - heartbeatAt.getTime() > staleSeconds * 1_000;
}
