import { and, asc, eq, sql } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { activeDeepAnalysisGrantPredicate } from "./eligibility";
import { enqueueDeepAnalysisJob } from "./ledger";
import { prepareDeepAnalysisInput } from "./prepareInput";
import type { DeepAnalysisWorkerPolicy } from "./workerPolicy";

export interface ActiveDeepAnalysisEnqueueCandidate {
  grantId: string;
  source: string;
  sourceId: string;
}

export interface ActiveDeepAnalysisEnqueueResult {
  examined: number;
  ensured: number;
  failed: number;
  failures: Array<{
    grantId: string;
    source: string;
    sourceId: string;
    error: string;
  }>;
}

/**
 * 새 활성 공고와 source/첨부가 마지막 현재-policy job 이후 바뀐 공고만 feeder 후보로
 * 고른다. 실제 source revision identity는 prepare→enqueue가 다시 계산하므로 race가
 * 있어도 DB unique key가 중복 paid job을 막는다.
 */
export async function listActiveDeepAnalysisEnqueueCandidates(input: {
  db: CunoteDbSession;
  modelPolicyVersion: string;
  limit: number;
  now?: Date;
}): Promise<ActiveDeepAnalysisEnqueueCandidate[]> {
  const now = input.now ?? new Date();
  const latestJobUpdatedAt = sql`
    (
      SELECT MAX(deep_job.updated_at)
      FROM grant_deep_analysis_jobs AS deep_job
      WHERE deep_job.grant_id = ${schema.grants.id}
        AND deep_job.model_policy_version = ${input.modelPolicyVersion}
    )
  `;
  const sourceChangedSinceLatestJob = sql`
    (
      ${latestJobUpdatedAt} IS NULL
      OR ${schema.grants.updatedAt} > ${latestJobUpdatedAt}
      OR EXISTS (
        SELECT 1
        FROM grant_raw AS deep_raw
        WHERE deep_raw.source = ${schema.grants.source}
          AND deep_raw.source_id = ${schema.grants.sourceId}
          AND deep_raw.collected_at > ${latestJobUpdatedAt}
      )
      OR EXISTS (
        SELECT 1
        FROM grant_attachment_archives AS deep_attachment
        WHERE deep_attachment.source = ${schema.grants.source}
          AND deep_attachment.source_id = ${schema.grants.sourceId}
          AND deep_attachment.updated_at > ${latestJobUpdatedAt}
      )
      OR EXISTS (
        SELECT 1
        FROM grant_application_surfaces AS deep_surface
        JOIN document_artifacts AS deep_artifact
          ON deep_artifact.surface_id = deep_surface.id
          AND deep_artifact.kind = 'markdown'
        WHERE deep_surface.grant_id = ${schema.grants.id}
          AND GREATEST(deep_surface.updated_at, deep_artifact.created_at)
              > ${latestJobUpdatedAt}
      )
    )
  `;
  const rows = await input.db.select({
    grantId: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
  }).from(schema.grants).where(and(
    activeDeepAnalysisGrantPredicate(now),
    sourceChangedSinceLatestJob,
  )).orderBy(
    asc(schema.grants.applyEnd),
    asc(schema.grants.source),
    asc(schema.grants.sourceId),
  ).limit(input.limit);
  return rows;
}

/**
 * Scheduler invocation마다 작은 batch만 seal/enqueue한다. 공고 한 건의 R2 오류가 다른
 * 공고 feeder를 막지 않으며, 실패 목록은 worker heartbeat metadata로 넘겨 관제한다.
 */
export async function enqueueActiveDeepAnalysisJobs(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  policy: DeepAnalysisWorkerPolicy;
  now?: Date;
  listCandidates?: typeof listActiveDeepAnalysisEnqueueCandidates;
  prepareInput?: typeof prepareDeepAnalysisInput;
  enqueueJob?: typeof enqueueDeepAnalysisJob;
}): Promise<ActiveDeepAnalysisEnqueueResult> {
  const now = input.now ?? new Date();
  const candidates = await (
    input.listCandidates ?? listActiveDeepAnalysisEnqueueCandidates
  )({
    db: input.db,
    modelPolicyVersion: input.policy.modelPolicyVersion,
    limit: input.policy.maxEnqueuePerInvocation,
    now,
  });
  const result: ActiveDeepAnalysisEnqueueResult = {
    examined: candidates.length,
    ensured: 0,
    failed: 0,
    failures: [],
  };
  for (const candidate of candidates) {
    try {
      const seal = await (input.prepareInput ?? prepareDeepAnalysisInput)({
        db: input.db,
        storage: input.storage,
        grantId: candidate.grantId,
        maxTotalChars: input.policy.maxTotalInputChars,
      });
      await (input.enqueueJob ?? enqueueDeepAnalysisJob)(input.db, {
        grantId: candidate.grantId,
        sourceRevisionSha256: seal.sourceRevisionSha256,
        modelPolicyVersion: input.policy.modelPolicyVersion,
      });
      result.ensured += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        ...candidate,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
  return result;
}
