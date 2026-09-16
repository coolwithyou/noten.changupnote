import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ANALYSIS_LAB_PROMPT_VERSION, type LabRun } from "./lab-contract";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";
import { classifyAnalysisLaunchPromotionReadiness } from "./analysis-launch-promotion";
import { readCompletedAnalysisLaunchArtifacts } from "./completed-analysis-launch-reader";
import {
  analysisLaunchArtifactPath,
  createAnalysisLaunchGrant,
  encodeCanonical,
  normalizeAnalysisLaunchManifest,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";

const GRANT_ID = "00000000-0000-4000-8000-000000000901";
const OTHER_GRANT_ID = "00000000-0000-4000-8000-000000000902";
const INPUT_SHA256 = "1".repeat(64);
const ATTACHMENT_SHA256 = "2".repeat(64);

const REAL_RECEIPTS = [
  "0129b8cfabfad7ba6507b03f035f2255a086b63a8f6b1feac38db75ca09657cf",
  "35b10397e142b4bc851d0886acab3056fd615db4104a9d479664da64e2f30674",
  "4a227717747b93c430559d4828e222cc8db2d450b11097d2f13adf2e28256712",
  "1d51dc26eaff6bed4d49f696cca56c53f0e003352da9fa1cade21a96361fabd7",
] as const;

test("실제 v15/v17 종료 receipts는 target 결과와 terminal repair ancestry를 보존한다", {
  skip: !(await realReceiptsAvailable(process.cwd())),
}, async () => {
  const loaded = await Promise.all(REAL_RECEIPTS.map((launchReceiptSha256) => (
    readCompletedAnalysisLaunchArtifacts({ launchReceiptSha256, repositoryRoot: process.cwd() })
  )));
  assert.deepEqual(
    loaded.map((item) => item.manifest.execution.applicationFieldAnalysisVersion),
    [
      "kordoc-application-roundtrip-v15",
      "kordoc-application-roundtrip-v15",
      "kordoc-application-roundtrip-v17",
      "kordoc-application-roundtrip-v17",
    ],
  );
  assert.equal(loaded[0]!.receipt.stopReason, "systemic-failure");
  assert.equal(loaded[0]!.receipt.summary.publishable, 31);
  assert.equal(loaded[1]!.receipt.summary.skipped, 35);
  assert.equal(loaded[1]!.receipt.summary.publishable, 4);
  assert.equal(Boolean(loaded[2]!.manifest.source.terminalRepair), true);
  assert.equal(loaded[2]!.receipt.summary.publishable, 5);
  assert.equal(loaded[3]!.receipt.summary.publishable, 15);

  for (const index of [0, 2] as const) {
    const source = loaded[index]!;
    const target = source.receipt.targets.find((candidate) => (
      candidate.status === "publishable" && candidate.featureReadiness?.authoring.status === "ready"
    ));
    assert.ok(target?.runArtifactPath && target.runArtifactSha256);
    const run = JSON.parse(await readFile(resolve(process.cwd(), target.runArtifactPath), "utf8")) as LabRun;
    const readiness = classifyAnalysisLaunchPromotionReadiness({
      loaded: {
        launch: {
          receiptSha256: REAL_RECEIPTS[index],
          ...source,
          review: {
            manifestSha256: "7".repeat(64),
            aggregateSha256: "8".repeat(64),
            reviewPolicyVersion: "codex-only-v7",
            packetBySequence: new Map(),
            comparisonBySequence: new Map(),
            blockedSequences: new Set(),
          },
        },
        target,
        run,
        runArtifactSha256: target.runArtifactSha256,
        primaryMatchingProjectionStatus: "unverified",
        primaryMatchingProjectionSnapshotSha256: null,
      },
      current: {
        sourceRevisionSha256: run.sourceRevisionSha256,
        sourceRawSha256: "9".repeat(64),
        inputSha256: run.inputSha256,
        attachmentManifestSha256: run.attachmentManifestSha256!,
        status: "open",
        servingState: "visible",
        applicationOpen: true,
        hasDeepAnalysisRun: false,
        hasPromotionItem: false,
        confirmedDuplicate: false,
      },
    } as Parameters<typeof classifyAnalysisLaunchPromotionReadiness>[0]);
    assert.ok(readiness.disposition === "ready" || readiness.disposition === "conditional");
    assert.deepEqual(readiness.reasons, []);
    assert.equal(readiness.runFeatureReadiness.matching.status, "ready");
    assert.equal(readiness.runFeatureReadiness.authoring.status, "ready");
    assert.equal(readiness.authoringEvidenceStatus, "held");
    assert.deepEqual(readiness.authoringEvidenceReasons, ["application_field_analysis_binding"]);
  }
});

test("현행 완료 계약은 읽되 live normalizer의 역사 계약 거부는 유지한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-completed-launch-reader-"));
  try {
    const current = await fixture(root, {
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
    });
    const loaded = await readCompletedAnalysisLaunchArtifacts({
      launchReceiptSha256: current.receipt.sha256,
      repositoryRoot: root,
    });
    assert.equal(
      loaded.manifest.execution.applicationFieldAnalysisVersion,
      APPLICATION_ROUNDTRIP_VERSION,
    );

    const historical = await fixture(root, {
      promptVersion: "lab-deep-v28",
      validatorVersion: "deep-analysis-validator-v21",
      applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v15",
    });
    assert.throws(
      () => normalizeAnalysisLaunchManifest(historical.manifest),
      /launch source\/existing run 정책 결속/,
      "완료 source 호환성을 신규 live admission으로 승격하지 않는다",
    );
    const historicalLoaded = await readCompletedAnalysisLaunchArtifacts({
      launchReceiptSha256: historical.receipt.sha256,
      repositoryRoot: root,
    });
    assert.equal(
      historicalLoaded.manifest.execution.applicationFieldAnalysisVersion,
      "kordoc-application-roundtrip-v15",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown tuple, modified SHA, unfinished receipt와 target drift를 fail-closed한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-completed-launch-reader-reject-"));
  try {
    const unknown = await fixture(root, {
      promptVersion: "lab-deep-v27",
      validatorVersion: "deep-analysis-validator-v21",
      applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v15",
    });
    await assert.rejects(
      () => readCompletedAnalysisLaunchArtifacts({
        launchReceiptSha256: unknown.receipt.sha256,
        repositoryRoot: root,
      }),
      /launch source\/existing run 정책 결속/,
    );

    const modified = await fixture(root, {
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
    });
    await writeFile(modified.receipt.path, encodeCanonical({
      ...modified.receiptValue,
      finishedAt: "2026-09-16T00:00:04.000Z",
    }));
    await assert.rejects(
      () => readCompletedAnalysisLaunchArtifacts({
        launchReceiptSha256: modified.receipt.sha256,
        repositoryRoot: root,
      }),
      /artifact SHA가 ID와 다릅니다/,
    );
    await writeFile(modified.receipt.path, encodeCanonical(modified.receiptValue));

    const incomplete = await fixture(root, {
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
    });
    const incompleteValue = { ...incomplete.receiptValue, lifecycle: "running" };
    const incompleteBytes = encodeCanonical(incompleteValue);
    const incompleteSha256 = sha256(incompleteBytes);
    const incompletePath = analysisLaunchArtifactPath("receipts", incompleteSha256, root);
    await mkdir(join(root, "spike-out", "analysis-lab", "launch", "receipts"), { recursive: true });
    await writeFile(incompletePath, incompleteBytes);
    await assert.rejects(
      () => readCompletedAnalysisLaunchArtifacts({
        launchReceiptSha256: incompleteSha256,
        repositoryRoot: root,
      }),
      /launch receipt 계약/,
    );

    const driftedReceipt: AnalysisLaunchReceipt = {
      ...incomplete.receiptValue,
      targets: [{ ...incomplete.receiptValue.targets[0]!, grantId: OTHER_GRANT_ID }],
    };
    const drifted = await writeAnalysisLaunchArtifact("receipts", driftedReceipt, root);
    await assert.rejects(
      () => readCompletedAnalysisLaunchArtifacts({
        launchReceiptSha256: drifted.sha256,
        repositoryRoot: root,
      }),
      /receipt target이 manifest exact target과 다릅니다/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(root: string, contract: {
  readonly promptVersion: string;
  readonly validatorVersion: string;
  readonly applicationFieldAnalysisVersion: string;
}) {
  const manifest: AnalysisLaunchManifest = {
    schema: "analysis-launch-manifest-v1",
    preparedAt: "2026-09-16T00:00:00.000Z",
    source: {
      kind: "current_inventory",
      seriesId: "current-reader-test",
      planSha256: "3".repeat(64),
      planArtifactSha256: "3".repeat(64),
      adoptionManifestSha256: null,
      sequenceFrom: 0,
      sequenceTo: 0,
    },
    execution: {
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      promptVersion: contract.promptVersion,
      validatorVersion: contract.validatorVersion,
      packageRuntimeSha256: "4".repeat(64),
      gitShaAtPreparation: "5".repeat(40),
      withApplicationRoundtrip: true,
      roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      applicationFieldAnalysisVersion: contract.applicationFieldAnalysisVersion,
      concurrency: 1,
      existingRunPolicy: "skip_existing",
    },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      stratum: "bizinfo/medium",
      inputSha256: INPUT_SHA256,
      attachmentManifestSha256: ATTACHMENT_SHA256,
      inventoryInputSha256: INPUT_SHA256,
      inventoryAttachmentManifestSha256: ATTACHMENT_SHA256,
      changedSinceInventory: false,
    }],
  };
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", manifest, root);
  const storedGrant = await writeAnalysisLaunchArtifact("grants", createAnalysisLaunchGrant({
    manifestSha256: storedManifest.sha256,
    targetCount: 1,
    approvedBy: "reader-test",
    now: new Date("2026-09-16T00:00:01.000Z"),
  }), root);
  const receiptValue: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-16T00:00:02.000Z",
    finishedAt: "2026-09-16T00:00:03.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      status: "publishable",
      runArtifactPath: "spike-out/analysis-lab/runs/reader-test.json",
      runArtifactSha256: "6".repeat(64),
      applicationRoundtripStatus: "complete",
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 1,
      error: null,
    }],
  };
  const receipt = await writeAnalysisLaunchArtifact("receipts", receiptValue, root);
  return { manifest, receiptValue, receipt };
}

async function realReceiptsAvailable(root: string): Promise<boolean> {
  return (await Promise.all(REAL_RECEIPTS.map(async (sha256) => {
    try {
      await access(analysisLaunchArtifactPath("receipts", sha256, root));
      return true;
    } catch {
      return false;
    }
  }))).every(Boolean);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
