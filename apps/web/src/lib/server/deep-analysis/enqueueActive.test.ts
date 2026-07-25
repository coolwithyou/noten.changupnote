import assert from "node:assert/strict";
import type { CunoteDbSession } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { sealDeepAnalysisInput } from "./inputManifest";
import { enqueueActiveDeepAnalysisJobs } from "./enqueueActive";
import {
  deepAnalysisClaimCohortSha256,
  resolveDeepAnalysisWorkerPolicy,
} from "./workerPolicy";

const cohortGrantIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const candidates = [
  { grantId: cohortGrantIds[0]!, source: "bizinfo", sourceId: "source-ok" },
  { grantId: cohortGrantIds[1]!, source: "kstartup", sourceId: "source-fail" },
];
const enqueued: string[] = [];
await assert.rejects(
  enqueueActiveDeepAnalysisJobs({
    db: {} as CunoteDbSession,
    storage: {} as R2ObjectStorage,
    policy: resolveDeepAnalysisWorkerPolicy({}),
    listCandidates: async () => {
      throw new Error("must fail before listing candidates");
    },
  }),
  /requires DEEP_ANALYSIS_CLAIM_SCOPE/,
);
const policy = resolveDeepAnalysisWorkerPolicy({
  DEEP_ANALYSIS_MAX_ENQUEUE_JOBS: "2",
  DEEP_ANALYSIS_CLAIM_SCOPE: "bounded",
  DEEP_ANALYSIS_CLAIM_GRANT_IDS: cohortGrantIds.join(","),
  DEEP_ANALYSIS_CLAIM_COHORT_SHA256: deepAnalysisClaimCohortSha256(cohortGrantIds),
});
const result = await enqueueActiveDeepAnalysisJobs({
  db: {} as CunoteDbSession,
  storage: {} as R2ObjectStorage,
  policy,
  now: new Date("2026-07-25T00:00:00.000Z"),
  listCandidates: async (input) => {
    assert.equal(input.limit, 2);
    assert.equal(input.modelPolicyVersion, policy.modelPolicyVersion);
    assert.deepEqual(input.grantIds, cohortGrantIds);
    return candidates;
  },
  prepareInput: async (input) => {
    if (input.grantId === cohortGrantIds[1]) throw new Error("R2 unavailable");
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

assert.deepEqual(enqueued, [cohortGrantIds[0]]);
assert.equal(result.examined, 2);
assert.equal(result.ensured, 1);
assert.equal(result.failed, 1);
assert.deepEqual(result.failures, [{
  grantId: cohortGrantIds[1],
  source: "kstartup",
  sourceId: "source-fail",
  error: "R2 unavailable",
}]);

console.log("deep-analysis active enqueue tests passed");
