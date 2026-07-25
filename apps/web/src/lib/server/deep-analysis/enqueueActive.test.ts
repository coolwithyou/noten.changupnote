import assert from "node:assert/strict";
import type { CunoteDbSession } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { sealDeepAnalysisInput } from "./inputManifest";
import { enqueueActiveDeepAnalysisJobs } from "./enqueueActive";
import { resolveDeepAnalysisWorkerPolicy } from "./workerPolicy";

const candidates = [
  { grantId: "grant-ok", source: "bizinfo", sourceId: "source-ok" },
  { grantId: "grant-fail", source: "kstartup", sourceId: "source-fail" },
];
const enqueued: string[] = [];
const policy = resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_MAX_ENQUEUE_JOBS: "2" });
const result = await enqueueActiveDeepAnalysisJobs({
  db: {} as CunoteDbSession,
  storage: {} as R2ObjectStorage,
  policy,
  now: new Date("2026-07-25T00:00:00.000Z"),
  listCandidates: async (input) => {
    assert.equal(input.limit, 2);
    assert.equal(input.modelPolicyVersion, policy.modelPolicyVersion);
    return candidates;
  },
  prepareInput: async (input) => {
    if (input.grantId === "grant-fail") throw new Error("R2 unavailable");
    return sealDeepAnalysisInput({
      grantId: input.grantId,
      sourceRevisionSha256: "a".repeat(64),
      structuredText: "sealed",
      attachments: [],
    });
  },
  enqueueJob: async (_db, input) => {
    enqueued.push(input.grantId);
    return { id: "job" } as never;
  },
});

assert.deepEqual(enqueued, ["grant-ok"]);
assert.equal(result.examined, 2);
assert.equal(result.ensured, 1);
assert.equal(result.failed, 1);
assert.deepEqual(result.failures, [{
  grantId: "grant-fail",
  source: "kstartup",
  sourceId: "source-fail",
  error: "R2 unavailable",
}]);

console.log("deep-analysis active enqueue tests passed");
