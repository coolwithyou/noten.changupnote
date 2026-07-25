import { sql } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import {
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";

export interface DeepAnalysisCohortCandidate {
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  applyEnd: Date;
  dDay: number;
  hasHwp: boolean;
  dimensionCount: number;
  needsReview: boolean;
  matchExposureCount: number;
  jobId: string;
  jobPriority: number;
  jobStatus: "pending" | "retry_wait";
  sourceRevisionSha256: string;
}

interface DeepAnalysisCohortCandidateRow extends Record<string, unknown> {
  grant_id: string;
  source: string;
  source_id: string;
  title: string;
  apply_end: Date | string;
  d_day: number | string;
  has_hwp: boolean;
  dimension_count: number | string;
  needs_review: boolean;
  match_exposure_count: number | string;
  job_id: string;
  job_priority: number | string;
  job_status: string;
  source_revision_sha256: string;
}

/**
 * first-20 후보는 active predicate와 current model policy의 최신 claimable job을 함께
 * 만족해야 한다. 실행 시각의 DB 상태를 봉인하기 위한 read-only 후보 조회다.
 */
export async function listDeepAnalysisCohortCandidates(input: {
  db: CunoteDbSession;
  modelPolicyVersion?: string;
  now?: Date;
  limit?: number;
}): Promise<DeepAnalysisCohortCandidate[]> {
  const now = input.now ?? new Date();
  const modelPolicyVersion =
    input.modelPolicyVersion ?? DEEP_ANALYSIS_MODEL_POLICY_VERSION;
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) {
    throw new Error("cohort candidate limit must be an integer between 1 and 2000");
  }
  const rows = await input.db.execute<DeepAnalysisCohortCandidateRow>(sql`
    WITH active_grants AS (
      SELECT grant_id
      FROM cunote_active_deep_analysis_grants(${now.toISOString()}::timestamptz)
    )
    SELECT
      target_grant.id::text AS grant_id,
      target_grant.source::text AS source,
      target_grant.source_id,
      target_grant.title,
      target_grant.apply_end,
      (
        timezone('Asia/Seoul', target_grant.apply_end)::date
        - timezone('Asia/Seoul', ${now.toISOString()}::timestamptz)::date
      )::int AS d_day,
      EXISTS (
        SELECT 1
        FROM grant_attachment_archives attachment
        WHERE attachment.source = target_grant.source
          AND attachment.source_id = target_grant.source_id
          AND attachment.filename ~* '\\.(hwp|hwpx)$'
      ) AS has_hwp,
      (
        SELECT count(DISTINCT criterion.dimension)::int
        FROM grant_criteria criterion
        WHERE criterion.grant_id = target_grant.id
      ) AS dimension_count,
      EXISTS (
        SELECT 1
        FROM grant_criteria criterion
        WHERE criterion.grant_id = target_grant.id
          AND criterion.needs_review = true
      ) AS needs_review,
      (
        SELECT count(*)::int
        FROM match_state current_match
        WHERE current_match.grant_id = target_grant.id
      ) AS match_exposure_count,
      latest_job.id::text AS job_id,
      latest_job.priority::int AS job_priority,
      latest_job.status AS job_status,
      latest_job.source_revision_sha256
    FROM active_grants active
    JOIN grants target_grant ON target_grant.id = active.grant_id
    JOIN LATERAL (
      SELECT candidate.*
      FROM grant_deep_analysis_jobs candidate
      WHERE candidate.grant_id = target_grant.id
        AND candidate.model_policy_version = ${modelPolicyVersion}
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    ) latest_job ON true
    WHERE latest_job.status IN ('pending', 'retry_wait')
      AND latest_job.available_at <= ${now.toISOString()}::timestamptz
      AND latest_job.attempt_count < latest_job.max_attempts
    ORDER BY target_grant.id
    LIMIT ${limit}
  `);
  return rows.map((row) => {
    if (row.job_status !== "pending" && row.job_status !== "retry_wait") {
      throw new Error(`Unexpected cohort job status: ${row.job_status}`);
    }
    return {
      grantId: row.grant_id,
      source: row.source,
      sourceId: row.source_id,
      title: row.title,
      applyEnd: new Date(row.apply_end),
      dDay: Number(row.d_day),
      hasHwp: row.has_hwp,
      dimensionCount: Number(row.dimension_count),
      needsReview: row.needs_review,
      matchExposureCount: Number(row.match_exposure_count),
      jobId: row.job_id,
      jobPriority: Number(row.job_priority),
      jobStatus: row.job_status,
      sourceRevisionSha256: row.source_revision_sha256,
    };
  });
}

/**
 * 계획의 우선순위(D-day→HWP→낮은 coverage/needs-review→노출)를 source별로 정렬한 뒤
 * round-robin으로 섞어 첫 batch가 한 source에 쏠리지 않게 한다.
 */
export function orderDeepAnalysisCohortCandidates(
  candidates: readonly DeepAnalysisCohortCandidate[],
): DeepAnalysisCohortCandidate[] {
  const bySource = new Map<string, DeepAnalysisCohortCandidate[]>();
  for (const candidate of candidates) {
    bySource.set(candidate.source, [...(bySource.get(candidate.source) ?? []), candidate]);
  }
  for (const sourceCandidates of bySource.values()) {
    sourceCandidates.sort(compareDeepAnalysisCohortCandidate);
  }
  const sourceOrder = [...bySource.keys()].sort((left, right) => {
    const leftFirst = bySource.get(left)?.[0];
    const rightFirst = bySource.get(right)?.[0];
    if (!leftFirst || !rightFirst) return left.localeCompare(right);
    return compareDeepAnalysisCohortCandidate(leftFirst, rightFirst)
      || left.localeCompare(right);
  });
  const ordered: DeepAnalysisCohortCandidate[] = [];
  for (let index = 0; ; index += 1) {
    let appended = false;
    for (const source of sourceOrder) {
      const candidate = bySource.get(source)?.[index];
      if (!candidate) continue;
      ordered.push(candidate);
      appended = true;
    }
    if (!appended) break;
  }
  return ordered;
}

function compareDeepAnalysisCohortCandidate(
  left: DeepAnalysisCohortCandidate,
  right: DeepAnalysisCohortCandidate,
): number {
  return Number(right.dDay <= 7) - Number(left.dDay <= 7)
    || Number(right.hasHwp) - Number(left.hasHwp)
    || Number(right.needsReview) - Number(left.needsReview)
    || left.dimensionCount - right.dimensionCount
    || right.matchExposureCount - left.matchExposureCount
    || right.jobPriority - left.jobPriority
    || left.dDay - right.dDay
    || left.source.localeCompare(right.source)
    || left.sourceId.localeCompare(right.sourceId)
    || left.grantId.localeCompare(right.grantId);
}
