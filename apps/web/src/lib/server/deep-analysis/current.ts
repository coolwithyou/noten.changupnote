import { sql } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";

export interface DeepAnalysisCurrentRow extends Record<string, unknown> {
  grant_id: string;
  job_id: string;
  run_db_id: string | null;
  run_id: string | null;
  source_revision_sha256: string;
  run_source_revision_sha256: string | null;
  job_status: string;
  run_status: string | null;
  analysis_complete: boolean;
  publication_complete: boolean;
  serving_complete: boolean;
  fresh: boolean;
  stale: boolean;
  first_blocking_stage: string | null;
}

/**
 * 각 grant의 최신 enqueue identity만 current로 본다. 최신 job과 다른 revision의 과거
 * passed run은 선택되지 않으며, latest receipt attempt만 완료 플래그에 반영한다.
 */
export async function loadDeepAnalysisCurrent(
  db: CunoteDbSession,
  grantIds?: readonly string[],
): Promise<DeepAnalysisCurrentRow[]> {
  const ids = grantIds ? [...grantIds] : null;
  if (ids?.length === 0) return [];
  return db.execute<DeepAnalysisCurrentRow>(sql`
    WITH latest_job AS (
      SELECT DISTINCT ON (job.grant_id)
        job.*
      FROM grant_deep_analysis_jobs job
      ${ids ? sql`WHERE job.grant_id = ANY(${ids}::uuid[])` : sql``}
      ORDER BY job.grant_id, job.created_at DESC, job.id DESC
    ),
    latest_run AS (
      SELECT
        job.id AS current_job_id,
        run.*
      FROM latest_job job
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM grant_deep_analysis_runs candidate
        WHERE candidate.grant_id = job.grant_id
        ORDER BY candidate.started_at DESC, candidate.id DESC
        LIMIT 1
      ) run ON true
    ),
    latest_receipt AS (
      SELECT DISTINCT ON (receipt.run_id, receipt.stage)
        receipt.run_id,
        receipt.stage,
        receipt.status,
        receipt.attempt
      FROM grant_deep_analysis_stage_receipts receipt
      JOIN latest_run run ON run.id = receipt.run_id
      ORDER BY receipt.run_id, receipt.stage, receipt.attempt DESC, receipt.created_at DESC
    ),
    flags AS (
      SELECT
        run.id AS run_id,
        bool_or(receipt.stage = 'analysis_complete' AND receipt.status = 'passed')
          AS analysis_complete,
        bool_or(receipt.stage = 'publication_complete' AND receipt.status = 'passed')
          AS publication_complete,
        bool_or(receipt.stage = 'serving_complete' AND receipt.status = 'passed')
          AS serving_complete,
        bool_or(receipt.stage = 'analysis_fresh' AND receipt.status = 'passed')
          AS analysis_fresh
      FROM latest_run run
      LEFT JOIN latest_receipt receipt ON receipt.run_id = run.id
      GROUP BY run.id
    )
    SELECT
      job.grant_id,
      job.id AS job_id,
      run.id AS run_db_id,
      run.run_id,
      job.source_revision_sha256,
      run.source_revision_sha256 AS run_source_revision_sha256,
      job.status AS job_status,
      run.status AS run_status,
      coalesce(flags.analysis_complete, false) AS analysis_complete,
      coalesce(flags.publication_complete, false) AS publication_complete,
      coalesce(flags.serving_complete, false) AS serving_complete,
      (
        coalesce(flags.analysis_fresh, false)
        AND run.source_revision_sha256 = job.source_revision_sha256
      ) AS fresh,
      (
        run.id IS NOT NULL
        AND run.source_revision_sha256 <> job.source_revision_sha256
      ) AS stale,
      CASE
        WHEN run.id IS NOT NULL
          AND run.source_revision_sha256 <> job.source_revision_sha256
          THEN 'analysis_fresh'
        ELSE blocker.stage
      END AS first_blocking_stage
    FROM latest_job job
    LEFT JOIN latest_run run ON run.current_job_id = job.id
    LEFT JOIN flags ON flags.run_id = run.id
    LEFT JOIN LATERAL (
      SELECT expected.stage
      FROM unnest(ARRAY[
        'source_fresh', 'attachment_inventory_complete', 'attachment_archive_complete',
        'attachment_text_complete', 'input_coverage_verified', 'input_sealed',
        'model_call_passed', 'response_contract_valid', 'axis_coverage_complete',
        'evidence_grounded', 'independent_audit_passed', 'analysis_complete',
        'publication_complete', 'serving_complete', 'analysis_fresh'
      ]::text[]) WITH ORDINALITY AS expected(stage, position)
      LEFT JOIN latest_receipt receipt
        ON receipt.run_id = run.id AND receipt.stage = expected.stage
      WHERE receipt.status IS NULL
         OR receipt.status NOT IN ('passed', 'not_applicable')
      ORDER BY expected.position
      LIMIT 1
    ) blocker ON true
    ORDER BY job.grant_id
  `);
}
