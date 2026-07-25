import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
} from "@cunote/contracts";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES,
  evaluateDeepAnalysisServingObservation,
  verifyDeepAnalysisServingObservationArtifacts,
  type DeepAnalysisServingObservationReceipt,
} from "./servingObservation";
import { sha256Hex, stableJson } from "./sourceRevision";

const start = new Date("2026-07-25T03:05:00.000Z");
const end = new Date("2026-07-25T04:05:00.000Z");
const expectedItems = [
  { promotionItemId: "promotion-item-1", publicRunId: "public-run-1" },
  { promotionItemId: "promotion-item-2", publicRunId: "public-run-2" },
];
const artifactBodies = new Map<string, string>();
const receipts = [
  ...buildExecutionReceipts("monitor-slot-1", start, expectedItems, artifactBodies),
  ...buildExecutionReceipts(
    "monitor-slot-2",
    new Date(start.getTime() + (30 * 60 * 1_000)),
    expectedItems,
    artifactBodies,
  ),
];

const passed = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  cadenceMs: 30 * 60 * 1_000,
  maximumStartDelayMs: 5 * 60 * 1_000,
  minimumWindowMs: 60 * 60 * 1_000,
  expectedItems,
  receipts,
});
assert.equal(passed.verdict, "PASS");
assert.equal(passed.expectedSlots, 2);
assert.equal(passed.evaluatedSlots, 2);
assert.equal(passed.observedScheduledExecutions, 2);
assert.equal(passed.expectedReceipts, 12);
assert.equal(passed.observedReceipts, 12);
assert.deepEqual(passed.failures, []);

const incomplete = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(end.getTime() - 1),
  minimumWindowMs: 60 * 60 * 1_000,
  expectedItems,
  receipts,
});
assert.equal(incomplete.verdict, "FAIL");
assert.equal(incomplete.failures.some((failure) => failure.code === "window_incomplete"), true);

const progress = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(start.getTime() + 60_000),
  minimumWindowMs: 60 * 60 * 1_000,
  expectedItems,
  receipts: receipts.filter((receipt) => receipt.executionId === "monitor-slot-1"),
});
assert.equal(progress.evaluatedSlots, 1);
assert.equal(progress.observedScheduledExecutions, 1);
assert.deepEqual(progress.failures.map((failure) => failure.code), ["window_incomplete"]);

const missingReceipt = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  minimumWindowMs: 60 * 60 * 1_000,
  expectedItems,
  receipts: receipts.filter((receipt) =>
    !(
      receipt.executionId === "monitor-slot-2"
      && receipt.promotionItemId === "promotion-item-2"
      && receipt.stage === "analysis_fresh"
    )),
});
assert.equal(missingReceipt.verdict, "FAIL");
assert.equal(missingReceipt.failures.some((failure) => failure.code === "receipt_missing"), true);

const staleReceipt = receipts.map((receipt) => (
  receipt.executionId === "monitor-slot-1"
    && receipt.promotionItemId === "promotion-item-1"
    && receipt.stage === "analysis_fresh"
    ? {
      ...receipt,
      status: "stale" as const,
    }
    : receipt
));
const stale = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  minimumWindowMs: 60 * 60 * 1_000,
  expectedItems,
  receipts: staleReceipt,
});
assert.equal(stale.verdict, "FAIL");
assert.equal(stale.failures.some((failure) => failure.code === "receipt_not_passed"), true);

const duplicateExecution = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  minimumWindowMs: 60 * 60 * 1_000,
  expectedItems,
  receipts: [
    ...receipts,
    ...buildExecutionReceipts(
      "monitor-slot-1-duplicate",
      new Date(start.getTime() + 20_000),
      expectedItems,
      artifactBodies,
    ),
  ],
});
assert.equal(duplicateExecution.verdict, "FAIL");
assert.equal(
  duplicateExecution.failures.some((failure) =>
    failure.code === "scheduled_execution_duplicate"),
  true,
);

const slowExecution = evaluateDeepAnalysisServingObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  minimumWindowMs: 60 * 60 * 1_000,
  maximumCompletionDelayMs: 10 * 60 * 1_000,
  expectedItems,
  receipts: receipts.map((receipt) => (
    receipt.executionId === "monitor-slot-2"
      && receipt.stage === "analysis_fresh"
      ? { ...receipt, createdAt: new Date(start.getTime() + (41 * 60 * 1_000)) }
      : receipt
  )),
});
assert.equal(slowExecution.verdict, "FAIL");
assert.equal(
  slowExecution.failures.some((failure) => failure.code === "scheduled_execution_slow"),
  true,
);

const storage = createFixtureStorage(artifactBodies);
assert.deepEqual(
  await verifyDeepAnalysisServingObservationArtifacts({
    storage,
    receipts,
    scheduledExecutionIds: passed.scheduledExecutionIds,
    concurrency: 4,
  }),
  [],
);

const tamperedBodies = new Map(artifactBodies);
tamperedBodies.set(receipts[0]!.artifactKey!, "{}\n");
const artifactFailures = await verifyDeepAnalysisServingObservationArtifacts({
  storage: createFixtureStorage(tamperedBodies),
  receipts,
  scheduledExecutionIds: passed.scheduledExecutionIds,
});
assert.equal(
  artifactFailures.some((failure) => failure.code === "artifact_content_mismatch"),
  true,
);

console.log("deep-analysis serving observation tests passed");

function buildExecutionReceipts(
  executionId: string,
  slot: Date,
  items: typeof expectedItems,
  bodies: Map<string, string>,
): DeepAnalysisServingObservationReceipt[] {
  let offsetMs = 5_000;
  return items.flatMap((item) =>
    DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES.map((stage) => {
      const evidence = {
        monitorExecutionId: executionId,
        monitorRuntime: "cloud_run",
        observationMode: "active_monitor",
        promotionItemId: item.promotionItemId,
      };
      const receipt: DeepAnalysisServingObservationReceipt = {
        id: `${executionId}-${item.promotionItemId}-${stage}`,
        executionId,
        promotionItemId: item.promotionItemId,
        publicRunId: item.publicRunId,
        stage,
        status: "passed",
        verifierVersion: DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
        evidence,
        evidenceSha256: sha256Hex(stableJson(evidence)),
        artifactKey: null,
        createdAt: new Date(slot.getTime() + offsetMs),
      };
      offsetMs += 100;
      const body = `${stableJson({
        schema: "deep-analysis-stage-evidence-v1",
        runId: receipt.publicRunId,
        stage: receipt.stage,
        status: receipt.status,
        verifierVersion: receipt.verifierVersion,
        evidence: receipt.evidence,
      })}\n`;
      const contentSha256 = sha256Hex(Buffer.from(body, "utf8"));
      receipt.artifactKey =
        `deep-analysis/test/stage-evidence-${contentSha256}.json`;
      bodies.set(receipt.artifactKey, body);
      return receipt;
    }));
}

function createFixtureStorage(bodies: Map<string, string>): R2ObjectStorage {
  return {
    async getObjectText(key) {
      const value = bodies.get(key);
      if (value === undefined) throw new Error(`missing fixture object ${key}`);
      return value;
    },
    async getObjectBytes(key) {
      const value = bodies.get(key);
      if (value === undefined) throw new Error(`missing fixture object ${key}`);
      return { body: Buffer.from(value, "utf8"), contentType: "application/json" };
    },
    async objectExists(key) {
      return bodies.has(key);
    },
    async putObject() {
      throw new Error("fixture storage is read-only");
    },
    publicUrl(key) {
      return `https://example.invalid/${key}`;
    },
    async presignGetUrl(key) {
      return `https://example.invalid/${key}`;
    },
  };
}
