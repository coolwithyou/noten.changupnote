import assert from "node:assert/strict";
import {
  applyAnalysisLaunchEvent,
  createAnalysisLaunchStatus,
  finishAnalysisLaunchStatus,
} from "./launch-status";
import type { AnalysisLaunchManifest, AnalysisLaunchReceipt } from "./launch-batch-artifacts";

const manifest: AnalysisLaunchManifest = {
  schema: "analysis-launch-manifest-v1",
  preparedAt: "2026-08-18T00:00:00.000Z",
  source: {
    kind: "formal_plan",
    seriesId: "deep-v24",
    planSha256: "1".repeat(64),
    planArtifactSha256: "2".repeat(64),
    adoptionManifestSha256: null,
    sequenceFrom: 0,
    sequenceTo: 1,
  },
  execution: {
    transport: "claude-cli",
    model: "claude-opus-5",
    promptVersion: "test",
    validatorVersion: "test",
    packageRuntimeSha256: "3".repeat(64),
    gitShaAtPreparation: "4".repeat(40),
    withApplicationRoundtrip: true,
    roundtripModel: "claude-opus-5",
    applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v9",
    concurrency: 2,
    existingRunPolicy: "skip_existing",
  },
  targets: [0, 1].map((sequence) => ({
    sequence,
    grantId: `00000000-0000-4000-8000-00000000000${sequence}`,
    stratum: "kstartup/thin",
    inputSha256: "5".repeat(64),
    attachmentManifestSha256: "6".repeat(64),
    inventoryInputSha256: "5".repeat(64),
    inventoryAttachmentManifestSha256: "6".repeat(64),
    changedSinceInventory: false,
  })),
};

let status = createAnalysisLaunchStatus({
  grantSha256: "7".repeat(64),
  manifestSha256: "8".repeat(64),
  manifest,
  now: new Date("2026-08-18T01:00:00.000Z"),
});
assert.deepEqual(status.summary, {
  pending: 2,
  running: 0,
  publishable: 0,
  held: 0,
  failed: 0,
  skipped: 0,
});

status = applyAnalysisLaunchEvent(status, {
  type: "target-started",
  index: 0,
  total: 2,
  grantId: manifest.targets[0]!.grantId,
  stratum: manifest.targets[0]!.stratum,
}, new Date("2026-08-18T01:01:00.000Z"));
assert.equal(status.targets[0]!.status, "running");

status = applyAnalysisLaunchEvent(status, {
  type: "target-held",
  index: 0,
  total: 2,
  grantId: manifest.targets[0]!.grantId,
  stratum: manifest.targets[0]!.stratum,
  title: "보류 공고",
  durationMs: 60_000,
  costUsd: null,
  cumulativeCostUsd: 0,
  applicationRoundtrip: {
    status: "partial",
    runId: "roundtrip",
    transport: "claude-cli",
    model: "claude-opus-5",
    documentCount: 1,
    sourceCount: 1,
    applicationDocumentCount: 1,
    fieldReadyDocumentCount: 1,
    recognizedFieldCount: 4,
    errorCode: null,
    error: null,
    costUsd: null,
  },
}, new Date("2026-08-18T01:02:00.000Z"));
assert.equal(status.targets[0]!.status, "held");
assert.equal(status.targets[0]!.applicationRoundtripStatus, "partial");
assert.equal(status.targets[0]!.recognizedFieldCount, 4);

const receipt: AnalysisLaunchReceipt = {
  schema: "analysis-launch-receipt-v1",
  grantSha256: status.grantSha256,
  manifestSha256: status.manifestSha256,
  startedAt: status.startedAt,
  finishedAt: "2026-08-18T01:03:00.000Z",
  lifecycle: "finished",
  stopReason: "completed",
  systemicFailure: null,
  summary: { publishable: 0, held: 1, failed: 0, skipped: 1 },
  targets: [
    {
      sequence: 0,
      grantId: manifest.targets[0]!.grantId,
      status: "held",
      runArtifactPath: "run.json",
      runArtifactSha256: "a".repeat(64),
      applicationRoundtripStatus: "partial",
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 4,
      error: null,
    },
    {
      sequence: 1,
      grantId: manifest.targets[1]!.grantId,
      status: "skipped",
      runArtifactPath: null,
      runArtifactSha256: null,
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      error: null,
    },
  ],
};
status = finishAnalysisLaunchStatus({
  status,
  receipt,
  receiptSha256: "b".repeat(64),
});
assert.equal(status.lifecycle, "finished");
assert.equal(status.summary.held, 1);
assert.equal(status.summary.skipped, 1);

console.log("launch-status.test.ts: all assertions passed");
