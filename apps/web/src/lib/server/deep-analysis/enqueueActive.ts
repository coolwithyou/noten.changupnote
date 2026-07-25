import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { ensureAggregateSplitCaseForSeal } from "./aggregateSplitCase";
import { activeDeepAnalysisGrantPredicate } from "./eligibility";
import { enqueueDeepAnalysisJob } from "./ledger";
import { prepareDeepAnalysisInput } from "./prepareInput";
import {
  assertDeepAnalysisClaimScopeConfigured,
  type DeepAnalysisWorkerPolicy,
} from "./workerPolicy";

export interface ActiveDeepAnalysisEnqueueCandidate {
  grantId: string;
  source: string;
  sourceId: string;
  sourceChangedAt: Date;
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
 * 새 활성 공고와 source/첨부가 마지막 feeder 관측 이후 바뀐 공고만 후보로 고른다.
 * claim/retry/complete가 바꾸는 job.updated_at은 source watermark로 사용하지 않는다.
 */
export async function listActiveDeepAnalysisEnqueueCandidates(input: {
  db: CunoteDbSession;
  modelPolicyVersion: string;
  limit: number;
  grantIds?: readonly string[];
  now?: Date;
}): Promise<ActiveDeepAnalysisEnqueueCandidate[]> {
  if (input.grantIds && input.grantIds.length === 0) return [];
  const now = input.now ?? new Date();
  const observation = deepAnalysisSourceObservationSql(
    input.modelPolicyVersion,
  );
  const rows = await input.db.select({
    grantId: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    sourceChangedAt: observation.sourceChangedAt,
  }).from(schema.grants).where(and(
    activeDeepAnalysisGrantPredicate(now),
    ...(input.grantIds ? [inArray(schema.grants.id, input.grantIds)] : []),
    observation.pending,
  )).orderBy(
    asc(schema.grants.applyEnd),
    asc(schema.grants.source),
    asc(schema.grants.sourceId),
  ).limit(input.limit);
  return rows;
}

export function deepAnalysisSourceObservationSql(
  modelPolicyVersion: string,
): {
  sourceChangedAt: SQL<Date>;
  pending: SQL<boolean>;
} {
  const latestSourceObservedAt = sql<Date | null>`
    (
      SELECT MAX(deep_job.source_observed_at)
      FROM grant_deep_analysis_jobs AS deep_job
      WHERE deep_job.grant_id = ${schema.grants.id}
        AND deep_job.model_policy_version = ${modelPolicyVersion}
    )
  `;
  const sourceChangedAt = sql<Date>`
    GREATEST(
      ${schema.grants.updatedAt},
      COALESCE((
        SELECT MAX(deep_raw.collected_at)
        FROM grant_raw AS deep_raw
        WHERE deep_raw.source = ${schema.grants.source}
          AND deep_raw.source_id = ${schema.grants.sourceId}
      ), ${schema.grants.updatedAt}),
      COALESCE((
        SELECT MAX(deep_attachment.updated_at)
        FROM grant_attachment_archives AS deep_attachment
        WHERE deep_attachment.source = ${schema.grants.source}
          AND deep_attachment.source_id = ${schema.grants.sourceId}
      ), ${schema.grants.updatedAt}),
      COALESCE((
        SELECT MAX(GREATEST(deep_surface.updated_at, deep_artifact.created_at))
        FROM grant_application_surfaces AS deep_surface
        JOIN document_artifacts AS deep_artifact
          ON deep_artifact.surface_id = deep_surface.id
          AND deep_artifact.kind = 'markdown'
        WHERE deep_surface.grant_id = ${schema.grants.id}
      ), ${schema.grants.updatedAt})
    )
  `.mapWith(schema.grants.updatedAt);
  return {
    sourceChangedAt,
    pending: sql<boolean>`
      (
        ${latestSourceObservedAt} IS NULL
        OR ${sourceChangedAt} > ${latestSourceObservedAt}
      )
    `,
  };
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
  assertDeepAnalysisClaimScopeConfigured(input.policy);
  const now = input.now ?? new Date();
  const candidates = await (
    input.listCandidates ?? listActiveDeepAnalysisEnqueueCandidates
  )({
    db: input.db,
    modelPolicyVersion: input.policy.modelPolicyVersion,
    limit: input.policy.maxEnqueuePerInvocation,
    ...(input.policy.claimScope === "bounded"
      ? { grantIds: input.policy.claimGrantIds }
      : {}),
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
      await ensureAggregateSplitCaseForSeal({
        db: input.db,
        grantId: candidate.grantId,
        seal,
        inputCapChars: input.policy.maxTotalInputChars,
      });
      await (input.enqueueJob ?? enqueueDeepAnalysisJob)(input.db, {
        grantId: candidate.grantId,
        sourceRevisionSha256: seal.sourceRevisionSha256,
        modelPolicyVersion: input.policy.modelPolicyVersion,
        sourceObservedAt: candidate.sourceChangedAt,
      });
      result.ensured += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        grantId: candidate.grantId,
        source: candidate.source,
        sourceId: candidate.sourceId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
  return result;
}
