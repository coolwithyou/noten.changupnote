import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";
import { observeAnalysisLaunchExecution } from "./analysis-execution-observation";
import { parseAnalysisExecutionObservationCliArgs } from "./analysis-execution-observation-cli";
import {
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchGrant,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";

const ROOT = await mkdtemp(join(tmpdir(), "cunote-analysis-observation-"));
const GRANT_ID = "00000000-0000-4000-8000-000000000001";
const INPUT_SHA = "1".repeat(64);
const ATTACHMENT_SHA = "2".repeat(64);

assert.deepEqual(
  parseAnalysisExecutionObservationCliArgs([
    `--grant=${"a".repeat(64)}`,
    `--receipts=${"b".repeat(64)},${"c".repeat(64)}`,
  ]),
  {
    grantSha256: "a".repeat(64),
    receiptSha256s: ["b".repeat(64), "c".repeat(64)],
  },
);
assert.throws(
  () => parseAnalysisExecutionObservationCliArgs([
    `--grant=${"a".repeat(64)}`,
    `--receipts=${"b".repeat(64)},${"b".repeat(64)}`,
  ]),
  /인자가 잘못됐습니다/,
);

try {
  await writeFile(join(ROOT, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  const manifest: AnalysisLaunchManifest = {
    schema: "analysis-launch-manifest-v1",
    preparedAt: "2026-09-09T00:00:00.000Z",
    source: {
      kind: "formal_plan",
      seriesId: "observation-fixture",
      planSha256: "3".repeat(64),
      planArtifactSha256: "4".repeat(64),
      adoptionManifestSha256: null,
      sequenceFrom: 0,
      sequenceTo: 0,
    },
    execution: {
      transport: "claude-cli",
      model: "claude-opus-5",
      promptVersion: "fixture-prompt",
      validatorVersion: "fixture-validator",
      packageRuntimeSha256: "5".repeat(64),
      gitShaAtPreparation: "6".repeat(40),
      withApplicationRoundtrip: true,
      roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
      concurrency: 2,
      existingRunPolicy: "skip_existing",
    },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      stratum: "fixture",
      inputSha256: INPUT_SHA,
      attachmentManifestSha256: ATTACHMENT_SHA,
      inventoryInputSha256: INPUT_SHA,
      inventoryAttachmentManifestSha256: ATTACHMENT_SHA,
      changedSinceInventory: false,
    }],
  };
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", manifest, ROOT);
  const grant: AnalysisLaunchGrant = {
    schema: "analysis-launch-grant-v1",
    manifestSha256: storedManifest.sha256,
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-09-09T00:01:00.000Z",
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount: 1,
  };
  const storedGrant = await writeAnalysisLaunchArtifact("grants", grant, ROOT);

  const firstRun = await writeLabRun({
    runId: "run-2026-09-09T000200.000Z-a1b2c3",
    durationMs: 200,
    primaryPassDurations: [70, 50],
    deepCostUsd: 1.5,
    applicationRunId: "roundtrip-2026-09-09T000200.000Z-a1b2c3",
    applicationCostUsd: 0.75,
  });
  await writeRoundtrip({
    parentLabRunId: firstRun.runId,
    runId: "roundtrip-2026-09-09T000200.000Z-a1b2c3",
    durationMs: 150,
    plannerDurationMs: 110,
    requestCount: 2,
  });
  const secondRun = await writeLabRun({
    runId: "run-2026-09-09T000400.000Z-d4e5f6",
    durationMs: 300,
    primaryPassDurations: [100],
    deepCostUsd: null,
    applicationRunId: "roundtrip-2026-09-09T000400.000Z-d4e5f6",
    applicationCostUsd: null,
  });
  await writeRoundtrip({
    parentLabRunId: secondRun.runId,
    runId: "roundtrip-2026-09-09T000400.000Z-d4e5f6",
    durationMs: 90,
    plannerDurationMs: 60,
    requestCount: null,
  });
  const firstReceipt = await writeReceipt({
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-09T00:02:00.000Z",
    finishedAt: "2026-09-09T00:02:01.000Z",
    run: firstRun,
    applicationStatus: "complete",
  });
  const secondReceipt = await writeReceipt({
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-09T00:04:00.000Z",
    finishedAt: "2026-09-09T00:04:02.000Z",
    run: secondRun,
    applicationStatus: "complete",
  });
  const failedReceipt = await writeFailedReceipt({
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
  });

  const report = await observeAnalysisLaunchExecution({
    grantSha256: storedGrant.sha256,
    receiptSha256s: [failedReceipt.sha256, secondReceipt.sha256, firstReceipt.sha256],
    repositoryRoot: ROOT,
  });
  assert.equal(report.authority, "derived-from-sealed-launch-and-local-sidecar-observations");
  assert.deepEqual(report.integrity, {
    launchGrantManifestReceiptsAndLabRuns: "exact_sha_bound",
    applicationRoundtripSidecars: "unsealed_local_observation",
  });
  assert.deepEqual(
    report.binding.receiptSha256s,
    [firstReceipt.sha256, secondReceipt.sha256, failedReceipt.sha256],
  );
  assert.deepEqual(report.scope, {
    uniqueTargetCount: 1,
    receiptAttemptCount: 3,
    receiptTargetAttemptCount: 3,
    artifactBackedTargetAttemptCount: 2,
    uniqueArtifactBackedTargetCount: 1,
    unobservedFailedTargetCount: 1,
    skippedTargetCount: 0,
  });
  assert.equal(report.timing.observedReceiptWallMs, 3_500);
  assert.equal(report.timing.observedTargetWallMs, 500);
  assert.equal(report.timing.observedPrimaryPassWorkMs, 220);
  assert.equal(report.timing.primaryPassTelemetryAttemptCount, 2);
  assert.equal(report.timing.observedApplicationRoundtripWallMs, 240);
  assert.equal(report.timing.observedApplicationPlannerWorkMs, 170);
  assert.equal(report.timing.observedApplicationModelRequestCount, 2);
  assert.equal(report.timing.applicationRequestTelemetryAttemptCount, 1);
  assert.equal(report.timing.applicationRequestTelemetryMissingAttemptCount, 2);
  assert.deepEqual(report.timing.queueWait, {
    status: "unverified",
    reason: "target_started_at_not_sealed_in_terminal_receipt",
  });
  assert.deepEqual(report.nominalCost.deepAnalysis, {
    observedSubtotalUsd: 1.5,
    observedAttemptCount: 1,
    missingAttemptCount: 2,
  });
  assert.deepEqual(report.nominalCost.applicationRoundtrip, {
    observedSubtotalUsd: 0.75,
    observedAttemptCount: 1,
    missingAttemptCount: 2,
  });
  assert.equal(report.nominalCost.observedSubtotalUsd, 2.25);
  assert.equal(report.nominalCost.coverageComplete, false);
  assert.equal(report.targetAttempts[0]?.applicationRoundtrip?.locallyObservedAnalysisSha256.length, 64);
  assert.equal(report.targetAttempts[0]?.applicationRoundtrip?.locallyObservedManifestSha256.length, 64);
  assert.equal(report.targetAttempts[0]?.applicationRoundtrip?.hashBinding, "unsealed_local_observation");

  await assert.rejects(
    observeAnalysisLaunchExecution({
      grantSha256: storedGrant.sha256,
      receiptSha256s: [firstReceipt.sha256, firstReceipt.sha256],
      repositoryRoot: ROOT,
    }),
    /중복/,
  );

  const firstRunBytes = await readFile(firstRun.absolutePath);
  await writeFile(firstRun.absolutePath, Buffer.concat([firstRunBytes, Buffer.from("\n")]));
  await assert.rejects(
    observeAnalysisLaunchExecution({
      grantSha256: storedGrant.sha256,
      receiptSha256s: [firstReceipt.sha256],
      repositoryRoot: ROOT,
    }),
    /SHA가 receipt와 다릅니다/,
  );
} finally {
  await rm(ROOT, { recursive: true, force: true });
}

console.log("analysis execution observation tests passed");

async function writeLabRun(input: {
  runId: string;
  durationMs: number;
  primaryPassDurations: number[];
  deepCostUsd: number | null;
  applicationRunId: string | null;
  applicationCostUsd: number | null;
}): Promise<{ runId: string; path: string; absolutePath: string; sha256: string }> {
  const directory = join(ROOT, "spike-out", "analysis-lab", "bizinfo__fixture");
  await mkdir(directory, { recursive: true });
  const absolutePath = join(directory, `${input.runId}.json`);
  const run = {
    runId: input.runId,
    grantId: GRANT_ID,
    source: "bizinfo",
    sourceId: "fixture",
    title: "관측 fixture",
    model: "claude-opus-5",
    promptVersion: "fixture-prompt",
    startedAt: "2026-09-09T00:02:00.000Z",
    durationMs: input.durationMs,
    inputBlocks: [],
    inputTotalChars: 0,
    inputSha256: INPUT_SHA,
    attachmentManifestSha256: ATTACHMENT_SHA,
    usage: null,
    costUsd: input.deepCostUsd,
    analysisMarkdown: "fixture",
    programIntent: null,
    criteria: [],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryPasses: input.primaryPassDurations.map((durationMs) => ({
      kind: "primary",
      durationMs,
      issueCodes: [],
    })),
    ...(input.applicationRunId
      ? {
          applicationRoundtrip: {
            status: "complete",
            runId: input.applicationRunId,
            transport: "claude-cli",
            model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
            documentCount: 1,
            sourceCount: 1,
            applicationDocumentCount: 1,
            fieldReadyDocumentCount: 1,
            recognizedFieldCount: 1,
            errorCode: null,
            error: null,
            costUsd: input.applicationCostUsd,
          },
        }
      : {}),
    error: null,
  };
  const bytes = Buffer.from(`${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(absolutePath, bytes);
  return {
    runId: input.runId,
    path: relative(ROOT, absolutePath).split(sep).join("/"),
    absolutePath,
    sha256: sha256(bytes),
  };
}

async function writeRoundtrip(input: {
  parentLabRunId: string;
  runId: string;
  durationMs: number;
  plannerDurationMs: number;
  requestCount: number | null;
}): Promise<void> {
  const directory = join(
    ROOT,
    "spike-out",
    "analysis-lab",
    "application-roundtrip",
    "bizinfo__fixture",
    input.runId,
  );
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "analysis.json"), JSON.stringify({
      version: APPLICATION_ROUNDTRIP_VERSION,
      runId: input.runId,
      grantId: GRANT_ID,
      source: "bizinfo",
      sourceId: "fixture",
      title: "관측 fixture",
      engine: "kordoc",
      engineVersion: "fixture",
      parentLabRunId: input.parentLabRunId,
      startedAt: "2026-09-09T00:02:00.000Z",
      durationMs: input.durationMs,
      documents: [{
        fieldPlanning: {
          durationMs: input.plannerDurationMs,
          ...(input.requestCount === null ? {} : { requestCount: input.requestCount }),
        },
      }],
      recommendedAttachmentId: null,
      recommendationReason: "fixture",
      error: null,
    }, null, 2)),
    writeFile(join(directory, "manifest.json"), JSON.stringify({
      version: 1,
      runId: input.runId,
      grantId: GRANT_ID,
      source: "bizinfo",
      sourceId: "fixture",
      attachments: [],
    }, null, 2)),
  ]);
}

async function writeFailedReceipt(input: {
  grantSha256: string;
  manifestSha256: string;
}): Promise<{ sha256: string }> {
  return writeAnalysisLaunchArtifact("receipts", {
    schema: "analysis-launch-receipt-v1",
    grantSha256: input.grantSha256,
    manifestSha256: input.manifestSha256,
    startedAt: "2026-09-09T00:06:00.000Z",
    finishedAt: "2026-09-09T00:06:00.500Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 0, held: 0, failed: 1, skipped: 0 },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      status: "failed",
      runArtifactPath: null,
      runArtifactSha256: null,
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      error: "fixture failure before artifact persistence",
    }],
  }, ROOT);
}

async function writeReceipt(input: {
  grantSha256: string;
  manifestSha256: string;
  startedAt: string;
  finishedAt: string;
  run: { path: string; sha256: string };
  applicationStatus: string | null;
}): Promise<{ sha256: string }> {
  const receipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: input.grantSha256,
    manifestSha256: input.manifestSha256,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      status: "publishable",
      runArtifactPath: input.run.path,
      runArtifactSha256: input.run.sha256,
      applicationRoundtripStatus: input.applicationStatus,
      applicationDocumentCount: input.applicationStatus ? 1 : null,
      fieldReadyDocumentCount: input.applicationStatus ? 1 : null,
      recognizedFieldCount: input.applicationStatus ? 1 : null,
      error: null,
    }],
  };
  return writeAnalysisLaunchArtifact("receipts", receipt, ROOT);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
