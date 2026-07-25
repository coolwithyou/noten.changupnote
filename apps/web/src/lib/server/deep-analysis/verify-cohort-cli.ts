import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  type DeepAnalysisStageKey,
} from "@cunote/contracts";
import { sql } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  DEEP_ANALYSIS_COHORT_SERVING_STAGES,
  evaluateDeepAnalysisCohortObservation,
  type DeepAnalysisCohortObservationItem,
  type DeepAnalysisCohortServingReceipt,
  type DeepAnalysisCohortServingStage,
} from "./cohortObservation";
import { prepareDeepAnalysisInput } from "./prepareInput";
import { postgresUuidArray } from "./sqlArray";
import { deepAnalysisClaimCohortSha256 } from "./workerPolicy";

loadMonorepoEnv();

interface CohortRow extends Record<string, unknown> {
  grant_id: string;
  source: string | null;
  source_id: string | null;
  active: boolean;
  has_hwp: boolean;
  job_id: string | null;
  job_status: string | null;
  job_source_revision_sha256: string | null;
  run_id: string | null;
  run_status: string | null;
  run_source_revision_sha256: string | null;
  run_input_sha256: string | null;
  run_started_at: Date | string | null;
  run_completed_at: Date | string | null;
  stage_statuses: unknown;
  axis_count: number | string;
  audit_verdict: string | null;
  promotion_item_id: string | null;
  promotion_item_status: string | null;
  promotion_release_id: string | null;
  promotion_release_status: string | null;
  promotion_after_sha256: string | null;
  serving_receipts: unknown;
  cost_usd_since_activation: number | string;
}

interface CountRow extends Record<string, unknown> {
  count: number | string;
}

async function main(): Promise<number> {
  const now = new Date();
  const activatedAt = dateArg("activated-at");
  if (activatedAt.getTime() > now.getTime()) {
    throw new Error("--activated-at cannot be in the future");
  }
  const expectedCount = integerArg("expected-count", 20, 1, 100);
  const grantIds = uuidCsvArg("grant");
  if (grantIds.length !== expectedCount) {
    throw new Error(
      `--grant must contain exactly ${expectedCount} unique UUIDs, received ${grantIds.length}`,
    );
  }
  const expectedCohortSha256 = requiredArg("cohort-sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedCohortSha256)) {
    throw new Error("--cohort-sha256 must be a lowercase SHA-256");
  }
  const actualCohortSha256 = deepAnalysisClaimCohortSha256(grantIds);
  if (expectedCohortSha256 !== actualCohortSha256) {
    throw new Error(
      `--cohort-sha256 mismatch: expected ${actualCohortSha256}`,
    );
  }

  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 object storage environment is incomplete");
  const cohortGrantIdsSql = postgresUuidArray(grantIds);
  try {
    const [rows, outOfCohortRows] = await Promise.all([
      db.execute<CohortRow>(sql`
        WITH cohort AS (
          SELECT unnest(${cohortGrantIdsSql}) AS grant_id
        ),
        active AS (
          SELECT grant_id
          FROM cunote_active_deep_analysis_grants(${now.toISOString()}::timestamptz)
        )
        SELECT
          cohort.grant_id::text AS grant_id,
          target_grant.source::text AS source,
          target_grant.source_id,
          (active.grant_id IS NOT NULL) AS active,
          EXISTS (
            SELECT 1
            FROM grant_attachment_archives attachment
            WHERE attachment.source = target_grant.source
              AND attachment.source_id = target_grant.source_id
              AND attachment.filename ~* '\\.(hwp|hwpx)$'
          ) AS has_hwp,
          latest_job.id::text AS job_id,
          latest_job.status AS job_status,
          latest_job.source_revision_sha256 AS job_source_revision_sha256,
          latest_run.run_id,
          latest_run.status AS run_status,
          latest_run.source_revision_sha256 AS run_source_revision_sha256,
          latest_run.input_sha256 AS run_input_sha256,
          latest_run.started_at AS run_started_at,
          latest_run.completed_at AS run_completed_at,
          COALESCE((
            SELECT jsonb_object_agg(latest.stage, latest.status)
            FROM (
              SELECT DISTINCT ON (receipt.stage)
                receipt.stage,
                receipt.status
              FROM grant_deep_analysis_stage_receipts receipt
              WHERE receipt.run_id = latest_run.id
              ORDER BY
                receipt.stage,
                receipt.attempt DESC,
                receipt.created_at DESC,
                receipt.id DESC
            ) latest
          ), '{}'::jsonb) AS stage_statuses,
          COALESCE((
            SELECT count(*)::int
            FROM grant_deep_analysis_axis_results axis
            WHERE axis.run_id = latest_run.id
          ), 0)::int AS axis_count,
          latest_audit.verdict AS audit_verdict,
          latest_promotion.item_id AS promotion_item_id,
          latest_promotion.item_status AS promotion_item_status,
          latest_promotion.release_id AS promotion_release_id,
          latest_promotion.release_status AS promotion_release_status,
          latest_promotion.after_sha256 AS promotion_after_sha256,
          COALESCE((
            SELECT jsonb_object_agg(
              latest.stage,
              jsonb_build_object(
                'status', latest.status,
                'verifierVersion', latest.verifier_version,
                'evidence', latest.evidence,
                'evidenceSha256', latest.evidence_sha256,
                'artifactKey', latest.artifact_key,
                'createdAt', latest.created_at
              )
            )
            FROM (
              SELECT DISTINCT ON (receipt.stage)
                receipt.stage,
                receipt.status,
                receipt.verifier_version,
                receipt.evidence,
                receipt.evidence_sha256,
                receipt.artifact_key,
                receipt.created_at
              FROM grant_deep_analysis_stage_receipts receipt
              WHERE receipt.run_id = latest_run.id
                AND receipt.stage IN (
                  'publication_complete',
                  'serving_complete',
                  'analysis_fresh'
                )
              ORDER BY
                receipt.stage,
                receipt.attempt DESC,
                receipt.created_at DESC,
                receipt.id DESC
            ) latest
          ), '{}'::jsonb) AS serving_receipts,
          COALESCE((
            SELECT sum(run_cost.cost_usd)
            FROM grant_deep_analysis_runs run_cost
            WHERE run_cost.grant_id = cohort.grant_id
              AND run_cost.model_policy_version = ${DEEP_ANALYSIS_MODEL_POLICY_VERSION}
              AND run_cost.started_at >= ${activatedAt.toISOString()}::timestamptz
          ), 0)::text AS cost_usd_since_activation
        FROM cohort
        LEFT JOIN grants target_grant ON target_grant.id = cohort.grant_id
        LEFT JOIN active ON active.grant_id = cohort.grant_id
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM grant_deep_analysis_jobs candidate
          WHERE candidate.grant_id = cohort.grant_id
            AND candidate.model_policy_version = ${DEEP_ANALYSIS_MODEL_POLICY_VERSION}
          ORDER BY candidate.created_at DESC, candidate.id DESC
          LIMIT 1
        ) latest_job ON true
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM grant_deep_analysis_runs candidate
          WHERE candidate.job_id = latest_job.id
            AND candidate.started_at >= ${activatedAt.toISOString()}::timestamptz
          ORDER BY candidate.started_at DESC, candidate.id DESC
          LIMIT 1
        ) latest_run ON true
        LEFT JOIN LATERAL (
          SELECT candidate.verdict
          FROM grant_deep_analysis_audits candidate
          WHERE candidate.run_id = latest_run.id
          ORDER BY candidate.attempt DESC, candidate.completed_at DESC, candidate.id DESC
          LIMIT 1
        ) latest_audit ON true
        LEFT JOIN LATERAL (
          SELECT
            promotion_item.id::text AS item_id,
            promotion_item.status AS item_status,
            promotion_item.after_sha256,
            promotion_release.release_id,
            promotion_release.status AS release_status
          FROM analysis_lab_promotion_items promotion_item
          INNER JOIN analysis_lab_promotion_releases promotion_release
            ON promotion_release.id = promotion_item.release_db_id
          WHERE promotion_item.grant_id = cohort.grant_id
            AND promotion_item.deep_analysis_run_id = latest_run.id
          ORDER BY
            CASE WHEN promotion_release.status = 'active' THEN 0 ELSE 1 END,
            promotion_item.applied_at DESC NULLS LAST,
            promotion_item.id DESC
          LIMIT 1
        ) latest_promotion ON true
        ORDER BY cohort.grant_id
      `),
      db.execute<CountRow>(sql`
        SELECT count(*)::int AS count
        FROM grant_deep_analysis_runs run
        WHERE run.model_policy_version = ${DEEP_ANALYSIS_MODEL_POLICY_VERSION}
          AND run.started_at >= ${activatedAt.toISOString()}::timestamptz
          AND NOT (run.grant_id = ANY(${cohortGrantIdsSql}))
      `),
    ]);

    const items: DeepAnalysisCohortObservationItem[] = [];
    for (const row of rows) {
      let currentInputSealed = false;
      let currentSourceRevisionSha256: string | null = null;
      let currentInputSha256: string | null = null;
      let currentInputBlockerCodes: string[] = [];
      let currentInputVerificationError: string | null = null;
      try {
        const seal = await prepareDeepAnalysisInput({
          db,
          storage,
          grantId: row.grant_id,
          maxTotalChars: DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
        });
        currentInputSealed = seal.sealed;
        currentSourceRevisionSha256 = seal.sourceRevisionSha256;
        currentInputSha256 = seal.inputSha256;
        currentInputBlockerCodes = [...new Set(
          seal.blockers.map((blocker) => blocker.code),
        )].sort();
      } catch (error) {
        currentInputVerificationError = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 500);
      }
      items.push({
        grantId: row.grant_id,
        source: row.source,
        sourceId: row.source_id,
        active: row.active,
        hasHwp: row.has_hwp,
        jobId: row.job_id,
        jobStatus: row.job_status,
        jobSourceRevisionSha256: row.job_source_revision_sha256,
        runId: row.run_id,
        runStatus: row.run_status,
        runSourceRevisionSha256: row.run_source_revision_sha256,
        runInputSha256: row.run_input_sha256,
        runStartedAt: nullableDate(row.run_started_at, "run_started_at"),
        runCompletedAt: nullableDate(row.run_completed_at, "run_completed_at"),
        stageStatuses: stageStatuses(row.stage_statuses),
        axisCount: Number(row.axis_count),
        auditVerdict: row.audit_verdict,
        currentInputSealed,
        currentSourceRevisionSha256,
        currentInputSha256,
        currentInputBlockerCodes,
        currentInputVerificationError,
        promotion: (
          row.promotion_item_id && row.promotion_release_id
            ? {
                itemId: row.promotion_item_id,
                itemStatus: row.promotion_item_status ?? "",
                releaseId: row.promotion_release_id,
                releaseStatus: row.promotion_release_status ?? "",
                afterSha256: row.promotion_after_sha256,
              }
            : null
        ),
        servingReceipts: servingReceipts(row.serving_receipts),
        costUsdSinceActivation: Number(row.cost_usd_since_activation),
      });
    }
    const output = evaluateDeepAnalysisCohortObservation({
      activatedAt,
      now,
      claimCohortSha256: actualCohortSha256,
      expectedCount,
      outOfCohortRunCount: Number(outOfCohortRows[0]?.count ?? 0),
      items,
    });
    console.log(JSON.stringify(output, null, 2));
    return output.verdict === "PASS" ? 0 : 2;
  } finally {
    await closeCunoteDb();
  }
}

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  if (!value) throw new Error(`--${name}=... is required`);
  return value;
}

function dateArg(name: string): Date {
  const raw = requiredArg(name);
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`--${name} must include an explicit timezone`);
  }
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime())) throw new Error(`--${name} is invalid`);
  return value;
}

function integerArg(name: string, fallback: number, min: number, max: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function uuidCsvArg(name: string): string[] {
  const values = requiredArg(name)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(values)].sort();
  const invalid = unique.find((value) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
  if (invalid) throw new Error(`--${name} contains an invalid UUID: ${invalid}`);
  if (unique.length !== values.length) throw new Error(`--${name} contains duplicate UUIDs`);
  return unique;
}

function nullableDate(value: Date | string | null, label: string): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

function stageStatuses(
  value: unknown,
): Partial<Record<DeepAnalysisStageKey, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ) as Partial<Record<DeepAnalysisStageKey, string>>;
}

function servingReceipts(
  value: unknown,
): Partial<Record<DeepAnalysisCohortServingStage, DeepAnalysisCohortServingReceipt>> {
  const record = objectRecord(value);
  if (!record) return {};
  const receipts: Partial<
    Record<DeepAnalysisCohortServingStage, DeepAnalysisCohortServingReceipt>
  > = {};
  for (const stage of DEEP_ANALYSIS_COHORT_SERVING_STAGES) {
    const receipt = objectRecord(record[stage]);
    if (!receipt) continue;
    receipts[stage] = {
      status: nullableString(receipt.status),
      verifierVersion: nullableString(receipt.verifierVersion),
      evidence: objectRecord(receipt.evidence) ?? {},
      evidenceSha256: nullableString(receipt.evidenceSha256),
      artifactKey: nullableString(receipt.artifactKey),
      createdAt: nullableUnknownDate(receipt.createdAt, `${stage}.createdAt`),
    };
  }
  return receipts;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableUnknownDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === "string") {
    return nullableDate(value, label);
  }
  throw new Error(`${label} is invalid`);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
