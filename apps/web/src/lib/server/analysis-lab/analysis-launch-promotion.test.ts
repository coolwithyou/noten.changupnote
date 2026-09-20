import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabPrimaryPassDiagnostic,
  type LabPrimaryPassIssue,
  type LabReview,
  type LabRun,
} from "@/lib/server/analysis-lab/lab-contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";
import {
  classifyAnalysisLaunchPromotionReadiness,
  guardAnalysisLaunchPromotionPlan,
  inspectAnalysisLaunchIndependentReview,
  loadAnalysisLaunchPromotionCohort,
  assessIndependentReviewFindingsRisk,
  verifyAnalysisLaunchPrimaryMatchingProjection,
} from "./analysis-launch-promotion";
import { planGrantPromotion } from "./promote";
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
import {
  createPromotionReleaseManifest,
  isVerifiedLocalLabSourceArtifact,
  planSha256,
  validatePromotionReleaseManifest,
} from "./promotion-release";
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
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
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
  await writeReviewManifestOnly({
    root,
    receiptSha256: storedReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath,
    runArtifactSha256,
    policyVersion: "codex-only-v4",
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
  assert.equal(candidate.readiness.runFeatureReadinessVerification, "derived_legacy");
  assert.equal(candidate.readiness.runFeatureReadiness.matching.status, "ready");
  assert.equal(candidate.readiness.runFeatureReadiness.authoring.status, "ready");
  assert.equal(candidate.readiness.authoringEvidenceStatus, "verified");
  assert.deepEqual(candidate.readiness.authoringEvidenceReasons, []);
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

  const classifyFixtureRun = (fixture: LabRun) => classifyAnalysisLaunchPromotionReadiness({
    loaded: {
      launch: {
        receiptSha256: storedReceipt.sha256,
        receipt,
        manifest,
        review: {
          manifestSha256: selectedReviewManifestSha256,
          aggregateSha256: "b".repeat(64),
          reviewPolicyVersion: "codex-only-v3",
          packetBySequence: new Map(),
          comparisonBySequence: new Map(),
          reviewMode: "codex-only",
          findingsBySequence: new Map(),
          heldSequences: new Set(),
        },
      },
      target: receipt.targets[0]!,
      run: fixture,
      runArtifactSha256,
      primaryMatchingProjectionStatus: "unverified",
      primaryMatchingProjectionSnapshotSha256: null,
    },
    current: {
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
    },
  });

  // 실제 과잉 보류 2건의 패스 형태를 오프라인으로 재생한다. immutable 카운터는
  // 그대로 1이지만, 완전한 진단에서 새 issue가 source_incomplete뿐이면 현행 admission은 통과한다.
  const sourceIncompleteHistoricalCases: Array<{
    sourceId: string;
    primary: LabPrimaryPassIssue[];
    repair: LabPrimaryPassIssue[];
  }> = [{
    sourceId: "PBLN_000000000126449",
    primary: [
      diagnosticIssue("source_incomplete", "$.source_limitations[0]"),
      diagnosticIssue("semantic_misattribution", "$.criteria[2]"),
    ],
    repair: [
      diagnosticIssue("source_incomplete", "$.source_limitations[0]"),
      diagnosticIssue("source_incomplete", "$.source_limitations[1]"),
    ],
  }, {
    sourceId: "PBLN_000000000126456",
    primary: [
      diagnosticIssue("source_incomplete", "$.source_limitations[1]"),
      diagnosticIssue("evidence_not_grounded", "$.source_limitations[2].source_ref"),
      diagnosticIssue("logical_conflict", "$.criteria[6]"),
      diagnosticIssue("unresolved_axis", "$.axis_assessments.size", {
        dimension: "size",
        status: "ambiguous",
        comment: "포털 요약과 첨부 자격이 충돌함",
      }),
    ],
    repair: [
      diagnosticIssue("source_incomplete", "$.source_limitations[1]"),
      diagnosticIssue("source_incomplete", "$.source_limitations[2]"),
      diagnosticIssue("unresolved_axis", "$.axis_assessments.size", {
        dimension: "size",
        status: "ambiguous",
        comment: "포털 요약과 첨부 자격이 충돌함",
      }),
    ],
  }];
  for (const historicalCase of sourceIncompleteHistoricalCases) {
    const readiness = classifyFixtureRun({
      ...run,
      sourceId: historicalCase.sourceId,
      primaryRepairCount: 1,
      primaryPasses: [
        diagnosticPass("primary", historicalCase.primary),
        diagnosticPass("repair", historicalCase.repair),
      ],
      primaryRepairProvenance: {
        deterministicPrimaryRepairCount: 0,
        modelPrimaryRepairCount: 1,
        newIssueAfterRepairCount: 1,
        blockingNewIssueAfterRepairCount: 1,
        sourceIncompleteIssueAfterRepairCount: 0,
        terminationReason: "accepted",
      },
    });
    assert.equal(readiness.disposition, "conditional", historicalCase.sourceId);
    assert.deepEqual(readiness.reasons, [], historicalCase.sourceId);
  }

  // repair 중 실제 의미·근거 오류가 새로 유입된 이력은 이후 패스에서 해소됐더라도 계속 차단한다.
  for (const blockingCode of ["semantic_misattribution", "evidence_not_grounded"] as const) {
    const readiness = classifyFixtureRun({
      ...run,
      primaryRepairCount: 2,
      primaryPasses: [
        diagnosticPass("primary", [diagnosticIssue("normalization_drop", "$.criteria[0]")]),
        diagnosticPass("repair", [diagnosticIssue(blockingCode, "$.criteria[0]")]),
        diagnosticPass("repair", []),
      ],
      primaryRepairProvenance: {
        deterministicPrimaryRepairCount: 0,
        modelPrimaryRepairCount: 2,
        newIssueAfterRepairCount: 1,
        blockingNewIssueAfterRepairCount: 1,
        sourceIncompleteIssueAfterRepairCount: 0,
        terminationReason: "accepted",
      },
    });
    assert.equal(readiness.disposition, "held", blockingCode);
    assert.deepEqual(readiness.reasons, ["blocking_new_issue_after_repair"], blockingCode);
  }

  const historicalFeatureReadiness = {
    schema: "analysis-feature-readiness-v1" as const,
    matching: {
      status: "ready" as const,
      sourceDisposition: "conditional" as const,
      reasons: [],
    },
    authoring: {
      status: "ready" as const,
      sourceDisposition: "ready" as const,
      reasons: [],
    },
  };
  const historicalReadiness = classifyAnalysisLaunchPromotionReadiness({
    loaded: {
      launch: {
        receiptSha256: "a".repeat(64),
        receipt,
        manifest: {
          ...manifest,
          execution: {
            ...manifest.execution,
            validatorVersion: "deep-analysis-validator-v21",
            applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v15",
          },
        },
        review: {
          manifestSha256: "c".repeat(64),
          aggregateSha256: "b".repeat(64),
          reviewPolicyVersion: "codex-only-v5",
          packetBySequence: new Map(),
          comparisonBySequence: new Map(),
          reviewMode: "codex-only",
          findingsBySequence: new Map(),
          heldSequences: new Set(),
        },
      },
      target: { ...receipt.targets[0]!, featureReadiness: historicalFeatureReadiness },
      run: {
        ...run,
        applicationRoundtrip: {
          ...run.applicationRoundtrip!,
          version: "kordoc-application-roundtrip-v15",
        },
      },
      runArtifactSha256,
      primaryMatchingProjectionStatus: "unverified",
      primaryMatchingProjectionSnapshotSha256: null,
    },
    current: {
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
    },
  } as Parameters<typeof classifyAnalysisLaunchPromotionReadiness>[0]);
  assert.equal(historicalReadiness.disposition, "conditional");
  assert.deepEqual(historicalReadiness.reasons, []);
  assert.equal(historicalReadiness.runFeatureReadiness.matching.status, "ready");
  assert.equal(historicalReadiness.runFeatureReadiness.authoring.status, "ready");
  assert.equal(historicalReadiness.authoringEvidenceStatus, "held");
  assert.deepEqual(
    historicalReadiness.authoringEvidenceReasons,
    ["application_field_analysis_binding"],
    "manifest와 맞는 역사 authoring 판정은 matching integrity에 쓰되 현행 작성 증거로 승격하지 않는다",
  );

  const authoringHeldRun: LabRun = {
    ...run,
    applicationRoundtrip: {
      ...run.applicationRoundtrip!,
      status: "partial",
      fieldReadyDocumentCount: 0,
      recognizedFieldCount: 0,
    },
  };
  const authoringHeldRunPath = join(root, "spike-out", "analysis-lab", "test", "run-authoring-held.json");
  const authoringHeldRunBody = Buffer.from(JSON.stringify(authoringHeldRun));
  await writeFile(authoringHeldRunPath, authoringHeldRunBody);
  const authoringHeldFeatureReadiness = {
    schema: "analysis-feature-readiness-v1" as const,
    matching: { status: "ready" as const, sourceDisposition: "conditional" as const, reasons: [] },
    authoring: {
      status: "held" as const,
      sourceDisposition: "held" as const,
      reasons: ["application_field_analysis_held"],
    },
  };
  const authoringHeldReceipt: AnalysisLaunchReceipt = {
    ...receipt,
    summary: { publishable: 0, held: 1, failed: 0, skipped: 0 },
    targets: [{
      ...receipt.targets[0]!,
      status: "held",
      runArtifactPath: relative(root, authoringHeldRunPath).split(sep).join("/"),
      runArtifactSha256: sha256(authoringHeldRunBody),
      applicationRoundtripStatus: "partial",
      fieldReadyDocumentCount: 0,
      recognizedFieldCount: 0,
      featureReadiness: authoringHeldFeatureReadiness,
    }],
  };
  const storedAuthoringHeldReceipt = await writeAnalysisLaunchArtifact(
    "receipts",
    authoringHeldReceipt,
    root,
  );
  await writeReviewEvidence({
    root,
    receiptSha256: storedAuthoringHeldReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath: authoringHeldRunPath,
    runArtifactSha256: sha256(authoringHeldRunBody),
    policyVersion: "codex-only-v5",
    blocked: false,
  });
  const matchingOnlyCohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedAuthoringHeldReceipt.sha256],
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
  assert.equal(matchingOnlyCohort.candidates.length, 1);
  assert.equal(matchingOnlyCohort.candidates[0]!.readiness.disposition, "conditional");
  assert.equal(matchingOnlyCohort.candidates[0]!.readiness.reasons.length, 0);
  assert.equal(matchingOnlyCohort.candidates[0]!.readiness.runFeatureReadiness.authoring.status, "held");
  assert.equal(matchingOnlyCohort.candidates[0]!.readiness.authoringEvidenceStatus, "verified");
  const matchingOnlyCandidate = matchingOnlyCohort.candidates[0]!;

  await assert.rejects(() => loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedAuthoringHeldReceipt.sha256],
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
        inputSha256: "f".repeat(64),
        attachmentManifestSha256,
        status: "open",
        servingState: "visible",
        applicationOpen: true,
        hasDeepAnalysisRun: false,
        hasPromotionItem: false,
        confirmedDuplicate: false,
      }),
    },
  }), /input_drift/, "run의 matching-ready projection은 current source admission drift를 우회하지 않는다");

  const matchingOnlyRelease = createPromotionReleaseManifest({
    releaseId: "analysis-launch-matching-only-r1",
    revision: 1,
    createdAt: "2026-08-31T00:05:00.000Z",
    gitCommit: "7".repeat(40),
    buildDigest: "8".repeat(40),
    cohortLabel: "analysis-launch-matching-only",
    canaryGrantIds: [grantId],
    sourceArtifacts: [matchingOnlyCandidate.sourceArtifact],
    plans: [{
      grantId,
      planSha256: planSha256(matchingOnlyCandidate.plan),
      promotionPlan: matchingOnlyCandidate.plan,
      analysisLaunchReadiness: matchingOnlyCandidate.readiness,
      beforeCriteriaSha256: "a".repeat(64),
      beforeQuestionsSha256: "b".repeat(64),
      dedupComponentSha256: "c".repeat(64),
      criteriaCountBefore: 0,
      criteriaCountAfter: matchingOnlyCandidate.plan.criteria.length,
      questionCountAfter: matchingOnlyCandidate.plan.questions.length,
      pendingCount: 0,
      downgradedCount: matchingOnlyCandidate.plan.conversion.downgraded,
      transport: "claude-cli",
      costUsd: null,
    }],
  });
  assert.doesNotThrow(
    () => validatePromotionReleaseManifest(matchingOnlyRelease),
    "작성 held인 matching-only release는 Kordoc 자산을 요구하거나 끼워 넣지 않는다",
  );
  assert.equal(matchingOnlyRelease.sourceArtifacts[0]!.applicationPrecompute, undefined);

  const noApplicationManifest: AnalysisLaunchManifest = {
    ...manifest,
    source: {
      ...manifest.source,
      kind: "authoring_guide_adoption",
      planSha256: "d".repeat(64),
      planArtifactSha256: "d".repeat(64),
      adoptionManifestSha256: "d".repeat(64),
    },
    execution: {
      ...manifest.execution,
      withApplicationRoundtrip: false,
      roundtripModel: null,
      applicationFieldAnalysisVersion: null,
      existingRunPolicy: "rerun_exact_targets",
    },
  };
  const storedNoApplicationManifest = await writeAnalysisLaunchArtifact(
    "manifests",
    noApplicationManifest,
    root,
  );
  const storedNoApplicationGrant = await writeAnalysisLaunchArtifact("grants", {
    ...grant,
    manifestSha256: storedNoApplicationManifest.sha256,
  }, root);
  const { applicationRoundtrip: _applicationRoundtrip, ...noApplicationRunFields } = run;
  const noApplicationRun: LabRun = noApplicationRunFields;
  const noApplicationRunPath = join(root, "spike-out", "analysis-lab", "test", "run-no-application.json");
  const noApplicationRunBody = Buffer.from(JSON.stringify(noApplicationRun));
  await writeFile(noApplicationRunPath, noApplicationRunBody);
  const noApplicationReceipt: AnalysisLaunchReceipt = {
    ...receipt,
    manifestSha256: storedNoApplicationManifest.sha256,
    grantSha256: storedNoApplicationGrant.sha256,
    targets: [{
      ...receipt.targets[0]!,
      runArtifactPath: relative(root, noApplicationRunPath).split(sep).join("/"),
      runArtifactSha256: sha256(noApplicationRunBody),
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      featureReadiness: {
        schema: "analysis-feature-readiness-v1",
        matching: { status: "ready", sourceDisposition: "conditional", reasons: [] },
        authoring: {
          status: "held",
          sourceDisposition: "unverified",
          reasons: ["application_field_analysis_unverified"],
        },
      },
    }],
  };
  const storedNoApplicationReceipt = await writeAnalysisLaunchArtifact("receipts", noApplicationReceipt, root);
  await writeReviewEvidence({
    root,
    receiptSha256: storedNoApplicationReceipt.sha256,
    manifestSha256: storedNoApplicationManifest.sha256,
    grantSha256: storedNoApplicationGrant.sha256,
    runPath: noApplicationRunPath,
    runArtifactSha256: sha256(noApplicationRunBody),
    policyVersion: "codex-only-v5",
    blocked: false,
  });
  const noApplicationCohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedNoApplicationReceipt.sha256],
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
  assert.equal(noApplicationCohort.candidates.length, 1);
  const noApplicationCandidate = noApplicationCohort.candidates[0]!;
  assert.equal(
    noApplicationCandidate.sourceArtifact.localLabEvidence?.analysisLaunch?.applicationFieldAnalysisVersion,
    null,
  );
  assert.equal(noApplicationCandidate.readiness.runFeatureReadiness.matching.status, "ready");
  assert.equal(noApplicationCandidate.readiness.runFeatureReadiness.authoring.status, "held");
  assert.equal(noApplicationCandidate.readiness.applicationRoundtripStatus, null);
  assert.equal(noApplicationCandidate.readiness.applicationRoundtripRunId, null);
  assert.equal(noApplicationCandidate.readiness.applicationDocumentCount, null);
  assert.equal(noApplicationCandidate.readiness.fieldReadyDocumentCount, null);
  assert.equal(noApplicationCandidate.readiness.recognizedFieldCount, null);
  assert.equal(noApplicationCandidate.readiness.authoringEvidenceStatus, "held");
  assert.deepEqual(
    noApplicationCandidate.readiness.authoringEvidenceReasons,
    ["application_field_analysis_unverified"],
  );
  assert.doesNotThrow(() => validatePromotionReleaseManifest(createPromotionReleaseManifest({
    releaseId: "analysis-launch-no-application-r1",
    revision: 1,
    createdAt: "2026-08-31T00:05:30.000Z",
    gitCommit: "7".repeat(40),
    buildDigest: "8".repeat(40),
    cohortLabel: "analysis-launch-no-application",
    canaryGrantIds: [grantId],
    sourceArtifacts: [noApplicationCandidate.sourceArtifact],
    plans: [{
      ...matchingOnlyRelease.plans[0]!,
      planSha256: planSha256(noApplicationCandidate.plan),
      promotionPlan: noApplicationCandidate.plan,
      analysisLaunchReadiness: noApplicationCandidate.readiness,
      criteriaCountAfter: noApplicationCandidate.plan.criteria.length,
      questionCountAfter: noApplicationCandidate.plan.questions.length,
    }],
  })), "역사 no-roundtrip source도 신청서 미실행을 null로 보존한다");

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
  const storedMatchingOnlyManifest = await writeAnalysisLaunchArtifact(
    "manifests",
    matchingOnlyManifest,
    root,
  );
  const storedMatchingOnlyGrant = await writeAnalysisLaunchArtifact("grants", {
    ...grant,
    manifestSha256: storedMatchingOnlyManifest.sha256,
  }, root);
  const matchingOnlyReceipt: AnalysisLaunchReceipt = {
    ...noApplicationReceipt,
    manifestSha256: storedMatchingOnlyManifest.sha256,
    grantSha256: storedMatchingOnlyGrant.sha256,
  };
  const storedMatchingOnlyReceipt = await writeAnalysisLaunchArtifact(
    "receipts",
    matchingOnlyReceipt,
    root,
  );
  await writeReviewEvidence({
    root,
    receiptSha256: storedMatchingOnlyReceipt.sha256,
    manifestSha256: storedMatchingOnlyManifest.sha256,
    grantSha256: storedMatchingOnlyGrant.sha256,
    runPath: noApplicationRunPath,
    runArtifactSha256: sha256(noApplicationRunBody),
    policyVersion: "codex-only-v5",
    blocked: false,
  });
  const explicitMatchingOnlyCohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedMatchingOnlyReceipt.sha256],
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
  const explicitMatchingOnlyCandidate = explicitMatchingOnlyCohort.candidates[0]!;
  assert.equal(explicitMatchingOnlyCandidate.readiness.disposition, "conditional");
  assert.deepEqual(explicitMatchingOnlyCandidate.readiness.reasons, []);
  assert.equal(explicitMatchingOnlyCandidate.readiness.applicationRoundtripStatus, null);
  assert.equal(explicitMatchingOnlyCandidate.readiness.applicationDocumentCount, null);
  assert.equal(explicitMatchingOnlyCandidate.readiness.runFeatureReadiness.matching.status, "ready");
  assert.equal(explicitMatchingOnlyCandidate.readiness.runFeatureReadiness.authoring.status, "held");
  assert.equal(explicitMatchingOnlyCandidate.sourceArtifact.applicationPrecompute, undefined);
  assert.doesNotThrow(() => validatePromotionReleaseManifest(createPromotionReleaseManifest({
    releaseId: "analysis-launch-explicit-matching-only-r1",
    revision: 1,
    createdAt: "2026-08-31T00:05:45.000Z",
    gitCommit: "7".repeat(40),
    buildDigest: "8".repeat(40),
    cohortLabel: "analysis-launch-explicit-matching-only",
    canaryGrantIds: [grantId],
    sourceArtifacts: [explicitMatchingOnlyCandidate.sourceArtifact],
    plans: [{
      ...matchingOnlyRelease.plans[0]!,
      planSha256: planSha256(explicitMatchingOnlyCandidate.plan),
      promotionPlan: explicitMatchingOnlyCandidate.plan,
      analysisLaunchReadiness: explicitMatchingOnlyCandidate.readiness,
      criteriaCountAfter: explicitMatchingOnlyCandidate.plan.criteria.length,
      questionCountAfter: explicitMatchingOnlyCandidate.plan.questions.length,
    }],
  })), "독립 검수 PASS matching-only는 application precompute 없이 release할 수 있다");

  const contradictoryMatchingOnlyReadiness = classifyAnalysisLaunchPromotionReadiness({
    loaded: {
      launch: {
        receiptSha256: storedMatchingOnlyReceipt.sha256,
        receipt: matchingOnlyReceipt,
        manifest: matchingOnlyManifest,
        review: {
          manifestSha256: "c".repeat(64),
          aggregateSha256: "b".repeat(64),
          reviewPolicyVersion: "codex-only-v5",
          packetBySequence: new Map(),
          comparisonBySequence: new Map(),
          reviewMode: "codex-only",
          findingsBySequence: new Map(),
          heldSequences: new Set(),
        },
      },
      target: {
        ...matchingOnlyReceipt.targets[0]!,
        applicationRoundtripStatus: "complete",
      },
      run: noApplicationRun,
      runArtifactSha256: sha256(noApplicationRunBody),
      primaryMatchingProjectionStatus: "unverified",
      primaryMatchingProjectionSnapshotSha256: null,
    },
    current: {
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
    },
  } as Parameters<typeof classifyAnalysisLaunchPromotionReadiness>[0]);
  assert.equal(contradictoryMatchingOnlyReadiness.disposition, "held");
  assert.deepEqual(contradictoryMatchingOnlyReadiness.reasons, ["analysis_mode_binding"]);

  assert.throws(() => validatePromotionReleaseManifest(createPromotionReleaseManifest({
    releaseId: "analysis-launch-authoring-ready-without-evidence-r1",
    revision: 1,
    createdAt: "2026-08-31T00:06:00.000Z",
    gitCommit: "7".repeat(40),
    buildDigest: "8".repeat(40),
    cohortLabel: "analysis-launch-authoring-ready",
    canaryGrantIds: [grantId],
    sourceArtifacts: [candidate.sourceArtifact],
    plans: [{
      ...matchingOnlyRelease.plans[0]!,
      planSha256: planSha256(candidate.plan),
      promotionPlan: candidate.plan,
      analysisLaunchReadiness: candidate.readiness,
      criteriaCountAfter: candidate.plan.criteria.length,
      questionCountAfter: candidate.plan.questions.length,
    }],
  })), /analysis-launch readiness/, "작성 ready source는 검증된 application precompute 누락을 거부한다");

  const { featureReadiness: _featureReadiness, ...legacyHeldTarget } = authoringHeldReceipt.targets[0]!;
  const legacyHeldReceipt: AnalysisLaunchReceipt = {
    ...authoringHeldReceipt,
    targets: [legacyHeldTarget],
  };
  const storedLegacyHeldReceipt = await writeAnalysisLaunchArtifact("receipts", legacyHeldReceipt, root);
  await writeReviewEvidence({
    root,
    receiptSha256: storedLegacyHeldReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath: authoringHeldRunPath,
    runArtifactSha256: sha256(authoringHeldRunBody),
    policyVersion: "codex-only-v5",
    blocked: false,
  });
  await assert.rejects(() => loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [storedLegacyHeldReceipt.sha256],
    grantIds: [grantId],
    dependencies: { repositoryRoot: root },
  }), /independent review manifest/, "feature 부재 legacy held는 매칭 ready 후보로 추정하지 않는다");

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

  await writeReviewEvidence({
    root,
    receiptSha256: storedReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath,
    runArtifactSha256,
    policyVersion: "codex-only-v6",
    blocked: true,
  });
  assert.equal(await inspectAnalysisLaunchIndependentReview({
    launchReceiptSha256: storedReceipt.sha256,
    grantId,
    repositoryRoot: root,
  }), "blocked", "정상 blocked finding은 손상이 아니라 구조화된 보류다");
  await writeFile(runPath, Buffer.from("corrupted-run"));
  await assert.rejects(() => inspectAnalysisLaunchIndependentReview({
    launchReceiptSha256: storedReceipt.sha256,
    grantId,
    repositoryRoot: root,
  }), /run artifact SHA/, "blocked여도 run/packet/hash 손상은 fail-closed한다");
  await writeReviewManifestOnly({
    root,
    receiptSha256: storedReceipt.sha256,
    manifestSha256: storedManifest.sha256,
    grantSha256: storedGrant.sha256,
    runPath,
    runArtifactSha256,
    policyVersion: "codex-only-v7",
  });
  await assert.rejects(() => inspectAnalysisLaunchIndependentReview({
    launchReceiptSha256: storedReceipt.sha256,
    grantId,
    repositoryRoot: root,
  }), /independent review aggregate가 하나로 확정되지 않습니다/,
  "선택된 최신 검수 manifest 자체가 미완료면 fail-closed한다");
} finally {
  await rm(root, { recursive: true, force: true });
}

{
  const base = fixtureRun();
  const runWithRanking = {
    ...base,
    criteria: [
      ...base.criteria,
      {
        dimension: "certification" as const,
        kind: "preferred" as const,
        operator: "in" as const,
        value: { certs: ["벤처기업"] },
        confidence: 0.9,
        sourceSpan: "벤처기업 가점",
        spanVerified: true,
        note: null,
      },
    ],
  };
  const rankingRisk = assessIndependentReviewFindingsRisk({
    run: runWithRanking,
    reviewMode: "codex-only",
    findings: [{
      kind: "criterion",
      key: 1,
      verdict: "wrong",
      classification: "defect",
      codexMatchImpact: "ranking",
      grokMatchImpact: null,
    }],
  });
  assert.equal(rankingRisk.disposition, "conditional");
  assert.deepEqual(rankingRisk.suppressedCriterionIndexes, [1]);
  const plan = planGrantPromotion({
    run: runWithRanking,
    origin: "analysis_launch",
    analysisLaunchReceiptSha256: "d".repeat(64),
    reviewRisk: rankingRisk,
    sidecar: null,
  });
  assert.equal(plan.criteria.length, 1, "launch ranking finding은 실제 promotion 출력에서 제외된다");
  assert.deepEqual(plan.reviewRisk, rankingRisk, "exact aggregate에서 계산한 risk가 plan hash 입력에 남는다");

  const misclassifiedPreferred = assessIndependentReviewFindingsRisk({
    run: runWithRanking,
    reviewMode: "codex-only",
    findings: [{
      kind: "criterion",
      key: 1,
      verdict: "wrong",
      classification: "defect",
      codexMatchImpact: "eligibility",
      grokMatchImpact: null,
    }],
  });
  assert.equal(misclassifiedPreferred.disposition, "blocked");
  assert.deepEqual(misclassifiedPreferred.suppressedCriterionIndexes, []);

  const legacyMissingImpact = assessIndependentReviewFindingsRisk({
    run: runWithRanking,
    reviewMode: "codex-only",
    findings: [{
      kind: "criterion",
      key: 1,
      verdict: "needs_edit",
      classification: "defect",
      codexMatchImpact: null,
      grokMatchImpact: null,
    }],
  });
  assert.equal(legacyMissingImpact.disposition, "blocked");

  const dualDisagreement = assessIndependentReviewFindingsRisk({
    run: runWithRanking,
    reviewMode: "dual-legacy",
    findings: [{
      kind: "criterion",
      key: 1,
      verdict: "wrong",
      classification: "defect",
      codexMatchImpact: "ranking",
      grokMatchImpact: "eligibility",
    }],
  });
  assert.equal(dualDisagreement.disposition, "blocked", "dual impact 불일치는 단일 ranking으로 면제하지 않는다");

  const dualUnresolved = assessIndependentReviewFindingsRisk({
    run: runWithRanking,
    reviewMode: "dual-legacy",
    findings: [{
      kind: "axis",
      key: "region",
      verdict: "confirmed_absent",
      classification: "unresolved",
      codexMatchImpact: "ranking",
      grokMatchImpact: "ranking",
    }],
  });
  assert.equal(dualUnresolved.disposition, "blocked", "unresolved axis는 손상 verdict에도 PASS하지 않는다");

  const legacyRankingAxis = assessIndependentReviewFindingsRisk({
    run: runWithRanking,
    reviewMode: "codex-only",
    findings: [{
      kind: "axis",
      key: "region",
      verdict: "missed_condition",
      classification: "defect",
      codexMatchImpact: "ranking",
      grokMatchImpact: null,
    }],
  });
  assert.equal(legacyRankingAxis.disposition, "conditional", "구조화된 legacy ranking axis는 보존한다");
}

console.log("analysis launch promotion tests: ok");

function diagnosticIssue(
  code: string,
  path: string,
  axis?: NonNullable<LabPrimaryPassIssue["axis"]>,
): LabPrimaryPassIssue {
  return { code, path, message: code, ...(axis ? { axis } : {}) };
}

function diagnosticPass(
  kind: LabPrimaryPassDiagnostic["kind"],
  issues: LabPrimaryPassIssue[],
): LabPrimaryPassDiagnostic {
  return {
    kind,
    durationMs: 1,
    issueCodes: issues.map((issue) => issue.code),
    issueCount: issues.length,
    issues,
    issuesTruncated: false,
  };
}

function fixtureRun(): LabRun {
  return {
    runId,
    grantId,
    source: "bizinfo",
    sourceId: "PBLN_ANALYSIS_LAUNCH_TEST",
    title: "analysis launch release",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    transport: "claude-cli",
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
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
      version: APPLICATION_ROUNDTRIP_VERSION,
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

async function writeReviewManifestOnly(input: {
  root: string;
  receiptSha256: string;
  manifestSha256: string;
  grantSha256: string;
  runPath: string;
  runArtifactSha256: string;
  policyVersion: string;
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
  const manifestBytes = Buffer.from(JSON.stringify({
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
  }));
  const reviewManifestSha256 = sha256(manifestBytes);
  await writeFile(join(reviewRoot, `${reviewManifestSha256}.manifest.json`), manifestBytes);
  await mkdir(join(reviewRoot, "review-runs", reviewManifestSha256), { recursive: true });
  return reviewManifestSha256;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
