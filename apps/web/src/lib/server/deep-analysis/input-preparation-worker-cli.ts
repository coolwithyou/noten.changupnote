import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveDeepAnalysisInputPreparationPolicy,
  runDeepAnalysisInputPreparation,
} from "./inputPreparation";
import { writeDeepAnalysisWorkerHeartbeat } from "./workerState";

loadMonorepoEnv();

if (
  process.env.DEEP_ANALYSIS_PREPARE_EXECUTE !== "1"
  && !process.argv.includes("--execute")
) {
  throw new Error(
    "Deep analysis input preparation is fail-closed. "
    + "Set DEEP_ANALYSIS_PREPARE_EXECUTE=1 or pass --execute.",
  );
}

const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");
if (!process.env.CONVERSION_SERVER_URL?.trim()) {
  throw new Error("CONVERSION_SERVER_URL is required");
}
if (!process.env.CONVERSION_SHARED_SECRET?.trim()) {
  throw new Error("CONVERSION_SHARED_SECRET is required");
}

const db = getCunoteDb();
const policy = resolveDeepAnalysisInputPreparationPolicy();
const workerId = (
  process.env.CLOUD_RUN_EXECUTION
  || process.env.HOSTNAME
  || `local-${process.pid}`
).slice(0, 200);
const serviceRevision = (
  process.env.K_REVISION
  || process.env.GIT_COMMIT_SHA
  || "local-unversioned"
).slice(0, 200);
try {
  await writeDeepAnalysisWorkerHeartbeat(db, {
    workerId,
    serviceRevision,
    modelPolicyVersion: policy.modelPolicyVersion,
    status: "running",
    metadata: {
      role: "input_preparation",
      phase: "running",
    },
  });
  const result = await runDeepAnalysisInputPreparation({
    db,
    storage,
    policy,
  });
  const archiveFailedCount =
    (result.archive.kstartup?.failedCount ?? 0)
    + (result.archive.bizinfo?.failedCount ?? 0);
  await writeDeepAnalysisWorkerHeartbeat(db, {
    workerId,
    serviceRevision,
    modelPolicyVersion: policy.modelPolicyVersion,
    status: "idle",
    metadata: {
      role: "input_preparation",
      phase: "complete",
      targetCount: result.targetCount,
      sealedCount: result.sealedCount,
      unresolvedCount: result.unresolvedCount,
      archiveFailedCount,
      conversionFailedCount: result.conversion.failed,
      conversionStillPending: result.conversion.stillPending,
      conversionCandidateAttachmentCount:
        result.conversionRegistration.candidateAttachmentCount,
      conversionSurfacesUpserted:
        result.conversionRegistration.surfacesUpserted,
      conversionJobsEnqueued: result.conversionRegistration.jobsEnqueued,
      conversionCacheHits: result.conversionRegistration.cacheHits,
      conversionRegistrationSkipped: result.conversionRegistration.skipped,
      conversionRegistrationWarnings: result.conversionRegistration.warnings.length,
      pdfRecoveryCandidateCount: result.pdfRecovery.candidateCount,
      pdfRecoverySucceededCount: result.pdfRecovery.succeededCount,
      pdfRecoveryFailedCount: result.pdfRecovery.failedCount,
      budgetExhausted: result.conversion.budgetExhausted,
      elapsedMs: result.elapsedMs,
    },
  });
  console.log(JSON.stringify({
    ok: result.conversion.ok,
    executionId: workerId,
    serviceRevision,
    ...result,
  }));
  if (!result.conversion.ok) process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeDeepAnalysisWorkerHeartbeat(db, {
    workerId,
    serviceRevision,
    modelPolicyVersion: policy.modelPolicyVersion,
    status: "degraded",
    lastErrorCode: "input_preparation_failed",
    metadata: {
      role: "input_preparation",
      phase: "failed",
      error: message.slice(0, 500),
    },
  });
  throw error;
} finally {
  await closeCunoteDb();
}
