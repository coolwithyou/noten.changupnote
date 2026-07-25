import { and, eq } from "drizzle-orm";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { enqueueDeepAnalysisJob } from "./ledger";
import { prepareDeepAnalysisInput } from "./prepareInput";
import { resolveDeepAnalysisWorkerPolicy } from "./workerPolicy";

loadMonorepoEnv();

const sourceArg = argValue("--source");
const sourceId = argValue("--source-id");
if (!sourceArg || !sourceId) {
  throw new Error("Usage: deep-analysis:enqueue -- --source=<source> --source-id=<id>");
}
if (!isGrantSource(sourceArg)) throw new Error(`Unknown grant source: ${sourceArg}`);
const source = sourceArg;
const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");
const db = getCunoteDb();
try {
  const [grant] = await db.select({ id: schema.grants.id }).from(schema.grants).where(and(
    eq(schema.grants.source, source),
    eq(schema.grants.sourceId, sourceId),
  )).limit(1);
  if (!grant) throw new Error(`Grant not found: ${source}/${sourceId}`);
  const policy = resolveDeepAnalysisWorkerPolicy();
  const seal = await prepareDeepAnalysisInput({
    db,
    storage,
    grantId: grant.id,
    maxTotalChars: policy.maxTotalInputChars,
  });
  const job = await enqueueDeepAnalysisJob(db, {
    grantId: grant.id,
    sourceRevisionSha256: seal.sourceRevisionSha256,
    modelPolicyVersion: policy.modelPolicyVersion,
    priority: numberArg("--priority", 0),
  });
  const requeue = process.argv.includes("--requeue");
  const queuedJob = requeue && ["dead_letter", "blocked", "pending_budget"].includes(job.status)
    ? (await db.update(schema.grantDeepAnalysisJobs).set({
      status: "pending",
      attemptCount: 0,
      availableAt: new Date(),
      leasedAt: null,
      leaseExpiresAt: null,
      workerId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(schema.grantDeepAnalysisJobs.id, job.id)).returning())[0] ?? job
    : job;
  console.log(JSON.stringify({
    jobId: queuedJob.id,
    grantId: grant.id,
    source,
    sourceId,
    status: queuedJob.status,
    sourceRevisionSha256: seal.sourceRevisionSha256,
    inputSha256: seal.inputSha256,
    sealed: seal.sealed,
    blockerCount: seal.blockers.length,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return value?.trim() || null;
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function isGrantSource(value: string): value is "kstartup" | "bizinfo" | "bizinfo_event" {
  return value === "kstartup" || value === "bizinfo" || value === "bizinfo_event";
}
