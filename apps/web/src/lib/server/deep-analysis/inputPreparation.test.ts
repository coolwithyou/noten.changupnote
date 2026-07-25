import assert from "node:assert/strict";
import type { CunoteDb } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveDeepAnalysisInputPreparationPolicy,
  runDeepAnalysisInputPreparation,
  selectArchivesMissingConversionSurface,
  selectRotatingTargetWindow,
} from "./inputPreparation";

const policy = resolveDeepAnalysisInputPreparationPolicy({
  DEEP_ANALYSIS_PREPARE_MAX_GRANTS_PER_SOURCE: "2",
  DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_GRANT: "4",
  DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_SOURCE: "6",
  DEEP_ANALYSIS_PREPARE_CONVERSION_LIMIT: "5",
  DEEP_ANALYSIS_PREPARE_DEADLINE_SECONDS: "120",
});
assert.equal(policy.maxGrantsPerSource, 2);
assert.equal(policy.maxAttachmentsPerGrant, 4);
assert.throws(
  () => resolveDeepAnalysisInputPreparationPolicy({
    DEEP_ANALYSIS_PREPARE_MAX_GRANTS_PER_SOURCE: "0",
  }),
  /between 1 and 20/,
);
assert.deepEqual(
  selectRotatingTargetWindow(["urgent", "a", "b", "c"], 2, new Date(0)),
  ["urgent", "a"],
);
assert.deepEqual(
  selectRotatingTargetWindow(["urgent", "a", "b", "c"], 2, new Date(600_000)),
  ["urgent", "b"],
);
assert.deepEqual(
  selectArchivesMissingConversionSurface([
    { id: "missing", storageKey: "archive/missing.pdf", sha256: "a".repeat(64) },
    { id: "registered", storageKey: "archive/registered.pdf", sha256: "b".repeat(64) },
    { id: "unarchived", storageKey: null, sha256: null },
  ], [
    { sourceAttachment: "archive/registered.pdf" },
  ]).map((archive) => archive.id),
  ["missing"],
  "markdown이 없더라도 이미 surface가 있는 storage identity는 중복 등록하지 않는다",
);

const calls: string[] = [];
const result = await runDeepAnalysisInputPreparation({
  db: {} as CunoteDb,
  storage: {} as R2ObjectStorage,
  policy,
  archiveFetchTimeoutMs: 1_234,
  reprocessMissingMarkdown: true,
  archiveMaxEntries: 20,
  imageOcr: async () => ({
    markdown: "지원대상: 창업기업",
    confidence: 0.9,
    provider: "test",
    converter: "test",
  }),
  imageOcrName: "test",
  now: new Date("2026-07-25T00:00:00.000Z"),
  listTargets: async () => [
    {
      grantId: "grant-k",
      source: "kstartup",
      sourceId: "178001",
      title: "K",
      applyEnd: null,
      jobUpdatedAt: new Date("2026-07-25T00:00:00.000Z"),
      jobStatus: "blocked",
    },
    {
      grantId: "grant-b",
      source: "bizinfo",
      sourceId: "PBLN_1",
      title: "B",
      applyEnd: null,
      jobUpdatedAt: new Date("2026-07-25T00:00:00.000Z"),
      jobStatus: "pending",
    },
  ],
  runKStartupArchive: async (input) => {
    calls.push(
      `k:${input.sourceIds?.join(",")}:${input.maxTotalAttachments}:`
      + `${input.fetchTimeoutMs}:${input.reprocessMissingMarkdown}:`
      + `${input.archiveMaxEntries}:${Boolean(input.imageOcr)}`,
    );
    return {
      succeededCount: 1,
      failedCount: 0,
    } as Awaited<ReturnType<
      NonNullable<Parameters<typeof runDeepAnalysisInputPreparation>[0]["runKStartupArchive"]>
    >>;
  },
  runBizInfoArchive: async (input) => {
    calls.push(
      `b:${input.sourceIds?.join(",")}:${input.maxTotalAttachments}:`
      + `${input.fetchTimeoutMs}:${input.reprocessMissingMarkdown}:`
      + `${input.archiveMaxEntries}:${input.imageOcrName}`,
    );
    return {
      succeededCount: 1,
      failedCount: 0,
    } as Awaited<ReturnType<
      NonNullable<Parameters<typeof runDeepAnalysisInputPreparation>[0]["runBizInfoArchive"]>
    >>;
  },
  registerMissingConversions: async ({ targets }) => {
    calls.push(`r:${targets.map((target) => target.sourceId).join(",")}`);
    return {
      candidateAttachmentCount: 2,
      surfacesUpserted: 2,
      jobsEnqueued: 2,
      cacheHits: 0,
      skipped: 0,
      warnings: [],
    };
  },
  runConversionSweep: async (_db, options) => {
    calls.push(`c:${options?.sourceIds?.join(",")}:${options?.limit}`);
    return {
      ok: true,
      pendingCount: 2,
      previewReady: 2,
      failed: 0,
      stillPending: 0,
      skipped: 0,
      budgetExhausted: false,
      elapsedMs: 1,
      results: [],
    };
  },
  prepareInput: async (input) => ({
    schema: "deep-analysis-input-v1",
    grantId: input.grantId,
    sourceRevisionSha256: "a".repeat(64),
    attachmentManifestSha256: "b".repeat(64),
    inputSha256: "c".repeat(64),
    sealed: input.grantId === "grant-k",
    attachments: [],
    chunks: [],
    blockers: input.grantId === "grant-k"
      ? []
      : [{
        code: "blocked_conversion",
        attachmentId: "attachment",
        message: "pending",
      }],
    totalChars: 1,
    inputArtifactBody: "{}\n",
  }),
  ensurePreparedJob: async (_db, input) => ({
    id: `job-${input.grantId}`,
    status: "pending",
    priority: input.priority,
  }),
});

assert.deepEqual(calls, [
  "k:178001:6:1234:true:20:true",
  "b:PBLN_1:6:1234:true:20:test",
  "r:178001,PBLN_1",
  "c:178001,PBLN_1:5",
]);
assert.equal(result.targetCount, 2);
assert.equal(result.sealedCount, 1);
assert.equal(result.unresolvedCount, 1);
assert.equal(result.after[0]?.queuePriority, 100);
assert.equal(result.after[1]?.queuePriority, null);
assert.deepEqual(result.after[1]?.blockerCodes, ["blocked_conversion"]);
assert.equal(result.conversionRegistration.jobsEnqueued, 2);

let enqueueAttempted = false;
const noEnqueueResult = await runDeepAnalysisInputPreparation({
  db: {} as CunoteDb,
  storage: {} as R2ObjectStorage,
  policy,
  enqueuePreparedJobs: false,
  listTargets: async () => [{
    grantId: "quality-grant",
    source: "kstartup",
    sourceId: "quality-source",
    title: "Quality",
    applyEnd: null,
    jobUpdatedAt: new Date(0),
    jobStatus: "quality_recovery",
  }],
  runKStartupArchive: async () => ({
    succeededCount: 1,
    failedCount: 0,
  }) as Awaited<ReturnType<
    NonNullable<Parameters<typeof runDeepAnalysisInputPreparation>[0]["runKStartupArchive"]>
  >>,
  registerMissingConversions: async () => ({
    candidateAttachmentCount: 0,
    surfacesUpserted: 0,
    jobsEnqueued: 0,
    cacheHits: 0,
    skipped: 0,
    warnings: [],
  }),
  runConversionSweep: async () => ({
    ok: true,
    pendingCount: 0,
    previewReady: 0,
    failed: 0,
    stillPending: 0,
    skipped: 0,
    budgetExhausted: false,
    elapsedMs: 0,
    results: [],
  }),
  prepareInput: async () => ({
    schema: "deep-analysis-input-v1",
    grantId: "quality-grant",
    sourceRevisionSha256: "a".repeat(64),
    attachmentManifestSha256: "b".repeat(64),
    inputSha256: "c".repeat(64),
    sealed: true,
    attachments: [],
    chunks: [],
    blockers: [],
    totalChars: 1,
    inputArtifactBody: "{}\n",
  }),
  ensurePreparedJob: async () => {
    enqueueAttempted = true;
    throw new Error("quality input recovery must not enqueue analysis jobs");
  },
});
assert.equal(noEnqueueResult.sealedCount, 1);
assert.equal(noEnqueueResult.after[0]?.jobId, null);
assert.equal(enqueueAttempted, false);

console.log("deep-analysis input preparation tests passed");
