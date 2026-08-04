import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  assertApplicationPrecomputePolicyCanExecute,
  resolveApplicationPrecomputeWorkerPolicy,
} from "./applicationPrecomputePolicy";
import { writeApplicationPrecomputeHeartbeat } from "./applicationPrecomputeQueue";
import { runApplicationPrecomputeWorkerInvocation } from "./applicationPrecomputeWorker";

loadMonorepoEnv();

if (process.env.APPLICATION_PRECOMPUTE_EXECUTE !== "1" && !process.argv.includes("--execute")) {
  throw new Error(
    "Application precompute worker is fail-closed. Set APPLICATION_PRECOMPUTE_EXECUTE=1 or pass --execute.",
  );
}

const db = getCunoteDb();
const policy = resolveApplicationPrecomputeWorkerPolicy();
const workerId = (process.env.CLOUD_RUN_EXECUTION || process.env.HOSTNAME || `local-${process.pid}`).slice(0, 200);
const serviceRevision = (process.env.K_REVISION || process.env.GIT_COMMIT_SHA || "local-unversioned").slice(0, 200);

try {
  if (policy.executionMode === "observe_only") {
    const result = { claimed: 0, succeeded: 0, failed: 0, budgetStopped: false, lastErrorCode: null };
    await writeApplicationPrecomputeHeartbeat({
      db,
      workerId,
      serviceRevision,
      analysisVersion: policy.analysisVersion,
      status: "idle",
      metadata: {
        executionMode: policy.executionMode,
        claimScope: policy.claimScope,
        claimCohortCount: policy.claimGrantIds.length,
        model: policy.model,
        transport: "api",
        enqueueSkipped: true,
        analysisSkipped: true,
        budgetMutationSkipped: true,
        ...result,
      },
    });
    console.log(JSON.stringify({ ok: true, workerId, serviceRevision, ...result }));
  } else {
    assertApplicationPrecomputePolicyCanExecute(policy);
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 storage environment is incomplete");
    const result = await runApplicationPrecomputeWorkerInvocation({
      db,
      storage,
      apiKey,
      workerId,
      serviceRevision,
      policy,
    });
    console.log(JSON.stringify({ ok: true, workerId, serviceRevision, ...result }));
  }
} finally {
  await closeCunoteDb();
}
