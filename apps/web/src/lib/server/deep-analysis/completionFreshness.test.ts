import assert from "node:assert/strict";
import {
  ensureDeepAnalysisCompletionInputFresh,
  type DeepAnalysisCompletionFreshnessFailure,
} from "./completionFreshness";

const baseline = {
  sourceRevisionSha256: "a".repeat(64),
  inputSha256: "b".repeat(64),
};

let enqueuedRevision: string | null = null;
const staleFailures: DeepAnalysisCompletionFreshnessFailure[] = [];
await ensureDeepAnalysisCompletionInputFresh({
  baseline,
  loadCurrent: async () => ({ ...baseline, sealed: true }),
  enqueueReplacement: async (current) => {
    enqueuedRevision = current.sourceRevisionSha256;
  },
  markCurrentRunStale: async (failure) => {
    staleFailures.push(failure);
  },
});
assert.equal(enqueuedRevision, null);
assert.equal(staleFailures.length, 0);

const changedRevision = "c".repeat(64);
await assert.rejects(
  ensureDeepAnalysisCompletionInputFresh({
    baseline,
    loadCurrent: async () => ({
      sealed: true,
      sourceRevisionSha256: changedRevision,
      inputSha256: "d".repeat(64),
      privateChunk: "must not be persisted",
    }),
    enqueueReplacement: async (current) => {
      enqueuedRevision = current.sourceRevisionSha256;
    },
    markCurrentRunStale: async (failure) => {
      staleFailures.push(failure);
    },
  }),
  /source_revision_changed,input_changed/,
);
assert.equal(enqueuedRevision, changedRevision);
assert.equal(staleFailures[0]?.errorCode, "source_revision_changed");
assert.deepEqual(
  staleFailures[0]?.reasons,
  ["source_revision_changed", "input_changed"],
);
assert.equal("privateChunk" in staleFailures[0]!.current, false);

enqueuedRevision = null;
staleFailures.length = 0;
await assert.rejects(
  ensureDeepAnalysisCompletionInputFresh({
    baseline,
    loadCurrent: async () => ({
      sealed: true,
      sourceRevisionSha256: baseline.sourceRevisionSha256,
      inputSha256: "e".repeat(64),
    }),
    enqueueReplacement: async (current) => {
      enqueuedRevision = current.sourceRevisionSha256;
    },
    markCurrentRunStale: async (failure) => {
      staleFailures.push(failure);
    },
  }),
  /input_changed/,
);
assert.equal(enqueuedRevision, null);
assert.equal(staleFailures[0]?.errorCode, "input_changed_during_analysis");

console.log("deep-analysis completion freshness tests passed");
