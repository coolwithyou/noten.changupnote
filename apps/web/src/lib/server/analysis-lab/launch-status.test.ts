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
    applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v10",
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
assert.deepEqual(status.trackSummary, {
  matching: {
    ready: 0,
    conditional: 0,
    held: 0,
    unverified: 2,
    reused: 0,
    attentionGrantIds: [],
  },
  authoring: {
    ready: 0,
    held: 0,
    notApplicable: 0,
    notRequested: 0,
    unknown: 2,
    attentionGrantIds: [],
  },
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
  type: "target-ok",
  index: 0,
  total: 2,
  grantId: manifest.targets[0]!.grantId,
  stratum: manifest.targets[0]!.stratum,
  title: "보류 공고",
  durationMs: 60_000,
  costUsd: null,
  cumulativeCostUsd: 0,
  matchingReadiness: "conditional",
  applicationRoundtrip: {
    status: "partial",
    runId: "roundtrip",
    transport: "claude-cli",
    model: "claude-opus-5",
    documentCount: 1,
    sourceCount: 1,
    applicationDocumentCount: 1,
    fieldReadyDocumentCount: 0,
    recognizedFieldCount: 0,
    errorCode: null,
    error: null,
    costUsd: null,
  },
}, new Date("2026-08-18T01:02:00.000Z"));
assert.equal(status.targets[0]!.status, "held");
assert.equal(status.targets[0]!.applicationRoundtripStatus, "partial");
assert.equal(status.targets[0]!.recognizedFieldCount, 0);
assert.equal(status.targets[0]!.featureReadiness?.matching.status, "ready");
assert.equal(status.targets[0]!.featureReadiness?.authoring.status, "held");
assert.equal(status.trackSummary.matching.conditional, 1);
assert.equal(status.trackSummary.authoring.held, 1);
assert.deepEqual(status.trackSummary.authoring.attentionGrantIds, [manifest.targets[0]!.grantId]);

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
      fieldReadyDocumentCount: 0,
      recognizedFieldCount: 0,
      featureReadiness: status.targets[0]!.featureReadiness!,
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
assert.equal(status.targets[0]!.featureReadiness?.matching.status, "ready");
assert.equal(status.targets[0]!.featureReadiness?.authoring.status, "held");
assert.deepEqual(status.trackSummary.matching, {
  ready: 0,
  conditional: 1,
  held: 0,
  unverified: 1,
  reused: 0,
  attentionGrantIds: [],
});
assert.deepEqual(status.trackSummary.authoring, {
  ready: 0,
  held: 1,
  notApplicable: 0,
  notRequested: 0,
  unknown: 1,
  attentionGrantIds: [manifest.targets[0]!.grantId],
});

const matchingOnlyManifest: AnalysisLaunchManifest = {
  ...manifest,
  execution: {
    ...manifest.execution,
    analysisMode: "matching_only",
    withApplicationRoundtrip: false,
    roundtripModel: null,
    applicationFieldAnalysisVersion: null,
  },
};
let matchingOnlyStatus = createAnalysisLaunchStatus({
  grantSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
  manifest: matchingOnlyManifest,
  now: new Date("2026-08-18T02:00:00.000Z"),
});
matchingOnlyStatus = applyAnalysisLaunchEvent(matchingOnlyStatus, {
  type: "target-ok",
  index: 0,
  total: 2,
  grantId: matchingOnlyManifest.targets[0]!.grantId,
  stratum: matchingOnlyManifest.targets[0]!.stratum,
  title: "매칭 단독 공고",
  durationMs: 30_000,
  costUsd: null,
  cumulativeCostUsd: 0,
  matchingReadiness: "ready",
}, new Date("2026-08-18T02:01:00.000Z"));
assert.equal(matchingOnlyStatus.targets[0]!.applicationRoundtripStatus, null);
assert.equal(matchingOnlyStatus.targets[0]!.applicationDocumentCount, null);
assert.equal(matchingOnlyStatus.targets[0]!.fieldReadyDocumentCount, null);
assert.equal(matchingOnlyStatus.targets[0]!.recognizedFieldCount, null);
assert.deepEqual(matchingOnlyStatus.trackSummary.authoring, {
  ready: 0,
  held: 0,
  notApplicable: 0,
  notRequested: 2,
  unknown: 0,
  attentionGrantIds: [],
});

let primaryAttentionStatus = createAnalysisLaunchStatus({
  grantSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  manifest: matchingOnlyManifest,
  now: new Date("2026-08-18T02:10:00.000Z"),
});
primaryAttentionStatus = applyAnalysisLaunchEvent(primaryAttentionStatus, {
  type: "target-held",
  index: 0,
  total: 2,
  grantId: matchingOnlyManifest.targets[0]!.grantId,
  stratum: matchingOnlyManifest.targets[0]!.stratum,
  title: "매칭 보류 공고",
  durationMs: 30_000,
  costUsd: null,
  cumulativeCostUsd: 0,
  matchingReadiness: "deferred",
}, new Date("2026-08-18T02:11:00.000Z"));
primaryAttentionStatus = applyAnalysisLaunchEvent(primaryAttentionStatus, {
  type: "target-held",
  index: 1,
  total: 2,
  grantId: matchingOnlyManifest.targets[1]!.grantId,
  stratum: matchingOnlyManifest.targets[1]!.stratum,
  title: "매칭 미검증 공고",
  durationMs: 30_000,
  costUsd: null,
  cumulativeCostUsd: 0,
}, new Date("2026-08-18T02:12:00.000Z"));
assert.equal(primaryAttentionStatus.trackSummary.matching.held, 1);
assert.equal(primaryAttentionStatus.trackSummary.matching.unverified, 1);
assert.deepEqual(primaryAttentionStatus.trackSummary.matching.attentionGrantIds, [
  matchingOnlyManifest.targets[0]!.grantId,
]);

const applicationOnlyManifest: AnalysisLaunchManifest = {
  ...manifest,
  execution: {
    ...manifest.execution,
    analysisMode: "application_only",
  },
};
let applicationOnlyStatus = createAnalysisLaunchStatus({
  grantSha256: "e".repeat(64),
  manifestSha256: "f".repeat(64),
  manifest: applicationOnlyManifest,
  now: new Date("2026-08-18T03:00:00.000Z"),
});
applicationOnlyStatus = applyAnalysisLaunchEvent(applicationOnlyStatus, {
  type: "target-ok",
  index: 0,
  total: 2,
  grantId: applicationOnlyManifest.targets[0]!.grantId,
  stratum: applicationOnlyManifest.targets[0]!.stratum,
  title: "작성 단독 공고",
  durationMs: 30_000,
  costUsd: null,
  cumulativeCostUsd: 0,
  matchingReadiness: "conditional",
  applicationRoundtrip: {
    status: "complete",
    runId: "roundtrip",
    transport: "claude-cli",
    model: "claude-opus-5",
    documentCount: 1,
    sourceCount: 1,
    applicationDocumentCount: 1,
    fieldReadyDocumentCount: 1,
    recognizedFieldCount: 3,
    errorCode: null,
    error: null,
    costUsd: null,
  },
}, new Date("2026-08-18T03:01:00.000Z"));
assert.equal(applicationOnlyStatus.trackSummary.matching.conditional, 1);
assert.equal(applicationOnlyStatus.trackSummary.matching.reused, 1);
assert.equal(applicationOnlyStatus.trackSummary.authoring.ready, 1);

let failedStatus = createAnalysisLaunchStatus({
  grantSha256: "0".repeat(64),
  manifestSha256: "9".repeat(64),
  manifest,
  now: new Date("2026-08-18T04:00:00.000Z"),
});
failedStatus = applyAnalysisLaunchEvent(failedStatus, {
  type: "target-error",
  index: 0,
  total: 2,
  grantId: manifest.targets[0]!.grantId,
  stratum: manifest.targets[0]!.stratum,
  runSaved: false,
  title: "실패 공고",
  durationMs: 0,
  message: "분류하지 않는 임의 오류",
}, new Date("2026-08-18T04:01:00.000Z"));
assert.equal(failedStatus.summary.failed, 1);
assert.equal(failedStatus.trackSummary.matching.unverified, 2);
assert.equal(failedStatus.trackSummary.authoring.unknown, 2);
assert.deepEqual(failedStatus.trackSummary.matching.attentionGrantIds, []);
assert.deepEqual(failedStatus.trackSummary.authoring.attentionGrantIds, []);

failedStatus = finishAnalysisLaunchStatus({
  status: failedStatus,
  receipt: {
    schema: "analysis-launch-receipt-v1",
    grantSha256: failedStatus.grantSha256,
    manifestSha256: failedStatus.manifestSha256,
    startedAt: failedStatus.startedAt,
    finishedAt: "2026-08-18T04:02:00.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 0, held: 0, failed: 1, skipped: 1 },
    targets: [
      {
        sequence: 0,
        grantId: manifest.targets[0]!.grantId,
        status: "failed",
        runArtifactPath: "failed-run.json",
        runArtifactSha256: "1".repeat(64),
        applicationRoundtripStatus: "complete",
        applicationDocumentCount: 1,
        fieldReadyDocumentCount: 1,
        recognizedFieldCount: 3,
        featureReadiness: {
          schema: "analysis-feature-readiness-v1",
          matching: {
            status: "held",
            sourceDisposition: "ready",
            reasons: ["primary_failed"],
          },
          authoring: {
            status: "ready",
            sourceDisposition: "ready",
            reasons: [],
          },
        },
        error: "primary_failed",
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
  },
  receiptSha256: "2".repeat(64),
});
assert.equal(failedStatus.trackSummary.matching.held, 1);
assert.equal(failedStatus.trackSummary.matching.unverified, 1);
assert.equal(failedStatus.trackSummary.authoring.ready, 1);
assert.equal(failedStatus.trackSummary.authoring.unknown, 1);
assert.deepEqual(failedStatus.trackSummary.matching.attentionGrantIds, [
  manifest.targets[0]!.grantId,
]);

console.log("launch-status.test.ts: all assertions passed");
