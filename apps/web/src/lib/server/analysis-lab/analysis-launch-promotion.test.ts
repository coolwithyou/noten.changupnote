import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { LabReview, LabRun } from "@/lib/server/analysis-lab/lab-contract";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";
import {
  guardAnalysisLaunchPromotionPlan,
  loadAnalysisLaunchPromotionCohort,
  verifyAnalysisLaunchPrimaryMatchingProjection,
} from "./analysis-launch-promotion";
import {
  buildAnalysisLaunchMatchingProjectionBinding,
  buildPrimaryMatchingProjectionSnapshot,
  capturePrimaryMatchingProjectionSnapshot,
  primaryProjectionSource,
} from "./primary-matching-projection";
import {
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchGrant,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import { isVerifiedLocalLabSourceArtifact } from "./promotion-release";
import {
  buildManualConfirmationEvaluationsArtifact,
  manualConfirmationEvaluationSelectionForArtifact,
  type SelectedManualConfirmationEvaluations,
} from "./manual-confirmation-evaluations";

const grantId = "00000000-0000-4000-8000-000000000931";
const runId = "run-2026-08-31T000000.000Z-1a2b3c";
const roundtripRunId = "roundtrip-2026-08-31T000001.000Z-launch";
const inputSha256 = "1".repeat(64);
const attachmentManifestSha256 = "2".repeat(64);
const sourceRevisionSha256 = "3".repeat(64);
const root = await mkdtemp(join(tmpdir(), "cunote-analysis-launch-promotion-"));

try {
  const manifest: AnalysisLaunchManifest = {
    schema: "analysis-launch-manifest-v1",
    preparedAt: "2026-08-31T00:00:00.000Z",
    source: {
      kind: "formal_plan",
      seriesId: "deep-test-launch",
      planSha256: "4".repeat(64),
      planArtifactSha256: "5".repeat(64),
      adoptionManifestSha256: null,
      sequenceFrom: 0,
      sequenceTo: 0,
    },
    execution: {
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      promptVersion: "lab-deep-v21",
      validatorVersion: "deep-analysis-validator-v14",
      packageRuntimeSha256: "6".repeat(64),
      gitShaAtPreparation: "7".repeat(40),
      withApplicationRoundtrip: true,
      roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
      concurrency: 1,
      existingRunPolicy: "skip_existing",
    },
    targets: [{
      sequence: 0,
      grantId,
      stratum: "bizinfo/test",
      inputSha256,
      attachmentManifestSha256,
      inventoryInputSha256: inputSha256,
      inventoryAttachmentManifestSha256: attachmentManifestSha256,
      changedSinceInventory: false,
    }],
  };
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", manifest, root);
  const grant: AnalysisLaunchGrant = {
    schema: "analysis-launch-grant-v1",
    manifestSha256: storedManifest.sha256,
    approvedBy: "owner-standing-approval",
    approvedAt: "2026-08-31T00:00:01.000Z",
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount: 1,
  };
  const storedGrant = await writeAnalysisLaunchArtifact("grants", grant, root);
  const run = fixtureRun();
  const manualReview: LabReview = {
    grantId,
    runId,
    reviewerEmail: "reviewer@example.invalid",
    createdAt: "2026-08-31T00:00:02.500Z",
    updatedAt: "2026-08-31T00:00:02.500Z",
    criterionReviews: [{ criterionIndex: 0, verdict: "correct", note: null }],
    axisReviews: [],
    overallNote: null,
  };
  const manualArtifact = buildManualConfirmationEvaluationsArtifact({
    run,
    review: manualReview,
    questionAuthorEmail: "author@example.invalid",
    createdAt: "2026-08-31T00:00:02.600Z",
    items: [{
      criterionIndex: 0,
      resolutionScope: "per_notice",
      prompt: "검수된 공고별 조건을 충족하나요?",
      options: [
        { value: "yes", label: "충족해요", evaluation: "satisfied" },
        { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" },
        { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
      ],
    }],
  });
  const selectedManual: SelectedManualConfirmationEvaluations = {
    artifact: manualArtifact,
    selection: manualConfirmationEvaluationSelectionForArtifact(manualArtifact),
    path: join(root, "synthetic-confirmation-evaluations.json"),
    legacyShaOnly: false,
  };
  const runPath = join(root, "spike-out", "analysis-lab", "test", "run.json");
  await mkdir(join(root, "spike-out", "analysis-lab", "test"), { recursive: true });
  const runBody = Buffer.from(JSON.stringify(run));
  await writeFile(runPath, runBody);
  const runArtifactSha256 = sha256(runBody);
  const receipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-08-31T00:00:02.000Z",
    finishedAt: "2026-08-31T00:00:03.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: 0,
      grantId,
      status: "publishable",
      runArtifactPath: relative(root, runPath).split(sep).join("/"),
      runArtifactSha256,
      applicationRoundtripStatus: "complete",
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 3,
      error: null,
    }],
  };
  const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
  await writeReviewEvidence({
    root,
    receiptSha256: storedReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath,
    runArtifactSha256,
    policyVersion: "codex-only-v3",
    blocked: false,
  });
  const selectedReviewManifestSha256 = await writeReviewEvidence({
    root,
    receiptSha256: storedReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath,
    runArtifactSha256,
    policyVersion: "codex-only-v5",
    blocked: false,
  });

  const cohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedReceipt.sha256],
    grantIds: [grantId],
    manualConfirmationSelections: [{
      grantId,
      runId,
      revision: selectedManual.selection.revision,
      artifactSha256: selectedManual.selection.artifactSha256,
    }],
    dependencies: {
      repositoryRoot: root,
      resolveManualConfirmationEvaluations: async () => selectedManual,
      loadCurrentGrantEvidence: async () => ({
        sourceRevisionSha256,
        sourceRawSha256: "9".repeat(64),
        inputSha256,
        attachmentManifestSha256,
        status: "open",
        servingState: "visible",
        applicationOpen: true,
        hasDeepAnalysisRun: false,
        hasPromotionItem: false,
        confirmedDuplicate: false,
      }),
    },
  });
  assert.equal(cohort.candidates.length, 1);
  const candidate = cohort.candidates[0]!;
  assert.equal(candidate.plan.origin, "analysis_launch");
  assert.deepEqual(candidate.plan.manualConfirmationEvaluationSelection, selectedManual.selection);
  assert.deepEqual(
    candidate.sourceArtifact.manualConfirmationEvaluationSelection,
    selectedManual.selection,
  );
  assert.equal(candidate.plan.questions[0]?.evaluationContractVersion, "confirmation-evaluation-v2");
  assert.equal(candidate.plan.auditState, "analysis_launch_independent_review");
  assert.ok(candidate.plan.resolutions.every((item) => item.state === "analysis_launch_reviewed"));
  assert.equal(candidate.readiness.disposition, "conditional");
  assert.equal(candidate.readiness.reasons.length, 0);
  assert.equal(candidate.readiness.primaryMatchingProjectionStatus, "unverified");
  assert.deepEqual(candidate.readiness.unresolvedAxes, [{ dimension: "size", status: "ambiguous" }]);
  assert.equal(
    candidate.sourceArtifact.localLabEvidence?.analysisLaunch?.launchReceiptSha256,
    storedReceipt.sha256,
  );
  assert.equal(
    candidate.sourceArtifact.localLabEvidence?.analysisLaunch?.independentReviewManifestSha256,
    selectedReviewManifestSha256,
    "같은 packet coverage면 최신 검수 정책을 선택한다",
  );
  assert.equal(isVerifiedLocalLabSourceArtifact(candidate.sourceArtifact), true);
  const { items: _items, ...v3MissingItems } = candidate.plan.conversion;
  assert.deepEqual(
    guardAnalysisLaunchPromotionPlan(candidate.readiness, {
      criteria: candidate.plan.criteria,
      conversion: v3MissingItems,
      ...(candidate.plan.scopeRejectedCriterionIndexes
        ? { scopeRejectedCriterionIndexes: candidate.plan.scopeRejectedCriterionIndexes }
        : {}),
    }),
    {
      ...candidate.readiness,
      disposition: "held",
      reasons: ["promotion_conversion_drop"],
    },
    "analysis-launch 소비자는 v3 item accounting 누락을 fail-closed한다",
  );

  const projectionSource = primaryProjectionSource({
    runId: run.runId,
    grantId: run.grantId,
    source: run.source,
    sourceId: run.sourceId,
    inputSha256: run.inputSha256,
    attachmentManifestSha256: run.attachmentManifestSha256!,
    criteria: run.criteria,
  });
  const newSnapshot = buildPrimaryMatchingProjectionSnapshot({
    source: projectionSource,
    primaryExtractionAvailable: true,
  });
  const newRun = { ...run, primaryMatchingProjection: newSnapshot };
  const newBinding = buildAnalysisLaunchMatchingProjectionBinding(newSnapshot);
  assert.deepEqual(
    verifyAnalysisLaunchPrimaryMatchingProjection(newRun, {
      grantId,
      primaryMatchingProjection: newBinding,
    }),
    { status: "verified", snapshotSha256: newBinding.snapshotSha256 },
  );
  assert.throws(
    () => verifyAnalysisLaunchPrimaryMatchingProjection(newRun, { grantId }),
    /한쪽 결속/,
    "신규 run snapshot만 있고 receipt binding이 없으면 역사 호환으로 우회하지 않는다",
  );
  assert.throws(
    () => verifyAnalysisLaunchPrimaryMatchingProjection(run, {
      grantId,
      primaryMatchingProjection: newBinding,
    }),
    /한쪽 결속/,
    "receipt binding만 있고 run snapshot이 없어도 거부한다",
  );
  const failedSnapshot = capturePrimaryMatchingProjectionSnapshot({
    source: projectionSource,
    primaryExtractionAvailable: true,
  }, { build: () => { throw new Error("synthetic projection failure"); } });
  assert.throws(
    () => verifyAnalysisLaunchPrimaryMatchingProjection(
      { ...run, primaryMatchingProjection: failedSnapshot },
      { grantId, primaryMatchingProjection: buildAnalysisLaunchMatchingProjectionBinding(failedSnapshot) },
    ),
    /exact binding/,
    "양쪽 hash가 맞아도 명시 failed snapshot은 승격 PASS가 아니다",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("analysis launch promotion tests: ok");

function fixtureRun(): LabRun {
  return {
    runId,
    grantId,
    source: "bizinfo",
    sourceId: "PBLN_ANALYSIS_LAUNCH_TEST",
    title: "analysis launch release",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    transport: "claude-cli",
    promptVersion: "lab-deep-v21",
    startedAt: "2026-08-31T00:00:02.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256,
    sourceRevisionSha256,
    attachmentManifestSha256,
    usage: null,
    costUsd: null,
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [{
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "서울 소재" },
      confidence: 0.9,
      sourceSpan: "서울 소재 기업",
      spanVerified: true,
      note: null,
    }],
    axisAssessments: [{
      dimension: "size",
      status: "ambiguous",
      confidence: 0.5,
      comment: "본문과 구조화 필드 충돌",
    }],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryRepairCount: 0,
    primaryValidationOutcome: "publishable",
    matchingReadiness: "conditional",
    primaryRepairProvenance: {
      deterministicPrimaryRepairCount: 0,
      modelPrimaryRepairCount: 0,
      newIssueAfterRepairCount: 0,
      blockingNewIssueAfterRepairCount: 0,
      sourceIncompleteIssueAfterRepairCount: 0,
    },
    applicationRoundtrip: {
      status: "complete",
      runId: roundtripRunId,
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      documentCount: 1,
      sourceCount: 1,
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 3,
      errorCode: null,
      error: null,
    },
    error: null,
  };
}

async function writeReviewEvidence(input: {
  root: string;
  receiptSha256: string;
  manifestSha256: string;
  grantSha256: string;
  runPath: string;
  runArtifactSha256: string;
  policyVersion: string;
  blocked: boolean;
}): Promise<string> {
  const reviewRoot = join(
    input.root,
    "spike-out",
    "analysis-lab",
    "independent-review",
    input.receiptSha256,
  );
  const packetBody = {
    schema: "independent-ai-review-packet-v2",
    launchReceiptSha256: input.receiptSha256,
    sequence: 0,
    grantId,
    runId,
    runArtifactPath: relative(input.root, input.runPath).split(sep).join("/"),
    runArtifactSha256: input.runArtifactSha256,
  };
  const packetBytes = Buffer.from(JSON.stringify(packetBody));
  const packetSha256 = sha256(packetBytes);
  const packetPath = join(reviewRoot, "packets", `00-${packetSha256}.json`);
  await mkdir(join(reviewRoot, "packets"), { recursive: true });
  await writeFile(packetPath, packetBytes);
  const manifestBody = {
    schema: "independent-ai-review-manifest-v2",
    launchReceiptSha256: input.receiptSha256,
    launchManifestSha256: input.manifestSha256,
    launchGrantSha256: input.grantSha256,
    reviewPolicyVersion: input.policyVersion,
    reviewers: [{
      reviewer: "codex",
      model: "gpt-5.6-sol",
      transport: "codex-cli",
      auth: "chatgpt-subscription",
    }],
    packets: [{
      sequence: 0,
      grantId,
      runId,
      path: relative(input.root, packetPath).split(sep).join("/"),
      sha256: packetSha256,
    }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifestBody));
  const reviewManifestSha256 = sha256(manifestBytes);
  await writeFile(join(reviewRoot, `${reviewManifestSha256}.manifest.json`), manifestBytes);
  const aggregateBody = {
    schema: "independent-ai-review-aggregate-v2",
    manifestSha256: reviewManifestSha256,
    launchReceiptSha256: input.receiptSha256,
    reviewedTargets: 1,
    reviewMode: "codex-only",
    reviewerSummaries: {
      codex: { model: "gpt-5.6-sol", transport: "codex-cli" },
    },
    comparisons: [{ sequence: 0, criterionTotal: 1, axisTotal: 20 }],
    consensus: {
      defects: input.blocked
        ? [{ sequence: 0, classification: "defect", kind: "criterion", key: 0 }]
        : [],
      unresolved: [],
    },
    heldAudit: [],
  };
  const aggregateBytes = Buffer.from(JSON.stringify(aggregateBody));
  const aggregateSha256 = sha256(aggregateBytes);
  const aggregateDir = join(reviewRoot, "review-runs", reviewManifestSha256);
  await mkdir(aggregateDir, { recursive: true });
  await writeFile(join(aggregateDir, `${aggregateSha256}.aggregate.json`), aggregateBytes);
  return reviewManifestSha256;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
