import { and, eq, or } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { prepareDeepAnalysisInput } from "./prepareInput";

const RECOVERY_FIXTURES = [
  { source: "kstartup" as const, sourceId: "178320" },
  { source: "kstartup" as const, sourceId: "178329" },
  { source: "kstartup" as const, sourceId: "178352" },
  { source: "bizinfo" as const, sourceId: "PBLN_000000000121478" },
] as const;

loadMonorepoEnv();
const requireSealed = process.argv.includes("--require-sealed");
const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 configuration is required");
const db = getCunoteDb();

try {
  const grants = await db.select({
    id: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    title: schema.grants.title,
  }).from(schema.grants).where(or(
    and(
      eq(schema.grants.source, "kstartup"),
      or(...RECOVERY_FIXTURES.filter((item) => item.source === "kstartup")
        .map((item) => eq(schema.grants.sourceId, item.sourceId))),
    ),
    and(
      eq(schema.grants.source, "bizinfo"),
      eq(schema.grants.sourceId, "PBLN_000000000121478"),
    ),
  ));
  const results = [];
  for (const grant of grants) {
    const seal = await prepareDeepAnalysisInput({
      db,
      storage,
      grantId: grant.id,
    });
    results.push({
      source: grant.source,
      sourceId: grant.sourceId,
      title: grant.title,
      sealed: seal.sealed,
      sourceRevisionSha256: seal.sourceRevisionSha256,
      attachmentManifestSha256: seal.attachmentManifestSha256,
      inputSha256: seal.inputSha256,
      totalChars: seal.totalChars,
      chunkCount: seal.chunks.length,
      attachments: seal.attachments.map((attachment) => ({
        filename: attachment.filename,
        disposition: attachment.disposition,
        reason: attachment.dispositionReason,
        textChars: attachment.textChars,
        chunkCount: attachment.chunkIds.length,
      })),
      blockers: seal.blockers,
    });
  }
  results.sort((left, right) => (
    `${left.source}:${left.sourceId}`.localeCompare(`${right.source}:${right.sourceId}`)
  ));
  const expectedKeys = new Set(RECOVERY_FIXTURES.map((item) => `${item.source}:${item.sourceId}`));
  for (const result of results) expectedKeys.delete(`${result.source}:${result.sourceId}`);
  const report = {
    schema: "deep-analysis-input-recovery-verification-v1",
    fixtureCount: RECOVERY_FIXTURES.length,
    loadedCount: results.length,
    sealedCount: results.filter((result) => result.sealed).length,
    missingFixtures: [...expectedKeys],
    results,
    passed: expectedKeys.size === 0 && results.every((result) => result.sealed),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (requireSealed && !report.passed) process.exitCode = 2;
} finally {
  await closeCunoteDb();
}
