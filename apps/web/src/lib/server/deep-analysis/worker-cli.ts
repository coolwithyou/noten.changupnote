import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { enqueueActiveDeepAnalysisJobs } from "./enqueueActive";
import { processDeepAnalysisJob } from "./processor";
import { runDeepAnalysisWorkerInvocation } from "./workerLoop";
import { isProductionDeepAnalysisAllowed } from "./runtimeControl";
import {
  assertDeepAnalysisClaimScopeConfigured,
  resolveDeepAnalysisWorkerPolicy,
} from "./workerPolicy";
import {
  repairGenericDeepAnalysisJobErrorCodes,
  writeDeepAnalysisWorkerHeartbeat,
} from "./workerState";

loadMonorepoEnv();

if (process.env.DEEP_ANALYSIS_EXECUTE !== "1" && !process.argv.includes("--execute")) {
  throw new Error(
    "Deep analysis worker is fail-closed. Set DEEP_ANALYSIS_EXECUTE=1 or pass --execute.",
  );
}
const db = getCunoteDb();
const policy = resolveDeepAnalysisWorkerPolicy();
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
const claimMetadata = {
  claimScope: policy.claimScope,
  claimCohortCount: policy.claimGrantIds.length,
  claimCohortSha256: policy.claimCohortSha256,
};
const modelMetadata = {
  primaryModel: policy.primaryModel,
  primaryEffort: policy.primaryEffort,
  auditModel: policy.auditModel,
  auditEffort: policy.auditEffort,
  adjudicationModel: policy.adjudicationModel,
  adjudicationEffort: policy.adjudicationEffort,
};

try {
  const runtime = await isProductionDeepAnalysisAllowed(db);
  if (policy.executionMode === "observe_only" || !runtime.allowed) {
    const result = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      budgetDeferred: 0,
      releasedBudgetJobs: 0,
      lastFailure: null,
    };
    const metadata = {
      executionMode: policy.executionMode,
      runtimeMode: runtime.control.mode,
      runtimeGeneration: runtime.control.generation,
      runtimeBlocked: !runtime.allowed,
      enqueueSkipped: true,
      analysisSkipped: true,
      budgetMutationSkipped: true,
      ...claimMetadata,
      ...modelMetadata,
      ...result,
    };
    await writeDeepAnalysisWorkerHeartbeat(db, {
      workerId,
      serviceRevision,
      modelPolicyVersion: policy.modelPolicyVersion,
      status: "idle",
      metadata,
      now: new Date(),
    });
    console.log(JSON.stringify({
      ok: true,
      workerId,
      serviceRevision,
      modelPolicyVersion: policy.modelPolicyVersion,
      ...metadata,
    }));
    process.exitCode = 0;
  } else {
    assertDeepAnalysisClaimScopeConfigured(policy);
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 storage environment is incomplete");
    const repairedErrorCodes = await repairGenericDeepAnalysisJobErrorCodes(db);
    const enqueueResult = await enqueueActiveDeepAnalysisJobs({
      db,
      storage,
      policy,
    });
    const result = await runDeepAnalysisWorkerInvocation({
      db,
      workerId,
      serviceRevision,
      policy,
      invocationMetadata: {
        executionMode: policy.executionMode,
        runtimeMode: runtime.control.mode,
        runtimeGeneration: runtime.control.generation,
        ...claimMetadata,
        ...modelMetadata,
        enqueue: enqueueResult,
        repairedErrorCodes,
      },
      processJob: async (job) => {
        await processDeepAnalysisJob({
          db,
          storage,
          apiKey,
          job,
          policy,
          actor: workerId,
        });
      },
    });
    console.log(JSON.stringify({
      ok: true,
      workerId,
      serviceRevision,
      modelPolicyVersion: policy.modelPolicyVersion,
      executionMode: policy.executionMode,
      runtimeMode: runtime.control.mode,
      runtimeGeneration: runtime.control.generation,
      ...claimMetadata,
      ...modelMetadata,
      enqueue: enqueueResult,
      repairedErrorCodes,
      ...result,
    }));
  }
} finally {
  await closeCunoteDb();
}
