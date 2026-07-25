import { and, desc, eq, sql } from "drizzle-orm";
import type {
  DeepAnalysisStageKey,
  DeepAnalysisStageStatus,
} from "@cunote/contracts";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { sha256Hex, stableJson } from "./sourceRevision";

export interface EnqueueDeepAnalysisJobInput {
  grantId: string;
  sourceRevisionSha256: string;
  modelPolicyVersion: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
}

/** DB unique identity와 ON CONFLICT DO NOTHING을 함께 사용해 동시 enqueue를 멱등화한다. */
export async function enqueueDeepAnalysisJob(
  db: CunoteDbSession,
  input: EnqueueDeepAnalysisJobInput,
): Promise<typeof schema.grantDeepAnalysisJobs.$inferSelect> {
  const [inserted] = await db.insert(schema.grantDeepAnalysisJobs).values({
    grantId: input.grantId,
    sourceRevisionSha256: input.sourceRevisionSha256,
    modelPolicyVersion: input.modelPolicyVersion,
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? 5,
    availableAt: input.availableAt ?? new Date(),
  }).onConflictDoNothing({
    target: [
      schema.grantDeepAnalysisJobs.grantId,
      schema.grantDeepAnalysisJobs.sourceRevisionSha256,
      schema.grantDeepAnalysisJobs.modelPolicyVersion,
    ],
  }).returning();
  if (inserted) return inserted;

  const [existing] = await db.select().from(schema.grantDeepAnalysisJobs).where(and(
    eq(schema.grantDeepAnalysisJobs.grantId, input.grantId),
    eq(schema.grantDeepAnalysisJobs.sourceRevisionSha256, input.sourceRevisionSha256),
    eq(schema.grantDeepAnalysisJobs.modelPolicyVersion, input.modelPolicyVersion),
  )).limit(1);
  if (!existing) throw new Error("Deep analysis job conflict did not resolve to an existing row");
  return existing;
}

export async function appendDeepAnalysisStageReceipt(
  db: CunoteDbSession,
  input: {
    runId: string;
    stage: DeepAnalysisStageKey;
    status: DeepAnalysisStageStatus;
    verifierVersion: string;
    evidence: Record<string, unknown>;
    artifactKey?: string;
    attempt?: number;
  },
): Promise<typeof schema.grantDeepAnalysisStageReceipts.$inferSelect> {
  const evidenceSha256 = sha256Hex(stableJson(input.evidence));
  const [receipt] = await db.insert(schema.grantDeepAnalysisStageReceipts).values({
    runId: input.runId,
    stage: input.stage,
    status: input.status,
    verifierVersion: input.verifierVersion,
    evidence: input.evidence,
    evidenceSha256,
    artifactKey: input.artifactKey,
    attempt: input.attempt ?? 1,
  }).returning();
  if (!receipt) throw new Error("Failed to append deep analysis stage receipt");
  return receipt;
}

export async function appendDeepAnalysisExceptionEvent(
  db: CunoteDbSession,
  input: {
    runId: string;
    exceptionKey: string;
    eventType: "opened" | "resolved" | "reopened" | "assigned" | "released";
    reasonCode: string;
    actorType: "system" | "human";
    actor: string;
    detail: Record<string, unknown>;
  },
): Promise<typeof schema.grantDeepAnalysisExceptionEvents.$inferSelect> {
  const evidenceSha256 = sha256Hex(stableJson(input.detail));
  const [event] = await db.insert(schema.grantDeepAnalysisExceptionEvents).values({
    runId: input.runId,
    exceptionKey: input.exceptionKey,
    eventType: input.eventType,
    reasonCode: input.reasonCode,
    actorType: input.actorType,
    actor: input.actor,
    detail: input.detail,
    evidenceSha256,
  }).returning();
  if (!event) throw new Error("Failed to append deep analysis exception event");
  return event;
}

/**
 * 여러 worker가 서로 기다리지 않도록 claim과 lease 갱신만 단일 짧은 문장으로 수행한다.
 * 외부 R2/LLM 호출은 이 함수가 반환된 뒤 트랜잭션 밖에서 실행한다.
 */
export async function claimDeepAnalysisJob(
  db: CunoteDbSession,
  input: {
    workerId: string;
    leaseSeconds: number;
    modelPolicyVersion: string;
    maxConcurrentJobs: number;
    claimGrantIds?: readonly string[];
    now?: Date;
  },
): Promise<typeof schema.grantDeepAnalysisJobs.$inferSelect | null> {
  if (!input.workerId.trim()) throw new Error("workerId is required");
  if (!input.modelPolicyVersion.trim()) throw new Error("modelPolicyVersion is required");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 3600) {
    throw new Error("leaseSeconds must be an integer between 30 and 3600");
  }
  if (
    !Number.isInteger(input.maxConcurrentJobs)
    || input.maxConcurrentJobs < 1
    || input.maxConcurrentJobs > 10
  ) {
    throw new Error("maxConcurrentJobs must be an integer between 1 and 10");
  }
  if (input.claimGrantIds && input.claimGrantIds.length === 0) {
    throw new Error("claimGrantIds must be omitted or contain at least one grant ID");
  }
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000);
  const cohortFilter = input.claimGrantIds
    ? sql`AND candidate.grant_id::text = ANY(${input.claimGrantIds}::text[])`
    : sql``;
  const claimed = await db.execute<{ id: string }>(sql`
    WITH claim_lock AS (
      SELECT pg_advisory_xact_lock(
        hashtext('cunote:deep-analysis-claim:' || ${input.modelPolicyVersion})
      )
    ),
    capacity AS (
      SELECT count(*)::int AS active_count
      FROM grant_deep_analysis_jobs, claim_lock
      WHERE model_policy_version = ${input.modelPolicyVersion}
        AND status = 'leased'
        AND lease_expires_at > ${now.toISOString()}::timestamptz
    )
    UPDATE grant_deep_analysis_jobs
    SET
      status = 'leased',
      leased_at = ${now.toISOString()}::timestamptz,
      lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
      worker_id = ${input.workerId},
      attempt_count = attempt_count + 1,
      updated_at = ${now.toISOString()}::timestamptz
    WHERE id = (
      SELECT candidate.id
      FROM grant_deep_analysis_jobs AS candidate, capacity
      WHERE capacity.active_count < ${input.maxConcurrentJobs}
        AND candidate.model_policy_version = ${input.modelPolicyVersion}
        ${cohortFilter}
        AND (
          (
            candidate.status IN ('pending', 'retry_wait')
            AND candidate.available_at <= ${now.toISOString()}::timestamptz
            AND candidate.attempt_count < candidate.max_attempts
          ) OR (
            candidate.status = 'leased'
            AND candidate.lease_expires_at <= ${now.toISOString()}::timestamptz
            AND candidate.attempt_count < candidate.max_attempts
          )
        )
      ORDER BY
        candidate.priority DESC,
        candidate.available_at ASC,
        candidate.created_at ASC
      LIMIT 1
      FOR UPDATE OF candidate SKIP LOCKED
    )
    RETURNING id::text AS id
  `);
  const claimedId = claimed[0]?.id;
  if (!claimedId) return null;
  const [job] = await db.select().from(schema.grantDeepAnalysisJobs)
    .where(eq(schema.grantDeepAnalysisJobs.id, claimedId)).limit(1);
  if (!job) throw new Error(`Claimed deep analysis job disappeared: ${claimedId}`);
  return job;
}

export async function findLatestDeepAnalysisRunForJob(
  db: CunoteDbSession,
  jobId: string,
): Promise<typeof schema.grantDeepAnalysisRuns.$inferSelect | null> {
  const [run] = await db.select().from(schema.grantDeepAnalysisRuns)
    .where(eq(schema.grantDeepAnalysisRuns.jobId, jobId))
    .orderBy(desc(schema.grantDeepAnalysisRuns.startedAt))
    .limit(1);
  return run ?? null;
}
