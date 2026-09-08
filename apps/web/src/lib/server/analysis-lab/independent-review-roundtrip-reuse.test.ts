import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import {
  analysisLaunchArtifactPath,
  createIndependentReviewRepairAnalysisLaunchManifest,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchApplicationRoundtripReuseBinding,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import { verifyIndependentReviewApplicationRoundtripReuseBinding } from "./independent-review-repair-launch-production";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const GRANT_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_RUN_ID = "run-2026-09-09T000000.000Z-a1b2c3";
const ROUNDTRIP_RUN_ID = "roundtrip-2026-09-09T000000.000Z-a1b2c3";
const SOURCE_SEQUENCE = 7;
const root = await mkdtemp(join(tmpdir(), "cunote-independent-reuse-"));

try {
  const reviewDir = join(root, "spike-out", "analysis-lab", "independent-review", "fixture");
  const sourceRunPath = join(root, "spike-out", "analysis-lab", "source-run.json");
  await mkdir(reviewDir, { recursive: true });
  await mkdir(dirname(sourceRunPath), { recursive: true });

  const sourceRunBytes = Buffer.from(JSON.stringify({
    runId: SOURCE_RUN_ID,
    grantId: GRANT_ID,
    source: "kstartup",
    sourceId: "fixture-source",
    inputSha256: SHA_A,
    attachmentManifestSha256: SHA_B,
    criteria: [{}],
    axisAssessments: [],
    applicationRoundtrip: {
      status: "complete",
      runId: ROUNDTRIP_RUN_ID,
      transport: "claude-cli",
      model: "claude-opus-5",
      documentCount: 1,
      sourceCount: 1,
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 1,
      errorCode: null,
      error: null,
      remainingUnresolvedCandidateCount: 0,
    },
  }), "utf8");
  await writeFile(sourceRunPath, sourceRunBytes);
  const sourceRunSha256 = sha256(sourceRunBytes);
  const sourceRunArtifactPath = repositoryPath(root, sourceRunPath);

  const sourceReceipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: SHA_A,
    manifestSha256: SHA_B,
    startedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: "2026-09-09T00:01:00.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: SOURCE_SEQUENCE,
      grantId: GRANT_ID,
      status: "publishable",
      runArtifactPath: sourceRunArtifactPath,
      runArtifactSha256: sourceRunSha256,
      applicationRoundtripStatus: "complete",
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 1,
      error: null,
    }],
  };
  const storedReceipt = await writeAnalysisLaunchArtifact("receipts", sourceReceipt, root);
  const sourceLaunchReceiptSha256 = storedReceipt.sha256;
  assert.equal(
    storedReceipt.path,
    analysisLaunchArtifactPath("receipts", sourceLaunchReceiptSha256, root),
  );

  const packetPath = join(reviewDir, "packet.json");
  const packetBytes = Buffer.from(JSON.stringify({
    schema: "independent-ai-review-packet-v2",
    sequence: SOURCE_SEQUENCE,
    grantId: GRANT_ID,
    runId: SOURCE_RUN_ID,
    launchReceiptSha256: sourceLaunchReceiptSha256,
    launchManifestSha256: SHA_B,
    runArtifactPath: sourceRunArtifactPath,
    runArtifactSha256: sourceRunSha256,
    inputSha256: SHA_A,
  }), "utf8");
  await writeFile(packetPath, packetBytes);
  const packetSha256 = sha256(packetBytes);

  const reviewManifestBase = {
    schema: "independent-ai-review-manifest-v2",
    launchReceiptPath: repositoryPath(root, storedReceipt.path),
    launchReceiptSha256: sourceLaunchReceiptSha256,
    launchManifestSha256: SHA_B,
    launchGrantSha256: SHA_A,
    packets: [{
      sequence: SOURCE_SEQUENCE,
      grantId: GRANT_ID,
      runId: SOURCE_RUN_ID,
      path: repositoryPath(root, packetPath),
      sha256: packetSha256,
    }],
  };
  const reviewManifestBytes = Buffer.from(JSON.stringify(reviewManifestBase), "utf8");
  const reviewManifestSha256 = sha256(reviewManifestBytes);
  const reviewManifestPath = join(reviewDir, `${reviewManifestSha256}.manifest.json`);
  await writeFile(reviewManifestPath, reviewManifestBytes);

  const aggregateBytes = Buffer.from(JSON.stringify({
    schema: "independent-ai-review-aggregate-v2",
    manifestSha256: reviewManifestSha256,
    launchReceiptSha256: sourceLaunchReceiptSha256,
    consensus: {
      defectCount: 1,
      unresolvedCount: 0,
      affectedTargets: [SOURCE_SEQUENCE],
      defects: [{
        sequence: SOURCE_SEQUENCE,
        kind: "criterion",
        key: 0,
        verdict: "needs_edit",
        classification: "defect",
      }],
      unresolved: [],
    },
    admission: {
      reviewedTargetsStatus: "HOLD",
      reasons: ["consensus_defects:1"],
    },
    reviewerSummaries: { codex: { model: "gpt-5.6-sol" } },
    heldAudit: [],
    policy: { databaseWrites: false, promotion: false, deployment: false },
  }), "utf8");
  const aggregateSha256 = sha256(aggregateBytes);
  const aggregatePath = join(reviewDir, `${aggregateSha256}.aggregate.json`);
  await writeFile(aggregatePath, aggregateBytes);

  const reuseBinding: AnalysisLaunchApplicationRoundtripReuseBinding = {
    schema: "analysis-launch-application-roundtrip-reuse-v1",
    sourceSequence: SOURCE_SEQUENCE,
    sourceLabRunId: SOURCE_RUN_ID,
    sourceLabRunArtifactPath: sourceRunArtifactPath,
    sourceLabRunArtifactSha256: sourceRunSha256,
    sourceRoundtripRunId: ROUNDTRIP_RUN_ID,
    analysisArtifactSha256: SHA_A,
    manifestArtifactSha256: SHA_B,
    parsedMarkdown: [{ attachmentId: "attachment-1", sha256: SHA_C }],
    independentReviewAggregatePath: repositoryPath(root, aggregatePath),
    independentReviewAggregateSha256: aggregateSha256,
    independentReviewManifestPath: repositoryPath(root, reviewManifestPath),
    independentReviewManifestSha256: reviewManifestSha256,
    sourceLaunchReceiptSha256,
  };
  const manifest = createIndependentReviewRepairAnalysisLaunchManifest({
    aggregateSha256,
    targets: [{
      originalSequence: SOURCE_SEQUENCE,
      grantId: GRANT_ID,
      source: "kstartup",
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
      reviewRepair: {
        sourceRunId: SOURCE_RUN_ID,
        reviewModel: "gpt-5.6-sol",
        blockingCount: 1,
        taskInstruction: "검수된 primary criterion 결함만 수정",
      },
      applicationRoundtripReuse: reuseBinding,
    }],
    preparedTargets: [{
      grantId: GRANT_ID,
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
    }],
    provenance: {
      gitSha: "1".repeat(40),
      packageRuntimeSha256: SHA_C,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    concurrency: 1,
    now: new Date("2026-09-09T00:02:00.000Z"),
  });
  const target = manifest.targets[0]!;
  await verifyIndependentReviewApplicationRoundtripReuseBinding({ manifest, target, repositoryRoot: root });

  await writeFile(packetPath, Buffer.concat([packetBytes, Buffer.from("\n")]));
  await assert.rejects(
    verifyIndependentReviewApplicationRoundtripReuseBinding({ manifest, target, repositoryRoot: root }),
    /packet SHA/,
    "실행 직전 review packet bytes가 바뀌면 재사용을 거부",
  );
  await writeFile(packetPath, packetBytes);
  await writeFile(sourceRunPath, Buffer.concat([sourceRunBytes, Buffer.from("\n")]));
  await assert.rejects(
    verifyIndependentReviewApplicationRoundtripReuseBinding({ manifest, target, repositoryRoot: root }),
    /LabRun SHA/,
    "실행 직전 원 LabRun bytes가 바뀌면 재사용을 거부",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("independent review roundtrip exact reuse tests: ok");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
