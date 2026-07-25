import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveDeepAnalysisInputPreparationPolicy,
  runDeepAnalysisInputPreparation,
} from "./inputPreparation";

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
try {
  const result = await runDeepAnalysisInputPreparation({
    db,
    storage,
    policy: resolveDeepAnalysisInputPreparationPolicy(),
  });
  console.log(JSON.stringify({
    ok: result.conversion.ok,
    executionId:
      process.env.CLOUD_RUN_EXECUTION
      || process.env.HOSTNAME
      || `local-${process.pid}`,
    serviceRevision:
      process.env.K_REVISION
      || process.env.GIT_COMMIT_SHA
      || "local-unversioned",
    ...result,
  }));
  if (!result.conversion.ok) process.exitCode = 2;
} finally {
  await closeCunoteDb();
}
