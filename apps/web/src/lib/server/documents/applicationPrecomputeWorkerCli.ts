import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { runApplicationPrecomputeWorkerCycle } from "./applicationPrecomputeWorkerCycle";
import { isProductionDeepAnalysisAllowed } from "@/lib/server/deep-analysis/runtimeControl";

loadMonorepoEnv();

if (process.env.APPLICATION_PRECOMPUTE_EXECUTE !== "1" && !process.argv.includes("--execute")) {
  throw new Error(
    "Application precompute worker is fail-closed. Set APPLICATION_PRECOMPUTE_EXECUTE=1 or pass --execute.",
  );
}

const db = getCunoteDb();
const workerId = (process.env.CLOUD_RUN_EXECUTION || process.env.HOSTNAME || `local-${process.pid}`).slice(0, 200);
const serviceRevision = (process.env.K_REVISION || process.env.GIT_COMMIT_SHA || "local-unversioned").slice(0, 200);

try {
  const runtime = await isProductionDeepAnalysisAllowed(db);
  const result = await runApplicationPrecomputeWorkerCycle({
    db,
    workerId,
    serviceRevision,
    runtimeAllowed: runtime.allowed,
    execute: true,
  });
  console.log(JSON.stringify({
    ok: true,
    workerId,
    serviceRevision,
    runtimeMode: runtime.control.mode,
    runtimeGeneration: runtime.control.generation,
    ...result,
  }));
} finally {
  await closeCunoteDb();
}
