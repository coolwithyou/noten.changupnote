import { desc, eq } from "drizzle-orm";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

loadMonorepoEnv();
const jobId = process.argv.find((arg) => arg.startsWith("--job-id="))?.slice("--job-id=".length);
if (!jobId) throw new Error("--job-id=<uuid> is required");
const db = getCunoteDb();
try {
  const [job] = await db.select({
    id: schema.grantDeepAnalysisJobs.id,
    status: schema.grantDeepAnalysisJobs.status,
    attemptCount: schema.grantDeepAnalysisJobs.attemptCount,
    lastErrorCode: schema.grantDeepAnalysisJobs.lastErrorCode,
    lastErrorMessage: schema.grantDeepAnalysisJobs.lastErrorMessage,
  }).from(schema.grantDeepAnalysisJobs)
    .where(eq(schema.grantDeepAnalysisJobs.id, jobId)).limit(1);
  const runs = await db.select({
    id: schema.grantDeepAnalysisRuns.id,
    runId: schema.grantDeepAnalysisRuns.runId,
    status: schema.grantDeepAnalysisRuns.status,
    errorCode: schema.grantDeepAnalysisRuns.errorCode,
    errorMessage: schema.grantDeepAnalysisRuns.errorMessage,
    costUsd: schema.grantDeepAnalysisRuns.costUsd,
  }).from(schema.grantDeepAnalysisRuns)
    .where(eq(schema.grantDeepAnalysisRuns.jobId, jobId))
    .orderBy(desc(schema.grantDeepAnalysisRuns.startedAt));
  const receipts = runs[0]
    ? await db.select({
      stage: schema.grantDeepAnalysisStageReceipts.stage,
      status: schema.grantDeepAnalysisStageReceipts.status,
      evidence: schema.grantDeepAnalysisStageReceipts.evidence,
      artifactKey: schema.grantDeepAnalysisStageReceipts.artifactKey,
    }).from(schema.grantDeepAnalysisStageReceipts)
      .where(eq(schema.grantDeepAnalysisStageReceipts.runId, runs[0].id))
    : [];
  const exceptions = runs[0]
    ? await db.select({
      eventType: schema.grantDeepAnalysisExceptionEvents.eventType,
      reasonCode: schema.grantDeepAnalysisExceptionEvents.reasonCode,
      detail: schema.grantDeepAnalysisExceptionEvents.detail,
    }).from(schema.grantDeepAnalysisExceptionEvents)
      .where(eq(schema.grantDeepAnalysisExceptionEvents.runId, runs[0].id))
    : [];
  const audits = runs[0]
    ? await db.select({
      verdict: schema.grantDeepAnalysisAudits.verdict,
      model: schema.grantDeepAnalysisAudits.model,
      artifactKey: schema.grantDeepAnalysisAudits.artifactKey,
      itemResults: schema.grantDeepAnalysisAudits.itemResults,
    }).from(schema.grantDeepAnalysisAudits)
      .where(eq(schema.grantDeepAnalysisAudits.runId, runs[0].id))
    : [];
  let auditValidationIssues: unknown = null;
  if (process.argv.includes("--with-artifacts") && audits[0]) {
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 storage environment is incomplete");
    const artifact = JSON.parse(await storage.getObjectText(audits[0].artifactKey)) as {
      validation?: { issues?: unknown };
    };
    auditValidationIssues = artifact.validation?.issues ?? null;
  }
  console.log(JSON.stringify({
    job,
    runs,
    receipts,
    audits: audits.map((audit) => ({
      verdict: audit.verdict,
      model: audit.model,
      artifactKey: audit.artifactKey,
      itemCount: audit.itemResults.length,
    })),
    auditValidationIssues,
    exceptions,
  }, null, 2));
} finally {
  await closeCunoteDb();
}
