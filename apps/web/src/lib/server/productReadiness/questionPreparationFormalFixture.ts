import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { LabReview, LabRun } from "../analysis-lab/lab-contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";
import {
  loadAnalysisLaunchPromotionCohort,
  type AnalysisLaunchPromotionDependencies,
} from "../analysis-lab/analysis-launch-promotion";
import {
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchGrant,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "../analysis-lab/launch-batch-artifacts";
import type { SelectedManualConfirmationEvaluations } from "../analysis-lab/manual-confirmation-evaluations";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 사람이 아닌 명시적 합성 검수와 immutable receipt를 기존 formal verifier에 공급한다. */
export async function createQuestionPreparationFormalFixture(input: {
  run: LabRun;
  review: LabReview;
  selectedManual: SelectedManualConfirmationEvaluations;
  sourceRevisionSha256: string;
  sourceRawSha256: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "cunote-product-launch-"));
  const { run, review } = input;
  const inputSha256 = run.inputSha256;
  const attachmentManifestSha256 = run.attachmentManifestSha256!;
  const manifest: AnalysisLaunchManifest = {
    schema: "analysis-launch-manifest-v1",
    preparedAt: "2026-09-22T03:00:00.000Z",
    source: {
      kind: "formal_plan", seriesId: "product-test-launch",
      planSha256: "4".repeat(64), planArtifactSha256: "5".repeat(64),
      adoptionManifestSha256: null, sequenceFrom: 0, sequenceTo: 0,
    },
    execution: {
      transport: "claude-cli", model: run.model, promptVersion: run.promptVersion,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      packageRuntimeSha256: "6".repeat(64), gitShaAtPreparation: "7".repeat(40),
      analysisMode: "matching_only", withApplicationRoundtrip: false,
      roundtripModel: null, applicationFieldAnalysisVersion: null,
      concurrency: 1, existingRunPolicy: "skip_existing",
    },
    targets: [{
      sequence: 0, grantId: run.grantId, stratum: "kstartup/test",
      inputSha256, attachmentManifestSha256,
      inventoryInputSha256: inputSha256,
      inventoryAttachmentManifestSha256: attachmentManifestSha256,
      changedSinceInventory: false,
    }],
  };
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", manifest, root);
  const grant: AnalysisLaunchGrant = {
    schema: "analysis-launch-grant-v1", manifestSha256: storedManifest.sha256,
    approvedBy: "synthetic-test-approval", approvedAt: "2026-09-22T03:00:01.000Z",
    scope: "launch-batch-live", stopAfter: "manifest-terminal", targetCount: 1,
  };
  const storedGrant = await writeAnalysisLaunchArtifact("grants", grant, root);
  const runPath = join(root, "spike-out", "analysis-lab", "fixture", "run.json");
  await mkdir(join(root, "spike-out", "analysis-lab", "fixture"), { recursive: true });
  const runBytes = Buffer.from(`${JSON.stringify(run, null, 2)}\n`);
  await writeFile(runPath, runBytes);
  const runSha256 = hash(runBytes);
  const receipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1", grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-22T03:00:02.000Z", finishedAt: "2026-09-22T03:00:03.000Z",
    lifecycle: "finished", stopReason: "completed", systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: 0, grantId: run.grantId, status: "publishable",
      runArtifactPath: relative(root, runPath).split(sep).join("/"),
      runArtifactSha256: runSha256,
      applicationRoundtripStatus: null, applicationDocumentCount: null,
      fieldReadyDocumentCount: null, recognizedFieldCount: null, error: null,
      featureReadiness: {
        schema: "analysis-feature-readiness-v1",
        matching: { status: "ready", sourceDisposition: "conditional", reasons: [] },
        authoring: { status: "held", sourceDisposition: "unverified",
          reasons: ["application_field_analysis_unverified"] },
      },
    }],
  };
  const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
  await writeIndependentReview({
    root, receiptSha256: storedReceipt.sha256,
    manifestSha256: storedManifest.sha256, grantSha256: storedGrant.sha256,
    runPath, runSha256, grantId: run.grantId, runId: run.runId,
  });
  const dependencies: AnalysisLaunchPromotionDependencies = {
    repositoryRoot: root,
    resolveManualConfirmationEvaluations: async () => input.selectedManual,
    loadCurrentGrantEvidence: async (currentRun) => {
      assert.equal(currentRun.grantId, run.grantId);
      return {
        sourceRevisionSha256: input.sourceRevisionSha256,
        sourceRawSha256: input.sourceRawSha256,
        inputSha256, attachmentManifestSha256,
        status: "open", servingState: "visible", applicationOpen: true,
        hasDeepAnalysisRun: false, hasPromotionItem: false, confirmedDuplicate: false,
      };
    },
  };
  const cohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedReceipt.sha256], grantIds: [run.grantId],
    manualConfirmationSelections: [{
      grantId: run.grantId, runId: run.runId,
      revision: input.selectedManual.selection.revision,
      artifactSha256: input.selectedManual.selection.artifactSha256,
    }],
    dependencies,
  });
  assert.equal(cohort.candidates.length, 1);
  return { root, candidate: cohort.candidates[0]!, dependencies };
}

async function writeIndependentReview(input: {
  root: string; receiptSha256: string; manifestSha256: string; grantSha256: string;
  runPath: string; runSha256: string; grantId: string; runId: string;
}): Promise<void> {
  const reviewRoot = join(input.root, "spike-out", "analysis-lab", "independent-review", input.receiptSha256);
  const packet = {
    schema: "independent-ai-review-packet-v2", launchReceiptSha256: input.receiptSha256,
    sequence: 0, grantId: input.grantId, runId: input.runId,
    runArtifactPath: relative(input.root, input.runPath).split(sep).join("/"),
    runArtifactSha256: input.runSha256,
  };
  const packetBytes = Buffer.from(JSON.stringify(packet));
  const packetSha256 = hash(packetBytes);
  const packetPath = join(reviewRoot, "packets", `00-${packetSha256}.json`);
  await mkdir(join(reviewRoot, "packets"), { recursive: true });
  await writeFile(packetPath, packetBytes);
  const manifest = {
    schema: "independent-ai-review-manifest-v2", launchReceiptSha256: input.receiptSha256,
    launchManifestSha256: input.manifestSha256, launchGrantSha256: input.grantSha256,
    reviewPolicyVersion: "codex-only-v5",
    reviewers: [{ reviewer: "codex", model: "gpt-5.6-sol", transport: "codex-cli", auth: "chatgpt-subscription" }],
    packets: [{ sequence: 0, grantId: input.grantId, runId: input.runId,
      path: relative(input.root, packetPath).split(sep).join("/"), sha256: packetSha256 }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const reviewManifestSha256 = hash(manifestBytes);
  await writeFile(join(reviewRoot, `${reviewManifestSha256}.manifest.json`), manifestBytes);
  const aggregate = {
    schema: "independent-ai-review-aggregate-v2", manifestSha256: reviewManifestSha256,
    launchReceiptSha256: input.receiptSha256, reviewedTargets: 1,
    reviewMode: "codex-only", reviewerSummaries: {
      codex: { model: "gpt-5.6-sol", transport: "codex-cli" },
    },
    comparisons: [{ sequence: 0, criterionTotal: 1, axisTotal: 20 }],
    consensus: { defects: [], unresolved: [] }, heldAudit: [],
  };
  const aggregateBytes = Buffer.from(JSON.stringify(aggregate));
  const aggregateDir = join(reviewRoot, "review-runs", reviewManifestSha256);
  await mkdir(aggregateDir, { recursive: true });
  await writeFile(join(aggregateDir, `${hash(aggregateBytes)}.aggregate.json`), aggregateBytes);
}
