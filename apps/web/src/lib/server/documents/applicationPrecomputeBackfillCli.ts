import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { planApplicationPrecomputeBackfill } from "./applicationPrecomputeQueue";
import { resolveApplicationPrecomputeWorkerPolicy } from "./applicationPrecomputePolicy";

loadMonorepoEnv();

const write = process.argv.includes("--write");
const rawLimit = process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
  throw new Error("--limit must be an integer between 1 and 50");
}

const db = getCunoteDb();
try {
  const policy = resolveApplicationPrecomputeWorkerPolicy();
  const result = await planApplicationPrecomputeBackfill({
    db,
    analysisVersion: policy.analysisVersion,
    limit,
    write,
  });
  console.log(JSON.stringify({ ok: true, mode: write ? "write" : "dry_run", limit, ...result }, null, 2));
} finally {
  await closeCunoteDb();
}
