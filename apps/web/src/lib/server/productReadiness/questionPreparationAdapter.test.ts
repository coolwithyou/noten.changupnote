import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromotionReleaseManifest,
  planSha256,
  VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "../analysis-lab/promotion-release";
import {
  questionDefinitionSha256,
  sourceSpanHash,
  type GrantPromotionPlan,
} from "../analysis-lab/promote";
import type { LabRun } from "../analysis-lab/lab-contract";
import { createGrantNextWorkSnapshot } from "./grantNextWorkExecution";
import { createApprovedAnalysisPromotionAdapter, type GrantSupplyAsset } from "./grantSupply";
import {
  bindQuestionPreparationRelease,
  createQuestionPreparationAdapter,
  type ApprovedQuestionPreparationRelease,
  type ApprovedQuestionPreparationReleasePort,
} from "./questionPreparationAdapter";

const GRANT_ID = "10000000-0000-4000-8000-000000000011";
const REVISION = "a".repeat(64);
const RAW = "b".repeat(64);
const RUN_ID = "question-preparation-run-1";
const CRITERION_KEY = "criterion:industry:manual";
const SELECTION_SHA = "c".repeat(64);
const OPTIONS = [
  { value: "yes", label: "해당해요", evaluation: "satisfied" as const },
  { value: "no", label: "해당하지 않아요", evaluation: "unsatisfied" as const },
  { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" as const },
];

function snapshot() {
  return createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    readinessInput: {
      grantId: GRANT_ID,
      source: {
        availability: "available",
        revisionSha256: REVISION,
        rawSha256: RAW,
        attachmentStatus: "not_required",
        attachmentManifestSha256: null,
      },
      analysis: {
        status: "present",
        sourceRevisionSha256: REVISION,
        sourceRawSha256: RAW,
        attachmentManifestSha256: null,
        structure: "complete",
        criteriaReview: "reviewed",
        eligibleQuestionCriterionStableKeys: [CRITERION_KEY],
      },
      questions: [],
    },
  });
}

function missingSnapshot() {
  const current = snapshot();
  return createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    readinessInput: {
      ...current.readinessInput,
      analysis: { ...current.readinessInput.analysis, status: "missing" },
    },
  });
}

function promotionPlan(): GrantPromotionPlan {
  const criterion = {
    id: `${GRANT_ID}:llm-1`,
    dimension: "industry" as const,
    operator: "text_only" as const,
    value: { note: "공고에 열거된 업종" },
    kind: "required" as const,
    confidence: 1,
    source_span: "식품·생활용품·가정용품 분야 중소기업",
    raw_text: "식품·생활용품·가정용품 분야 중소기업",
    source_field: "지원대상",
    needs_review: false,
    parser_version: "fixture-v1",
  };
  const questionBase = {
    criteriaPosition: 0,
    criterionIndex: 0,
    prompt: "귀사는 공고에 열거된 업종에 해당하나요?",
    options: OPTIONS,
    answerType: "single" as const,
    reusable: "per_notice" as const,
    conditionKey: null,
    promptVer: "manual-confirmation-evaluations-revision-v1",
    inline: false,
    provenance: {
      runId: RUN_ID,
      auditState: "analysis_launch_independent_review" as const,
      criterionIndex: 0,
    },
    criterionRef: {
      dimension: "industry",
      kind: "required",
      sourceSpanHash: sourceSpanHash(criterion.source_span),
    },
    criterionStableKey: CRITERION_KEY,
    resolutionState: "analysis_launch_reviewed" as const,
    evaluationContractVersion: "confirmation-evaluation-v2" as const,
    sourceRevisionSha256: REVISION,
    sourceRawSha256: RAW,
  };
  return {
    grantId: GRANT_ID,
    runId: RUN_ID,
    title: "질문 준비 adapter fixture",
    origin: "analysis_launch",
    auditState: "analysis_launch_independent_review",
    criteria: [criterion],
    criterionIndexByPosition: [0],
    criterionStableKeys: [CRITERION_KEY],
    resolutions: [{
      criterionIndex: 0,
      state: "analysis_launch_reviewed",
      decidedBy: "d".repeat(64),
      note: null,
    }],
    conversion: {
      grantId: GRANT_ID,
      runId: RUN_ID,
      verdicts: { correct: 1, needs_edit: 0, wrong: 0, unsure: 0 },
      missedConditions: 0,
      inputRows: 1,
      converted: 1,
      downgraded: 0,
      dropped: 0,
      error: null,
    },
    scopeRejectedCriterionIndexes: [],
    questions: [{
      ...questionBase,
      definitionSha256: questionDefinitionSha256(questionBase),
    }],
    manualConfirmationEvaluationSelection: {
      schema: "manual-confirmation-evaluation-selection-v1",
      revision: 1,
      artifactSha256: SELECTION_SHA,
      itemCount: 1,
      intent: "active",
    },
    droppedQuestionCandidates: 0,
  };
}

function manifest(): PromotionReleaseManifest {
  const plan = promotionPlan();
  const launchReceiptSha256 = "d".repeat(64);
  const aggregateSha256 = "e".repeat(64);
  const attachmentManifestSha256 = "f".repeat(64);
  const inputSha256 = "1".repeat(64);
  const item: PromotionReleasePlanItem = {
    grantId: GRANT_ID,
    planSha256: planSha256(plan),
    promotionPlan: plan,
    analysisLaunchReadiness: {
      schema: "analysis-launch-promotion-readiness-v1",
      disposition: "ready",
      reasons: [],
      unresolvedAxes: [],
      sourceRevisionSha256: REVISION,
      inputSha256,
      attachmentManifestSha256,
      launchReceiptSha256,
      independentReviewAggregateSha256: aggregateSha256,
      applicationRoundtripStatus: null,
      applicationRoundtripRunId: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      runFeatureReadiness: {
        schema: "analysis-feature-readiness-v1",
        matching: { status: "ready", sourceDisposition: "ready", reasons: [] },
        authoring: {
          status: "held",
          sourceDisposition: "not_applicable",
          reasons: ["application_field_analysis_not_applicable"],
        },
      },
      runFeatureReadinessVerification: "verified",
      authoringEvidenceStatus: "held",
      authoringEvidenceReasons: ["application_field_analysis_not_applicable"],
      primaryMatchingProjectionStatus: "unverified",
      primaryMatchingProjectionSnapshotSha256: null,
    },
    beforeCriteriaSha256: "2".repeat(64),
    beforeQuestionsSha256: "3".repeat(64),
    dedupComponentSha256: "4".repeat(64),
    criteriaCountBefore: 1,
    criteriaCountAfter: 1,
    questionCountAfter: 1,
    pendingCount: 0,
    downgradedCount: 0,
    transport: "claude-cli",
    costUsd: null,
  };
  return createPromotionReleaseManifest({
    releaseId: "question-preparation-release-1",
    revision: 1,
    createdAt: "2026-09-22T00:00:00.000Z",
    gitCommit: "5".repeat(40),
    buildDigest: "6".repeat(40),
    cohortLabel: "question-preparation-fixture",
    canaryGrantIds: [GRANT_ID],
    sourceArtifacts: [{
      grantId: GRANT_ID,
      runId: RUN_ID,
      runSha256: "7".repeat(64),
      overlaySha256: null,
      confirmationsSha256: null,
      manualConfirmationEvaluationsSha256: SELECTION_SHA,
      manualConfirmationEvaluationSelection: plan.manualConfirmationEvaluationSelection!,
      sourceRevisionSha256: REVISION,
      localLabEvidence: {
        schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
        transport: "claude-cli",
        model: "claude-opus-5",
        promptVersion: "lab-deep-v7",
        inputSha256,
        reviewMethod: "analysis_launch_independent_review",
        analysisLaunch: {
          schema: VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
          launchReceiptSha256,
          launchManifestSha256: "8".repeat(64),
          launchGrantSha256: "9".repeat(64),
          launchSequence: 0,
          independentReviewManifestSha256: "0".repeat(64),
          independentReviewAggregateSha256: aggregateSha256,
          attachmentManifestSha256,
          sourceRevisionSha256: REVISION,
          executionGitSha: "a".repeat(40),
          packageRuntimeSha256: "b".repeat(64),
          validatorVersion: "deep-analysis-validator-v21",
          applicationFieldAnalysisVersion: null,
        },
      },
    }],
    plans: [item],
  });
}

function approvedRelease(value = manifest()): ApprovedQuestionPreparationRelease {
  return {
    status: "approved",
    manifest: value,
    manifestSha256: value.manifestSha256,
    releasePlanSha256: value.releasePlanSha256,
    approvedBy: "question-review-approver",
    approvedAt: "2026-09-22T00:10:00.000Z",
    approvalArtifactSha256: "c".repeat(64),
    gateSummary: {
      aggregateSha256: "d".repeat(64),
      shadowSha256: "e".repeat(64),
      dryRunSha256: "f".repeat(64),
    },
  };
}

function rebuildManifest(
  base: PromotionReleaseManifest,
  changes: {
    plans?: PromotionReleaseManifest["plans"];
    sourceArtifacts?: PromotionReleaseManifest["sourceArtifacts"];
  },
): PromotionReleaseManifest {
  return createPromotionReleaseManifest({
    releaseId: base.releaseId,
    revision: base.revision,
    createdAt: base.createdAt,
    gitCommit: base.gitCommit,
    buildDigest: base.buildDigest,
    cohortLabel: base.cohortLabel,
    canaryGrantIds: base.canaryGrantIds,
    sourceArtifacts: changes.sourceArtifacts ?? base.sourceArtifacts,
    plans: changes.plans ?? base.plans,
  });
}

test("미발행 분석은 exact 검수 자산과 승인 release가 같을 때만 기존 writer 포트에 전달한다", async () => {
  const original = manifest();
  const bound = original;
  const current = missingSnapshot();
  const asset: GrantSupplyAsset = {
    runId: RUN_ID,
    sourceRevisionSha256: REVISION,
    inputSha256: bound.sourceArtifacts[0]!.localLabEvidence!.inputSha256,
    attachmentManifestSha256: bound.sourceArtifacts[0]!.localLabEvidence!.analysisLaunch!.attachmentManifestSha256,
    runSha256: bound.sourceArtifacts[0]!.runSha256,
    currentBinding: "verified",
    reviewStatus: "unreviewed",
    reviewSha256: null,
    questionDemand: "unknown",
    manualStatus: "active",
    manualSelection: { revision: 1, artifactSha256: SELECTION_SHA },
    draftPacketSha256: null,
  };
  const loadRun = async () => ({
    grantId: GRANT_ID,
    runId: RUN_ID,
    inputSha256: asset.inputSha256,
    attachmentManifestSha256: asset.attachmentManifestSha256,
    criteria: [{
      dimension: "industry",
      kind: "required",
      operator: "text_only",
      value: { note: "공고에 열거된 업종" },
      sourceSpan: "식품·생활용품·가정용품 분야 중소기업",
      spanVerified: true,
      confidence: 1,
    }],
  } as unknown as LabRun);
  let writes = 0;
  const port: ApprovedQuestionPreparationReleasePort = {
    loadApprovedRelease: async () => approvedRelease(bound),
    applyApprovedCanary: async () => {
      writes += 1;
      return { afterStateSha256: "2".repeat(64), replayed: false, externalWrites: 1 };
    },
  };
  const adapter = createApprovedAnalysisPromotionAdapter({
    releaseId: bound.releaseId,
    manifestSha256: bound.manifestSha256,
    executedBy: "question-executor",
    supplyPlanEvidenceSha256: current.evidenceSha256,
    asset,
    port,
    loadRun,
  });
  const execution = { grantId: GRANT_ID, expectedEvidenceSha256: current.evidenceSha256, snapshot: current };
  const applied = await adapter.execute(execution);
  assert.equal(applied.modelCalls, 0);
  assert.equal(applied.externalWrites, 1);
  assert.equal(writes, 1);
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: bound.releaseId,
      manifestSha256: bound.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset: { ...asset, reviewStatus: "held" },
      port,
      loadRun,
    }).execute(execution),
    /grant_supply_analysis_asset_not_publishable/,
  );
  assert.equal(writes, 1);
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: bound.releaseId,
      manifestSha256: bound.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset: { ...asset, manualStatus: "absent", manualSelection: null },
      port,
      loadRun,
    }).execute(execution),
    /grant_supply_analysis_release_binding_mismatch/,
  );
  assert.equal(writes, 1);
  const { manualConfirmationEvaluationSelection: _unusedPlanSelection, ...planWithoutSelection } =
    bound.plans[0]!.promotionPlan;
  const { manualConfirmationEvaluationSelection: _unusedSourceSelection,
    manualConfirmationEvaluationsSha256: _unusedManualSha, ...sourceWithoutSelection } =
    bound.sourceArtifacts[0]!;
  const planWithoutQuestion = { ...planWithoutSelection, questions: [] };
  const missingQuestionManifest = rebuildManifest(bound, {
    plans: [{
      ...bound.plans[0]!,
      promotionPlan: planWithoutQuestion,
      planSha256: planSha256(planWithoutQuestion),
      questionCountAfter: 0,
    }],
    sourceArtifacts: [sourceWithoutSelection],
  });
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: missingQuestionManifest.releaseId,
      manifestSha256: missingQuestionManifest.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset: { ...asset, manualStatus: "absent", manualSelection: null },
      port: { ...port, loadApprovedRelease: async () => approvedRelease(missingQuestionManifest) },
      loadRun,
    }).execute(execution),
    /grant_supply_formal_question_demand_uncovered/,
  );
  assert.equal(writes, 1);
  const badReviewManifest = rebuildManifest(bound, {
    sourceArtifacts: [{
      ...bound.sourceArtifacts[0]!,
      localLabEvidence: {
        ...bound.sourceArtifacts[0]!.localLabEvidence!,
        analysisLaunch: {
          ...bound.sourceArtifacts[0]!.localLabEvidence!.analysisLaunch!,
          independentReviewAggregateSha256: "5".repeat(64),
        },
      },
    }],
  });
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: badReviewManifest.releaseId,
      manifestSha256: badReviewManifest.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset,
      port: { ...port, loadApprovedRelease: async () => approvedRelease(badReviewManifest) },
      loadRun,
    }).execute(execution),
    /readiness 불일치|release transport provenance 불일치/,
  );
  assert.equal(writes, 1);
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: bound.releaseId,
      manifestSha256: bound.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset: { ...asset, attachmentManifestSha256: "4".repeat(64) },
      port,
      loadRun,
    }).execute(execution),
    /grant_supply_formal_run_binding_mismatch/,
  );
  assert.equal(writes, 1);
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: bound.releaseId,
      manifestSha256: bound.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset: { ...asset, runSha256: "3".repeat(64) },
      port,
      loadRun,
    }).execute(execution),
    /grant_supply_analysis_release_binding_mismatch/,
  );
  assert.equal(writes, 1);
  await assert.rejects(
    createApprovedAnalysisPromotionAdapter({
      releaseId: bound.releaseId,
      manifestSha256: bound.manifestSha256,
      executedBy: "question-executor",
      supplyPlanEvidenceSha256: current.evidenceSha256,
      asset: { ...asset, manualStatus: "withdrawn" },
      port,
      loadRun,
    }).execute(execution),
    /grant_supply_analysis_release_binding_mismatch/,
  );
  assert.equal(writes, 1);
});

test("검수 revision과 receipt-backed 승인 release를 exact question canary로 결속한다", async () => {
  const current = snapshot();
  const releaseManifest = manifest();
  let applied = 0;
  const port: ApprovedQuestionPreparationReleasePort = {
    loadApprovedRelease: async (input) => {
      assert.equal(input.grantId, GRANT_ID);
      assert.equal(input.releaseId, releaseManifest.releaseId);
      return approvedRelease(releaseManifest);
    },
    applyApprovedCanary: async (binding) => {
      applied += 1;
      assert.equal(binding.expectedEvidenceSha256, current.evidenceSha256);
      assert.equal(binding.item.promotionPlan.questions[0]?.criterionStableKey, CRITERION_KEY);
      return { afterStateSha256: "1".repeat(64), replayed: false, externalWrites: 1 };
    },
  };
  const adapter = createQuestionPreparationAdapter({
    releaseId: releaseManifest.releaseId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    executedBy: "question-release-executor",
    port,
  });
  const receipt = await adapter.execute({
    grantId: GRANT_ID,
    expectedEvidenceSha256: current.evidenceSha256,
    snapshot: current,
  });
  assert.equal(applied, 1);
  assert.equal(receipt.action, "question_preparation");
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.externalWrites, 1);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/u);
});

test("질문 stable key나 source binding이 현재 B snapshot과 다르면 writer를 호출하지 않는다", async () => {
  const current = snapshot();
  const valid = manifest();
  const wrongPlan = {
    ...valid.plans[0]!.promotionPlan,
    questions: valid.plans[0]!.promotionPlan.questions.map((question) => ({
      ...question,
      criterionStableKey: "criterion:other",
    })),
  };
  const wrongItem = {
    ...valid.plans[0]!,
    promotionPlan: wrongPlan,
    planSha256: planSha256(wrongPlan),
  };
  const wrongManifest = rebuildManifest(valid, { plans: [wrongItem] });
  assert.throws(() => bindQuestionPreparationRelease({
    releaseId: wrongManifest.releaseId,
    expectedManifestSha256: wrongManifest.manifestSha256,
    executedBy: "question-release-executor",
    release: approvedRelease(wrongManifest),
    snapshot: current,
  }), /question_preparation_question_coverage_mismatch/u);
});

test("검수된 회사 사실 키는 기존 promotion release로 발행하고 잘못된 키는 차단한다", () => {
  const current = snapshot();
  const valid = manifest();
  const plan = valid.plans[0]!.promotionPlan;
  const question = plan.questions[0]!;
  const sharedQuestion = {
    ...question,
    reusable: "company_fact" as const,
    conditionKey: "verified_company_fact",
  };
  const sharedPlan = {
    ...plan,
    questions: [{ ...sharedQuestion, definitionSha256: questionDefinitionSha256(sharedQuestion) }],
  };
  const sharedItem = { ...valid.plans[0]!, promotionPlan: sharedPlan, planSha256: planSha256(sharedPlan) };
  const sharedManifest = rebuildManifest(valid, { plans: [sharedItem] });
  const bound = bindQuestionPreparationRelease({
    releaseId: sharedManifest.releaseId,
    expectedManifestSha256: sharedManifest.manifestSha256,
    executedBy: "question-release-executor",
    release: approvedRelease(sharedManifest),
    snapshot: current,
  });
  assert.equal(bound.item.promotionPlan.questions[0]?.conditionKey, "verified_company_fact");

  const invalidQuestion = { ...sharedQuestion, conditionKey: "Invalid Key" };
  const invalidPlan = {
    ...plan,
    questions: [{ ...invalidQuestion, definitionSha256: questionDefinitionSha256(invalidQuestion) }],
  };
  const invalidItem = { ...valid.plans[0]!, promotionPlan: invalidPlan, planSha256: planSha256(invalidPlan) };
  const invalidManifest = rebuildManifest(valid, { plans: [invalidItem] });
  assert.throws(() => bindQuestionPreparationRelease({
    releaseId: invalidManifest.releaseId,
    expectedManifestSha256: invalidManifest.manifestSha256,
    executedBy: "question-release-executor",
    release: approvedRelease(invalidManifest),
    snapshot: current,
  }), /question_preparation_question_contract_invalid/u);
});

test("미승인 release, 수동 검수 부재, 승인 gate 손상은 fail-closed한다", () => {
  const current = snapshot();
  const valid = manifest();
  assert.throws(() => bindQuestionPreparationRelease({
    releaseId: valid.releaseId,
    expectedManifestSha256: valid.manifestSha256,
    executedBy: "question-release-executor",
    release: { ...approvedRelease(valid), status: "prepared" as "approved" },
    snapshot: current,
  }), /question_preparation_release_not_approved/u);
  assert.throws(() => bindQuestionPreparationRelease({
    releaseId: valid.releaseId,
    expectedManifestSha256: valid.manifestSha256,
    executedBy: "question-review-approver",
    release: approvedRelease(valid),
    snapshot: current,
  }), /question_preparation_actor_separation_required/u);
  assert.throws(() => bindQuestionPreparationRelease({
    releaseId: valid.releaseId,
    expectedManifestSha256: valid.manifestSha256,
    executedBy: "question-release-executor",
    release: {
      ...approvedRelease(valid),
      gateSummary: { ...approvedRelease(valid).gateSummary, dryRunSha256: "broken" },
    },
    snapshot: current,
  }), /question_preparation_dry_run_gate_invalid/u);

  const {
    manualConfirmationEvaluationSelection: _selection,
    ...noSelectionPlan
  } = valid.plans[0]!.promotionPlan;
  const noSelectionItem = {
    ...valid.plans[0]!,
    promotionPlan: noSelectionPlan,
    planSha256: planSha256(noSelectionPlan),
  };
  const noSelectionManifest = rebuildManifest(valid, {
    sourceArtifacts: valid.sourceArtifacts.map((source) => {
      const {
        manualConfirmationEvaluationSelection: _sourceSelection,
        ...withoutSelection
      } = source;
      return withoutSelection;
    }),
    plans: [noSelectionItem],
  });
  assert.throws(() => bindQuestionPreparationRelease({
    releaseId: noSelectionManifest.releaseId,
    expectedManifestSha256: noSelectionManifest.manifestSha256,
    executedBy: "question-release-executor",
    release: approvedRelease(noSelectionManifest),
    snapshot: current,
  }), /수동 confirmation source 결속|question_preparation_manual_review_missing/u);
});

console.log("question preparation adapter: reviewed release binding and zero-model canary passed");
