import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveAggregateSplitMaterializationPolicy,
  runAggregateSplitMaterializationInvocation,
} from "./aggregateSplitMaterializationWorker";

loadMonorepoEnv();

if (
  process.env.AGGREGATE_SPLIT_MATERIALIZE_EXECUTE !== "1"
  && !process.argv.includes("--execute")
) {
  throw new Error(
    "Aggregate split materialization is fail-closed. "
    + "Set AGGREGATE_SPLIT_MATERIALIZE_EXECUTE=1 or pass --execute.",
  );
}

const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");
const db = getCunoteDb();
const workerId = (
  process.env.CLOUD_RUN_EXECUTION
  || process.env.HOSTNAME
  || `local-aggregate-materialization-${process.pid}`
).slice(0, 200);

try {
  const policy = resolveAggregateSplitMaterializationPolicy();
  const result = await runAggregateSplitMaterializationInvocation({
    db,
    storage,
    workerId,
    policy,
  });
  console.log(JSON.stringify({
    ok: result.failed === 0 && result.retryScheduled === 0,
    workerId,
    policy,
    ...result,
  }));
  if (result.failed > 0 || result.retryScheduled > 0) process.exitCode = 1;
} finally {
  await closeCunoteDb();
}
