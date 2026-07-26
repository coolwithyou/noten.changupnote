import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveAggregateSplitWorkerPolicy,
  runAggregateSplitWorkerInvocation,
} from "./aggregateSplitWorker";

loadMonorepoEnv();

if (
  process.env.AGGREGATE_SPLIT_EXECUTE !== "1"
  && !process.argv.includes("--execute")
) {
  throw new Error(
    "Aggregate split worker is fail-closed. "
    + "Set AGGREGATE_SPLIT_EXECUTE=1 or pass --execute.",
  );
}

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");
const db = getCunoteDb();
const workerId = (
  process.env.CLOUD_RUN_EXECUTION
  || process.env.HOSTNAME
  || `local-aggregate-split-${process.pid}`
).slice(0, 200);

try {
  const policy = resolveAggregateSplitWorkerPolicy();
  const result = await runAggregateSplitWorkerInvocation({
    db,
    storage,
    apiKey,
    workerId,
    policy,
  });
  console.log(JSON.stringify({
    ok: result.failed === 0 && result.retryScheduled === 0,
    workerId,
    policy: {
      model: policy.model,
      leaseSeconds: policy.leaseSeconds,
      maxCasesPerInvocation: policy.maxCasesPerInvocation,
      maxCostUsd: policy.maxCostUsd,
      maxChildInputChars: policy.maxChildInputChars,
    },
    ...result,
  }));
  if (result.failed > 0 || result.retryScheduled > 0) process.exitCode = 1;
} finally {
  await closeCunoteDb();
}
