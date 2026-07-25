import assert from "node:assert/strict";
import type { CunoteDb } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveDeepAnalysisInputPreparationPolicy,
  runDeepAnalysisInputPreparation,
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

const calls: string[] = [];
const result = await runDeepAnalysisInputPreparation({
  db: {} as CunoteDb,
  storage: {} as R2ObjectStorage,
  policy,
  now: new Date("2026-07-25T00:00:00.000Z"),
  listTargets: async () => [
    {
      grantId: "grant-k",
      source: "kstartup",
      sourceId: "178001",
      title: "K",
      applyEnd: null,
      jobUpdatedAt: new Date("2026-07-25T00:00:00.000Z"),
    },
    {
      grantId: "grant-b",
      source: "bizinfo",
      sourceId: "PBLN_1",
      title: "B",
      applyEnd: null,
      jobUpdatedAt: new Date("2026-07-25T00:00:00.000Z"),
    },
  ],
  runKStartupArchive: async (input) => {
    calls.push(`k:${input.sourceIds?.join(",")}:${input.maxTotalAttachments}`);
    return {
      succeededCount: 1,
      failedCount: 0,
    } as Awaited<ReturnType<
      NonNullable<Parameters<typeof runDeepAnalysisInputPreparation>[0]["runKStartupArchive"]>
    >>;
  },
  runBizInfoArchive: async (input) => {
    calls.push(`b:${input.sourceIds?.join(",")}:${input.maxTotalAttachments}`);
    return {
      succeededCount: 1,
      failedCount: 0,
    } as Awaited<ReturnType<
      NonNullable<Parameters<typeof runDeepAnalysisInputPreparation>[0]["runBizInfoArchive"]>
    >>;
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
});

assert.deepEqual(calls, [
  "k:178001:6",
  "b:PBLN_1:6",
  "c:178001,PBLN_1:5",
]);
assert.equal(result.targetCount, 2);
assert.equal(result.sealedCount, 1);
assert.equal(result.unresolvedCount, 1);
assert.deepEqual(result.after[1]?.blockerCodes, ["blocked_conversion"]);

console.log("deep-analysis input preparation tests passed");
