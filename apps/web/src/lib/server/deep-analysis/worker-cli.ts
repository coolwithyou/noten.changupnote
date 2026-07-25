import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { enqueueActiveDeepAnalysisJobs } from "./enqueueActive";
import { processDeepAnalysisJob } from "./processor";
import { runDeepAnalysisWorkerInvocation } from "./workerLoop";
import { resolveDeepAnalysisWorkerPolicy } from "./workerPolicy";
import {
  repairGenericDeepAnalysisJobErrorCodes,
} from "./workerState";

loadMonorepoEnv();

if (process.env.DEEP_ANALYSIS_EXECUTE !== "1" && !process.argv.includes("--execute")) {
  throw new Error(
    "Deep analysis worker is fail-closed. Set DEEP_ANALYSIS_EXECUTE=1 or pass --execute.",
  );
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");

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

try {
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
    invocationMetadata: { enqueue: enqueueResult, repairedErrorCodes },
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
    enqueue: enqueueResult,
    repairedErrorCodes,
    ...result,
  }));
} finally {
  await closeCunoteDb();
}
