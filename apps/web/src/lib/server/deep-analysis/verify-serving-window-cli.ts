import {
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
  type DeepAnalysisStageStatus,
} from "@cunote/contracts";
import { sql } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import {
  createR2ObjectStorageFromEnv,
} from "@/lib/server/storage/r2ObjectStorage";
import {
  readAndEvaluateDeepAnalysisServingCloudObservation,
} from "./gcloudServingObservation";
import {
  DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES,
  evaluateDeepAnalysisServingObservation,
  verifyDeepAnalysisServingObservationArtifacts,
  type DeepAnalysisServingObservationReceipt,
  type DeepAnalysisServingObservationStage,
} from "./servingObservation";

loadMonorepoEnv();

interface ExpectedItemRow extends Record<string, unknown> {
  promotion_item_id: string;
  public_run_id: string;
}

interface ReceiptRow extends Record<string, unknown> {
  id: string;
  execution_id: string;
  promotion_item_id: string;
  public_run_id: string;
  stage: string;
  status: string;
  verifier_version: string;
  evidence: unknown;
  evidence_sha256: string;
  artifact_key: string | null;
  created_at: Date | string;
}

async function main(): Promise<number> {
  const start = readDateArg("start");
  const end = readDateArg("end");
  const now = new Date();
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 object storage environment is incomplete");

  const [expectedRows, receiptRows] = await Promise.all([
    db.execute<ExpectedItemRow>(sql`
      SELECT
        item.id::text AS promotion_item_id,
        run.run_id AS public_run_id
      FROM analysis_lab_promotion_items item
      JOIN analysis_lab_promotion_releases release
        ON release.id = item.release_db_id
      JOIN grant_deep_analysis_runs run
        ON run.id = item.deep_analysis_run_id
      WHERE release.status = 'active'
        AND item.status = 'applied'
        AND item.deep_analysis_run_id IS NOT NULL
      ORDER BY item.id
    `),
    db.execute<ReceiptRow>(sql`
      SELECT
        receipt.id::text AS id,
        receipt.evidence->>'monitorExecutionId' AS execution_id,
        receipt.evidence->>'promotionItemId' AS promotion_item_id,
        run.run_id AS public_run_id,
        receipt.stage,
        receipt.status,
        receipt.verifier_version,
        receipt.evidence,
        receipt.evidence_sha256,
        receipt.artifact_key,
        receipt.created_at
      FROM grant_deep_analysis_stage_receipts receipt
      JOIN grant_deep_analysis_runs run
        ON run.id = receipt.run_id
      WHERE receipt.created_at >= ${start.toISOString()}::timestamptz
        AND receipt.created_at < ${end.toISOString()}::timestamptz
        AND receipt.verifier_version = ${DEEP_ANALYSIS_SERVING_VERIFIER_VERSION}
        AND receipt.stage IN (
          'publication_complete',
          'serving_complete',
          'analysis_fresh'
        )
        AND receipt.evidence->>'observationMode' = 'active_monitor'
        AND receipt.evidence->>'monitorRuntime' = 'cloud_run'
      ORDER BY receipt.created_at, receipt.id
    `),
  ]);

  const receipts = receiptRows.map(parseReceiptRow);
  const evaluation = evaluateDeepAnalysisServingObservation({
    start,
    end,
    now,
    expectedItems: expectedRows.map((row) => ({
      promotionItemId: row.promotion_item_id,
      publicRunId: row.public_run_id,
    })),
    receipts,
  });
  const artifactFailures = await verifyDeepAnalysisServingObservationArtifacts({
    storage,
    receipts,
    scheduledExecutionIds: evaluation.scheduledExecutionIds,
  });
  const cloudEvaluation = await readAndEvaluateDeepAnalysisServingCloudObservation({
    start,
    end,
    now,
    receiptExecutionIds: evaluation.scheduledExecutionIds,
  });
  const failures = [...evaluation.failures, ...artifactFailures];
  const output = {
    ...evaluation,
    verdict: failures.length === 0 && cloudEvaluation.verdict === "PASS"
      ? "PASS"
      : "FAIL",
    artifactVerification: {
      checkedReceipts: receipts.filter((receipt) =>
        evaluation.scheduledExecutionIds.includes(receipt.executionId)).length,
      failures: artifactFailures.length,
    },
    cloudEvidence: cloudEvaluation,
    failures,
  };
  console.log(JSON.stringify(output, null, 2));
  return failures.length === 0 && cloudEvaluation.verdict === "PASS" ? 0 : 2;
}

function readDateArg(name: string): Date {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!raw) throw new Error(`--${name}=<ISO timestamp> is required`);
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`--${name} must include an explicit timezone`);
  }
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime())) throw new Error(`--${name} is not a valid timestamp`);
  return value;
}

function parseReceiptRow(row: ReceiptRow): DeepAnalysisServingObservationReceipt {
  if (!row.execution_id) throw new Error(`receipt ${row.id} has no monitor execution ID`);
  if (!row.promotion_item_id) throw new Error(`receipt ${row.id} has no promotion item ID`);
  if (!isObservationStage(row.stage)) {
    throw new Error(`receipt ${row.id} has unexpected stage ${row.stage}`);
  }
  if (!isDeepAnalysisStageStatus(row.status)) {
    throw new Error(`receipt ${row.id} has unexpected status ${row.status}`);
  }
  if (!isRecord(row.evidence)) throw new Error(`receipt ${row.id} evidence is not an object`);
  const createdAt = row.created_at instanceof Date
    ? row.created_at
    : new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error(`receipt ${row.id} has an invalid created_at`);
  }
  return {
    id: row.id,
    executionId: row.execution_id,
    promotionItemId: row.promotion_item_id,
    publicRunId: row.public_run_id,
    stage: row.stage,
    status: row.status,
    verifierVersion: row.verifier_version,
    evidence: row.evidence,
    evidenceSha256: row.evidence_sha256,
    artifactKey: row.artifact_key,
    createdAt,
  };
}

function isObservationStage(value: string): value is DeepAnalysisServingObservationStage {
  return (DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES as readonly string[]).includes(value);
}

function isDeepAnalysisStageStatus(value: string): value is DeepAnalysisStageStatus {
  return [
    "pending",
    "running",
    "passed",
    "failed",
    "blocked",
    "stale",
    "not_applicable",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCunoteDb();
  });
