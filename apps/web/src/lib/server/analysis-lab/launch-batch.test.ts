import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabApplicationRoundtripReference,
} from "@/lib/server/analysis-lab/lab-contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import {
  AnalysisLabExecutionBindingMismatchError,
  AnalysisLabExecutionPausedError,
  assertAnalysisLabLiveExecutionAdmitted,
  assertAnalysisLabReceiptBoundTransportAdmitted,
} from "./analysis-execution-admission";
import {
  assertAnalysisLaunchExecutionContract,
  createAuthoringGuideRerunAnalysisLaunchManifest,
  createAnalysisLaunchGrant,
  createAnalysisLaunchManifest,
  createIndependentReviewRepairAnalysisLaunchManifest,
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  type AnalysisLaunchReceipt,
  type AnalysisLaunchReceiptTarget,
  type AnalysisLaunchApplicationRoundtripReuseBinding,
} from "./launch-batch-artifacts";
import { partitionCohortEntries } from "./batch-plan";
import {
  currentAnalysisLaunchBatchExecutionBinding,
  withAnalysisLaunchBatchExecution,
} from "./launch-batch-context";
import { parseAnalysisLaunchCliArgs } from "./launch-batch-cli";
import {
  classifyAnalysisLaunchTargetStatus,
  selectAnalysisLaunchRetryGrantIds,
  shouldForceExactManifestReanalysis,
} from "./launch-batch-production";
import { parseAuthoringGuideRerunLaunchCliArgs } from "./authoring-guide-rerun-launch-cli";
import { parseIndependentReviewRepairLaunchCliArgs } from "./independent-review-repair-launch-cli";
import {
  buildIndependentReviewRepairInstruction,
  findDriftedIndependentReviewRepairTargetIndexes,
  normalizeIndependentReviewRepairAggregate,
  resolveIndependentReviewManifestPath,
  selectIndependentReviewRepairSequences,
} from "./independent-review-repair-launch";
import { hasLaunchBatchExecutionViolation } from "./analyze";
import { resolveLabBatchRunScan } from "./batch-runner";
import {
  independentReviewFindingsArePrimaryOnly,
  independentReviewFindingsMatchSourceRun,
} from "./independent-review-repair-launch-production";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const GIT_A = "1".repeat(40);
const GIT_B = "2".repeat(40);
const GRANT_0 = "00000000-0000-4000-8000-000000000001";
const GRANT_1 = "00000000-0000-4000-8000-000000000002";

const manifest = createAnalysisLaunchManifest({
  inventory: {
    seriesId: "deep-v24",
    planSha256: SHA_A,
    planArtifactSha256: SHA_B,
    model: "claude-opus-5",
    targets: [
      {
        sequence: 0,
        grantId: GRANT_0,
        stratum: "bizinfo/medium",
        inputSha256: SHA_A,
        attachmentManifestSha256: SHA_B,
      },
      {
        sequence: 1,
        grantId: GRANT_1,
        stratum: "kstartup/thin",
        inputSha256: SHA_B,
        attachmentManifestSha256: SHA_C,
      },
    ],
  },
  sequenceFrom: 0,
  sequenceTo: 1,
  preparedTargets: [
    { grantId: GRANT_0, inputSha256: SHA_A, attachmentManifestSha256: SHA_B },
    { grantId: GRANT_1, inputSha256: SHA_D, attachmentManifestSha256: SHA_C },
  ],
  provenance: {
    gitSha: GIT_A,
    packageRuntimeSha256: SHA_C,
    validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
  },
  withApplicationRoundtrip: true,
  roundtripModel: "claude-opus-5",
  concurrency: 2,
  now: new Date("2026-08-18T00:00:00.000Z"),
});

test("launch manifest는 inventory drift를 target telemetry로 보존한다", () => {
  assert.equal(manifest.targets[0]?.changedSinceInventory, false);
  assert.equal(manifest.targets[1]?.changedSinceInventory, true);
  assert.equal(manifest.execution.withApplicationRoundtrip, true);
  assert.equal(manifest.execution.roundtripModel, "claude-opus-5");
  assert.equal(manifest.execution.applicationFieldAnalysisVersion, "kordoc-application-roundtrip-v11");
  assert.deepEqual(normalizeAnalysisLaunchManifest(JSON.parse(encodeCanonical(manifest).toString("utf8"))), manifest);
});

test("정식 launch publishable은 필드 분석 준비도까지 통과해야 한다", () => {
  assert.equal(classifyAnalysisLaunchTargetStatus({
    primaryOutcome: "publishable",
    fieldAnalysis: "ready",
  }), "publishable");
  assert.equal(classifyAnalysisLaunchTargetStatus({
    primaryOutcome: "publishable",
    fieldAnalysis: "not_applicable",
  }), "publishable");
  assert.equal(classifyAnalysisLaunchTargetStatus({
    primaryOutcome: "publishable",
    fieldAnalysis: "held",
  }), "held");
  assert.equal(classifyAnalysisLaunchTargetStatus({
    primaryOutcome: "failed",
    fieldAnalysis: "ready",
  }), "failed");

  const deepOnly = partitionCohortEntries([{ grantId: GRANT_0 }], new Map([[
    GRANT_0,
    {
      okCurrent: true,
      okOutdated: false,
      heldCurrent: false,
      errorCurrent: false,
      applicationFieldAnalysisReadyCurrent: false,
    },
  ]]), {
    retryErrors: false,
    reanalyzeOutdated: false,
    requireApplicationFieldAnalysis: true,
  });
  assert.deepEqual(deepOnly.pending, [{ grantId: GRANT_0 }], "딥분석만 있는 기존 결과는 필드 포함 launch에서 재실행");

  const fieldReady = partitionCohortEntries([{ grantId: GRANT_0 }], new Map([[
    GRANT_0,
    {
      okCurrent: true,
      okOutdated: false,
      heldCurrent: false,
      errorCurrent: false,
      applicationFieldAnalysisReadyCurrent: true,
    },
  ]]), {
    retryErrors: false,
    reanalyzeOutdated: false,
    requireApplicationFieldAnalysis: true,
  });
  assert.deepEqual(fieldReady.skippedOk, [{ grantId: GRANT_0 }], "필드 준비도까지 통과한 현행 결과만 스킵");

  const v10FieldReference = {
    version: "kordoc-application-roundtrip-v10",
    status: "partial" as const,
    runId: "roundtrip-v10",
    transport: "claude-cli" as const,
    model: "claude-opus-5",
    documentCount: 1,
    sourceCount: 1,
    applicationDocumentCount: 1,
    fieldReadyDocumentCount: 1,
    recognizedFieldCount: 15,
    errorCode: null,
    error: null,
  };
  const scanRecord = (identity: string, applicationRoundtrip: LabApplicationRoundtripReference) => ({
    grantId: GRANT_0,
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    startedAt: "2026-09-11T00:00:00.000Z",
    identity,
    primaryValidationOutcome: "publishable",
    error: null,
    applicationRoundtrip,
  });
  const v10Scan = resolveLabBatchRunScan([scanRecord("v10.json", v10FieldReference)]);
  assert.equal(v10Scan.states.get(GRANT_0)?.applicationFieldAnalysisReadyCurrent, false);
  const v11LaunchAgainstV10 = partitionCohortEntries([{ grantId: GRANT_0 }], v10Scan.states, {
    retryErrors: false,
    reanalyzeOutdated: false,
    requireApplicationFieldAnalysis: true,
  });
  assert.deepEqual(
    v11LaunchAgainstV10.pending,
    [{ grantId: GRANT_0 }],
    "v10 필드 준비 이력이 있어도 v11 launch는 다시 실행",
  );

  const { version: _historicalVersion, ...noVersionFieldReference } = v10FieldReference;
  const noVersionScan = resolveLabBatchRunScan([scanRecord("legacy.json", noVersionFieldReference)]);
  assert.equal(
    noVersionScan.states.get(GRANT_0)?.applicationFieldAnalysisReadyCurrent,
    false,
    "version 없는 역사 참조는 현행 필드 준비도로 인정하지 않음",
  );

  const v11Scan = resolveLabBatchRunScan([scanRecord("v11.json", {
    ...v10FieldReference,
    version: "kordoc-application-roundtrip-v11",
  })]);
  assert.equal(v11Scan.states.get(GRANT_0)?.applicationFieldAnalysisReadyCurrent, true);
  const v11LaunchAgainstV11 = partitionCohortEntries([{ grantId: GRANT_0 }], v11Scan.states, {
    retryErrors: false,
    reanalyzeOutdated: false,
    requireApplicationFieldAnalysis: true,
  });
  assert.deepEqual(v11LaunchAgainstV11.skippedOk, [{ grantId: GRANT_0 }], "v11 필드 준비 참조는 기존 skip을 보존");
});

test("과거 launch manifest는 새 source 정책 필드가 없어도 skip_existing으로 읽는다", () => {
  const legacy = JSON.parse(encodeCanonical(manifest).toString("utf8"));
  delete legacy.source.kind;
  delete legacy.source.adoptionManifestSha256;
  delete legacy.execution.existingRunPolicy;
  const normalized = normalizeAnalysisLaunchManifest(legacy);
  assert.equal(normalized.source.kind, "formal_plan");
  assert.equal(normalized.source.adoptionManifestSha256, null);
  assert.equal(normalized.execution.existingRunPolicy, "skip_existing");
});

test("작성 가이드 adoption 재분석은 source-sealed rerun만 exact 기존 런 재분석으로 봉인한다", () => {
  const adoption = {
    schema: "authoring-guide-adoption-manifest-v1" as const,
    preparedAt: "2026-08-26T00:00:00.000Z",
    asOfKst: "2026-08-26",
    execution: {
      mode: "offline_read_only" as const,
      modelCallsMade: 0 as const,
      databaseWritesMade: 0 as const,
      promotionAuthorized: false as const,
    },
    population: { strictEligibleGrantCount: 2, historicalPublishableRunCount: 2 },
    summary: { projectionReady: 0, reviewRequired: 0, sourceRecoveryRequired: 0, rerunRequired: 2 },
    items: [
      adoptionItem(GRANT_0, "kstartup", true),
      adoptionItem(GRANT_1, "bizinfo", false),
    ],
  };
  const rerun = createAuthoringGuideRerunAnalysisLaunchManifest({
    adoptionManifestSha256: SHA_A,
    adoptionManifest: adoption,
    preparedTargets: [{
      grantId: GRANT_0,
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
    }],
    provenance: {
      gitSha: GIT_A,
      packageRuntimeSha256: SHA_C,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    concurrency: 2,
    now: new Date("2026-08-26T00:01:00.000Z"),
  });
  assert.equal(rerun.targets.length, 1);
  assert.equal(rerun.targets[0]?.grantId, GRANT_0);
  assert.equal(rerun.source.kind, "authoring_guide_adoption");
  assert.equal(rerun.source.adoptionManifestSha256, SHA_A);
  assert.equal(rerun.execution.existingRunPolicy, "rerun_exact_targets");
  assert.equal(rerun.execution.withApplicationRoundtrip, false);
  const exact = partitionCohortEntries([{ grantId: GRANT_0 }], new Map([[
    GRANT_0,
    { okCurrent: true, okOutdated: false, heldCurrent: false, errorCurrent: false },
  ]]), {
    retryErrors: false,
    reanalyzeOutdated: false,
    exactManifestReanalysis: true,
  });
  assert.deepEqual(exact.pending, [{ grantId: GRANT_0 }]);
  assert.equal(exact.skippedOk.length, 0);

  assert.equal(shouldForceExactManifestReanalysis({
    existingRunPolicy: rerun.execution.existingRunPolicy,
    retryErrors: false,
  }), true);
  assert.equal(shouldForceExactManifestReanalysis({
    existingRunPolicy: rerun.execution.existingRunPolicy,
    retryErrors: true,
  }), true);

  const retryOnly = partitionCohortEntries(
    [{ grantId: GRANT_1 }],
    new Map([
      [GRANT_1, { okCurrent: false, okOutdated: true, heldCurrent: false, errorCurrent: false }],
    ]),
    {
      retryErrors: true,
      reanalyzeOutdated: false,
      exactManifestReanalysis: shouldForceExactManifestReanalysis({
        existingRunPolicy: rerun.execution.existingRunPolicy,
        retryErrors: true,
      }),
    },
  );
  assert.deepEqual(retryOnly.pending, [{ grantId: GRANT_1 }]);
  assert.deepEqual(retryOnly.skippedOk, []);

  const firstReceipt = launchReceipt([
    launchReceiptTarget(0, GRANT_0, "publishable"),
    launchReceiptTarget(1, GRANT_1, "failed"),
  ], "2026-08-26T00:10:00.000Z");
  const noOpReceipt = launchReceipt([
    launchReceiptTarget(0, GRANT_0, "skipped"),
    launchReceiptTarget(1, GRANT_1, "skipped"),
  ], "2026-08-26T00:20:00.000Z");
  const interruptedReceipt = launchReceipt([
    launchReceiptTarget(0, GRANT_0, "skipped"),
    launchReceiptTarget(1, GRANT_1, "failed"),
  ], "2026-08-26T00:05:00.000Z");
  assert.deepEqual(selectAnalysisLaunchRetryGrantIds({
    manifest,
    grantSha256: SHA_D,
    manifestSha256: SHA_C,
    receipts: [interruptedReceipt],
  }), [GRANT_0, GRANT_1], "미착수 target과 실패 target만 함께 재개한다");
  assert.deepEqual(selectAnalysisLaunchRetryGrantIds({
    manifest,
    grantSha256: SHA_D,
    manifestSha256: SHA_C,
    receipts: [noOpReceipt, firstReceipt],
  }), [GRANT_1]);

  const successReceipt = launchReceipt([
    launchReceiptTarget(0, GRANT_0, "skipped"),
    launchReceiptTarget(1, GRANT_1, "publishable"),
  ], "2026-08-26T00:30:00.000Z");
  assert.deepEqual(selectAnalysisLaunchRetryGrantIds({
    manifest,
    grantSha256: SHA_D,
    manifestSha256: SHA_C,
    receipts: [firstReceipt, noOpReceipt, successReceipt],
  }), []);
  assert.deepEqual(
    normalizeAnalysisLaunchReceipt(JSON.parse(encodeCanonical(firstReceipt).toString("utf8"))),
    firstReceipt,
  );
  const projectionBinding = {
    schema: "analysis-launch-primary-matching-projection-binding-v1" as const,
    verification: "verified" as const,
    snapshotSha256: SHA_A,
    sourceCriteriaSha256: SHA_B,
    projectedCriteriaSha256: SHA_C,
    reportSha256: SHA_D,
    conversionContractVersion: "analysis-lab-shadow-conversion-v3",
    converterVersion: "analysis-lab-shadow-v3",
    normalizerContractVersion: "grant-llm-criteria-normalization-v1",
    matcherRulesetVersion: "ruleset-kstartup-spine-v10",
  };
  const boundReceipt = launchReceipt([{
    ...launchReceiptTarget(0, GRANT_0, "publishable"),
    primaryMatchingProjection: projectionBinding,
  }], "2026-08-26T00:40:00.000Z");
  assert.deepEqual(
    normalizeAnalysisLaunchReceipt(JSON.parse(encodeCanonical(boundReceipt).toString("utf8"))),
    boundReceipt,
    "신규 receipt가 projection runtime/source/output hash 결속을 보존한다",
  );
  assert.throws(() => normalizeAnalysisLaunchReceipt({
    ...boundReceipt,
    targets: [{
      ...boundReceipt.targets[0],
      primaryMatchingProjection: { ...projectionBinding, snapshotSha256: "not-a-sha" },
    }],
  }), /snapshotSha256/);
  assert.throws(() => normalizeAnalysisLaunchReceipt({
    ...launchReceipt([launchReceiptTarget(0, GRANT_0, "skipped")], "2026-08-26T00:50:00.000Z"),
    targets: [{
      ...launchReceiptTarget(0, GRANT_0, "skipped"),
      primaryMatchingProjection: projectionBinding,
    }],
  }), /run artifact/);
  const featureReadiness = {
    schema: "analysis-feature-readiness-v1" as const,
    matching: { status: "ready" as const, sourceDisposition: "conditional" as const, reasons: [] },
    authoring: {
      status: "held" as const,
      sourceDisposition: "held" as const,
      reasons: ["application_field_analysis_held"],
    },
  };
  const matchingOnlyReceipt = launchReceipt([{
    ...launchReceiptTarget(0, GRANT_0, "held"),
    featureReadiness,
  }], "2026-08-26T00:55:00.000Z");
  assert.deepEqual(
    normalizeAnalysisLaunchReceipt(JSON.parse(encodeCanonical(matchingOnlyReceipt).toString("utf8"))),
    matchingOnlyReceipt,
    "legacy top-level held여도 명시 matching ready/authoring held를 보존한다",
  );
  assert.throws(() => normalizeAnalysisLaunchReceipt(launchReceipt([{
    ...launchReceiptTarget(0, GRANT_0, "failed"),
    featureReadiness,
  }], "2026-08-26T00:56:00.000Z")), /실패 결과가 matching ready/);
  assert.throws(() => normalizeAnalysisLaunchReceipt(launchReceipt([{
    ...launchReceiptTarget(0, GRANT_0, "held"),
    featureReadiness: {
      ...featureReadiness,
      matching: { status: "ready", sourceDisposition: "deferred", reasons: [] },
    },
  }], "2026-08-26T00:57:00.000Z")), /feature readiness/);
});

test("독립 검수 합의 결함 재분석은 exact 원본 대상과 RHWP 필드 분석을 함께 봉인한다", () => {
  const applicationRoundtripReuse = reuseBinding(3, "run-source-3");
  const repair = createIndependentReviewRepairAnalysisLaunchManifest({
    aggregateSha256: SHA_D,
    targets: [
      {
        originalSequence: 3,
        grantId: GRANT_0,
        source: "kstartup",
        inputSha256: SHA_A,
        attachmentManifestSha256: SHA_B,
        reviewRepair: {
          sourceRunId: "run-source-3",
          reviewModel: "gpt-5.6-sol",
          blockingCount: 2,
          taskInstruction: "검증된 결함 두 건을 원문에 맞게 수정",
        },
        applicationRoundtripReuse,
      },
      {
        originalSequence: 27,
        grantId: GRANT_1,
        source: "bizinfo",
        inputSha256: SHA_B,
        attachmentManifestSha256: SHA_C,
      },
    ],
    preparedTargets: [
      { grantId: GRANT_0, inputSha256: SHA_A, attachmentManifestSha256: SHA_B },
      { grantId: GRANT_1, inputSha256: SHA_B, attachmentManifestSha256: SHA_C },
    ],
    provenance: {
      gitSha: GIT_A,
      packageRuntimeSha256: SHA_C,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    concurrency: 2,
    now: new Date("2026-08-29T00:00:00.000Z"),
  });
  assert.equal(repair.source.kind, "independent_review_repair");
  assert.equal(repair.source.planSha256, SHA_D);
  assert.equal(repair.source.planArtifactSha256, SHA_D);
  assert.equal(repair.source.adoptionManifestSha256, null);
  assert.equal(repair.execution.existingRunPolicy, "rerun_exact_targets");
  assert.equal(repair.execution.withApplicationRoundtrip, true);
  assert.equal(repair.execution.roundtripModel, "claude-opus-5");
  assert.equal(repair.execution.applicationFieldAnalysisVersion, "kordoc-application-roundtrip-v11");
  assert.match(repair.targets[0]!.stratum, /original-3$/);
  assert.equal(repair.targets[0]!.reviewRepair?.blockingCount, 2);
  assert.match(repair.targets[0]!.reviewRepair?.taskInstruction ?? "", /결함 두 건/);
  assert.deepEqual(repair.targets[0]!.applicationRoundtripReuse, applicationRoundtripReuse);
  assert.match(repair.targets[1]!.stratum, /original-27$/);
  assert.deepEqual(
    normalizeAnalysisLaunchManifest(JSON.parse(encodeCanonical(repair).toString("utf8"))),
    repair,
  );
  const formalWithReuse = JSON.parse(encodeCanonical(manifest).toString("utf8"));
  formalWithReuse.targets[0].applicationRoundtripReuse = applicationRoundtripReuse;
  assert.throws(
    () => normalizeAnalysisLaunchManifest(formalWithReuse),
    /primary repair 외 launch/,
  );
  const mismatchedSourceRun = JSON.parse(encodeCanonical(repair).toString("utf8"));
  mismatchedSourceRun.targets[0].applicationRoundtripReuse.sourceLabRunId = "other-run";
  assert.throws(
    () => normalizeAnalysisLaunchManifest(mismatchedSourceRun),
    /primary repair 외 launch/,
  );
  const duplicateMarkdown = JSON.parse(encodeCanonical(repair).toString("utf8"));
  duplicateMarkdown.targets[0].applicationRoundtripReuse.parsedMarkdown.push(
    duplicateMarkdown.targets[0].applicationRoundtripReuse.parsedMarkdown[0],
  );
  assert.throws(
    () => normalizeAnalysisLaunchManifest(duplicateMarkdown),
    /parsedMarkdown/,
  );

  assert.throws(() => createIndependentReviewRepairAnalysisLaunchManifest({
    aggregateSha256: SHA_D,
    targets: [{
      originalSequence: 3,
      grantId: GRANT_0,
      source: "kstartup",
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
    }],
    preparedTargets: [{ grantId: GRANT_0, inputSha256: SHA_C, attachmentManifestSha256: SHA_B }],
    provenance: {
      gitSha: GIT_A,
      packageRuntimeSha256: SHA_C,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    concurrency: 1,
    now: new Date("2026-08-29T00:00:00.000Z"),
  }), /원본 launch와 달라졌습니다/);
  assert.throws(() => createIndependentReviewRepairAnalysisLaunchManifest({
    aggregateSha256: SHA_D,
    targets: [{
      originalSequence: 3,
      grantId: GRANT_0,
      source: "kstartup",
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
      reviewRepair: {
        sourceRunId: "run-source-3",
        reviewModel: "gpt-5.6-sol",
        blockingCount: 1,
        taskInstruction: "검증된 결함",
      },
      applicationRoundtripReuse: reuseBinding(4, "run-source-3"),
    }],
    preparedTargets: [{ grantId: GRANT_0, inputSha256: SHA_A, attachmentManifestSha256: SHA_B }],
    provenance: {
      gitSha: GIT_A,
      packageRuntimeSha256: SHA_C,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    concurrency: 1,
    now: new Date("2026-08-29T00:00:00.000Z"),
  }), /source sequence/);
});

test("독립 검수 repair 준비는 현재 입력이 달라진 target만 격리한다", () => {
  const targets = [
    { grantId: GRANT_0, inputSha256: SHA_A, attachmentManifestSha256: SHA_B },
    { grantId: GRANT_1, inputSha256: SHA_B, attachmentManifestSha256: SHA_C },
  ];
  assert.deepEqual(findDriftedIndependentReviewRepairTargetIndexes(targets, [
    { grantId: GRANT_0, inputSha256: SHA_A, attachmentManifestSha256: SHA_B },
    { grantId: GRANT_1, inputSha256: SHA_D, attachmentManifestSha256: SHA_C },
  ]), [1]);
  assert.throws(() => findDriftedIndependentReviewRepairTargetIndexes(targets, [
    { grantId: GRANT_1, inputSha256: SHA_A, attachmentManifestSha256: SHA_B },
    { grantId: GRANT_0, inputSha256: SHA_B, attachmentManifestSha256: SHA_C },
  ]), /grantId 결속이 다릅니다/);
});

test("독립 검수 repair aggregate는 합의된 결함 sequence와 HOLD만 허용한다", () => {
  const aggregate = {
    schema: "independent-ai-review-aggregate-v2",
    manifestSha256: SHA_A,
    launchReceiptSha256: SHA_B,
    consensus: {
      defectCount: 2,
      unresolvedCount: 0,
      affectedTargets: [3, 27],
      defects: [
        { sequence: 27, classification: "defect" },
        { sequence: 3, classification: "defect" },
      ],
      unresolved: [],
    },
    admission: {
      reviewedTargetsStatus: "HOLD",
      reasons: ["consensus_defects:2"],
    },
    reviewerSummaries: {
      codex: { model: "gpt-5.6-sol" },
    },
    heldAudit: [],
    policy: { databaseWrites: false, promotion: false, deployment: false },
  };
  const normalized = normalizeIndependentReviewRepairAggregate(aggregate);
  assert.deepEqual(normalized.consensus.affectedTargets, [3, 27]);
  assert.deepEqual(selectIndependentReviewRepairSequences(normalized, [27]), [27]);
  assert.throws(
    () => selectIndependentReviewRepairSequences(normalized, [14]),
    /합의 결함 대상이 아닌 sequence/,
  );
  const withUnresolved = normalizeIndependentReviewRepairAggregate({
    ...aggregate,
    consensus: {
      ...aggregate.consensus,
      unresolvedCount: 1,
      affectedTargets: [3, 14, 27],
      unresolved: [{ sequence: 14, classification: "unresolved" }],
    },
  });
  assert.deepEqual(withUnresolved.consensus.affectedTargets, [3, 27]);
  assert.deepEqual(withUnresolved.consensus.unresolvedTargets, [14]);
  const primaryOnly = normalizeIndependentReviewRepairAggregate({
    ...aggregate,
    consensus: {
      ...aggregate.consensus,
      defectCount: 2,
      affectedTargets: [3],
      defects: [
        { sequence: 3, kind: "criterion", key: 0, verdict: "needs_edit", classification: "defect" },
        { sequence: 3, kind: "axis", key: "region", verdict: "missed_condition", classification: "defect" },
      ],
    },
  });
  assert.equal(
    independentReviewFindingsArePrimaryOnly(primaryOnly, 3),
    true,
    "criterion/axis primary 결함과 유효 key만 exact Kordoc 재사용 가능",
  );
  assert.equal(independentReviewFindingsMatchSourceRun(primaryOnly, 3, {
    criteria: [{}] as never,
    axisAssessments: [{ dimension: "region" }] as never,
  }), true);
  assert.equal(independentReviewFindingsMatchSourceRun(primaryOnly, 3, {
    criteria: [] as never,
    axisAssessments: [{ dimension: "region" }] as never,
  }), false, "존재하지 않는 criterion index를 exact 재사용 finding으로 인정하지 않음");
  assert.equal(independentReviewFindingsMatchSourceRun(primaryOnly, 3, {
    criteria: [{}] as never,
    axisAssessments: [] as never,
  }), false, "원 LabRun에 없는 axis key를 exact 재사용 finding으로 인정하지 않음");
  for (const invalidFinding of [
    { sequence: 3, kind: "application", key: "field", verdict: "needs_edit", classification: "defect" },
    { sequence: 3, kind: "criterion", key: -1, verdict: "needs_edit", classification: "defect" },
    { sequence: 3, kind: "axis", key: "not-a-dimension", verdict: "missed_condition", classification: "defect" },
    { sequence: 3, kind: "criterion", key: 0, verdict: "unsure", classification: "defect" },
  ]) {
    const invalid = normalizeIndependentReviewRepairAggregate({
      ...aggregate,
      admission: {
        reviewedTargetsStatus: "HOLD",
        reasons: ["consensus_defects:1"],
      },
      consensus: {
        ...aggregate.consensus,
        defectCount: 1,
        affectedTargets: [3],
        defects: [invalidFinding],
      },
    });
    assert.equal(independentReviewFindingsArePrimaryOnly(invalid, 3), false);
  }
  assert.equal(independentReviewFindingsArePrimaryOnly(withUnresolved, 14), false);
});

test("독립 검수 repair 지시는 이전 확정 결함을 누적해 회귀를 막는다", () => {
  const prior = buildIndependentReviewRepairInstruction({
    aggregateSha256: SHA_A,
    findings: [{ kind: "axis", key: "business_status", verdict: "missed_condition" }],
  });
  const cumulative = buildIndependentReviewRepairInstruction({
    aggregateSha256: SHA_B,
    findings: [{ kind: "criterion", key: 7, verdict: "needs_edit" }],
    priorTaskInstruction: prior,
  });
  assert.match(cumulative, /이전 수정사항을 되돌리면 안 된다/);
  assert.match(cumulative, /business_status/);
  assert.match(cumulative, /criterion/);
  assert.ok(cumulative.indexOf(prior) < cumulative.indexOf(`independent_review_aggregate_sha256=${SHA_B}`));
  assert.throws(() => buildIndependentReviewRepairInstruction({
    aggregateSha256: SHA_C,
    findings: [{ kind: "axis", key: "region", verdict: "missed_condition" }],
    priorTaskInstruction: "가".repeat(80_001),
  }), /허용 길이를 초과/);
});

test("Codex-only review-runs aggregate는 상위 불변 manifest를 정확히 찾는다", () => {
  assert.equal(
    resolveIndependentReviewManifestPath(
      `/tmp/review/${SHA_A}/review-runs/${SHA_B}/${SHA_C}.aggregate.json`,
      SHA_B,
    ),
    `/tmp/review/${SHA_A}/${SHA_B}.manifest.json`,
  );
  assert.equal(
    resolveIndependentReviewManifestPath(
      `/tmp/review/${SHA_A}/${SHA_C}.aggregate.json`,
      SHA_B,
    ),
    `/tmp/review/${SHA_A}/${SHA_B}.manifest.json`,
    "역사 v1 aggregate의 기존 동일 디렉터리 배치도 유지한다",
  );
});

test("cohort grant는 manifest 전체를 한 번 승인하고 만료/sequence authority를 만들지 않는다", () => {
  const grant = createAnalysisLaunchGrant({
    manifestSha256: SHA_D,
    targetCount: manifest.targets.length,
    approvedBy: "launch-operator",
    now: new Date("2026-08-18T00:01:00.000Z"),
  });
  assert.equal(grant.stopAfter, "manifest-terminal");
  assert.equal("expiresAt" in grant, false);
  assert.equal("sequence" in grant, false);
  assert.deepEqual(normalizeAnalysisLaunchGrant(JSON.parse(encodeCanonical(grant).toString("utf8"))), grant);
});

test("관련 없는 git commit 변화는 허용하고 material contract drift만 차단한다", () => {
  assert.deepEqual(assertAnalysisLaunchExecutionContract({
    manifest,
    current: {
      gitSha: GIT_B,
      packageRuntimeSha256: SHA_C,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
  }), { gitChangedSincePreparation: true });
  assert.throws(() => assertAnalysisLaunchExecutionContract({
    manifest,
    current: {
      gitSha: GIT_B,
      packageRuntimeSha256: SHA_D,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
  }), /material execution contract/);
});

test("launch capability 밖 generic live entrypoint는 계속 차단된다", () => {
  assert.throws(
    () => assertAnalysisLabLiveExecutionAdmitted(),
    AnalysisLabExecutionPausedError,
  );
  assert.throws(
    () => assertAnalysisLabReceiptBoundTransportAdmitted(),
    AnalysisLabExecutionPausedError,
  );
});

test("launch capability는 cohort target만 열고 target source drift는 그 target에서 거부한다", async () => {
  await withAnalysisLaunchBatchExecution({
    grantSha256: SHA_D,
    manifestSha256: SHA_C,
    sourceKind: "formal_plan",
    model: manifest.execution.model,
    transport: "claude-cli",
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    withApplicationRoundtrip: true,
    roundtripModel: "claude-opus-5",
    targets: new Map(manifest.targets.map((target) => [target.grantId, target])),
  }, async () => {
    assert.doesNotThrow(() => assertAnalysisLabLiveExecutionAdmitted());
    assert.doesNotThrow(() => assertAnalysisLabReceiptBoundTransportAdmitted());
    assert.doesNotThrow(() => assertAnalysisLabLiveExecutionAdmitted({
      grantId: GRANT_0,
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
      model: "claude-opus-5",
      transport: "claude-cli",
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    }));
    assert.throws(() => assertAnalysisLabLiveExecutionAdmitted({
      grantId: GRANT_0,
      inputSha256: SHA_D,
      attachmentManifestSha256: SHA_B,
      model: "claude-opus-5",
      transport: "claude-cli",
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    }), AnalysisLabExecutionBindingMismatchError);
  });
});

test("launch capability는 manifest에 exact 결속된 독립 검수 복구 지시만 허용한다", async () => {
  const reviewRepair = {
    sourceRunId: "run-source",
    reviewModel: "gpt-5.6-sol",
    blockingCount: 2,
    taskInstruction: "검증된 결함 두 건만 원문에 맞게 수정",
  } as const;
  const applicationRoundtripReuse = reuseBinding(3, reviewRepair.sourceRunId);
  assert.throws(
    () => withAnalysisLaunchBatchExecution({
      grantSha256: SHA_D,
      manifestSha256: SHA_C,
      sourceKind: "formal_plan",
      model: "claude-opus-5",
      transport: "claude-cli",
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      withApplicationRoundtrip: true,
      roundtripModel: "claude-opus-5",
      targets: new Map([[GRANT_0, {
        grantId: GRANT_0,
        inputSha256: SHA_A,
        attachmentManifestSha256: SHA_B,
        reviewRepair,
        applicationRoundtripReuse,
      }]]),
    }, async () => undefined),
    /applicationRoundtripReuse 결속/,
    "formal launch가 context seam만으로 independent-review reuse 권한을 만들 수 없음",
  );
  await withAnalysisLaunchBatchExecution({
    grantSha256: SHA_D,
    manifestSha256: SHA_C,
    sourceKind: "independent_review_repair",
    model: "claude-opus-5",
    transport: "claude-cli",
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    withApplicationRoundtrip: true,
    roundtripModel: "claude-opus-5",
    targets: new Map([
      [GRANT_0, {
        grantId: GRANT_0,
        inputSha256: SHA_A,
        attachmentManifestSha256: SHA_B,
        reviewRepair,
        applicationRoundtripReuse,
      }],
      [GRANT_1, {
        grantId: GRANT_1,
        inputSha256: SHA_B,
        attachmentManifestSha256: SHA_C,
      }],
    ]),
  }, async () => {
    const binding = currentAnalysisLaunchBatchExecutionBinding();
    assert.ok(binding);
    const exact = {
      transport: "claude-cli" as const,
      model: "claude-opus-5",
      withApplicationRoundtrip: true,
      roundtripModel: "claude-opus-5",
      taskInstruction: reviewRepair.taskInstruction,
      reviewRepair: {
        sourceRunId: reviewRepair.sourceRunId,
        reviewModel: reviewRepair.reviewModel,
        auditModel: null,
        adjudicationModel: null,
        blockingCount: reviewRepair.blockingCount,
      },
      exactApplicationRoundtripReuse: applicationRoundtripReuse,
    };
    assert.equal(hasLaunchBatchExecutionViolation(GRANT_0, exact, binding), false);
    assert.equal(hasLaunchBatchExecutionViolation(GRANT_0, {
      ...exact,
      taskInstruction: `${reviewRepair.taskInstruction} 임의 확장`,
    }, binding), true);
    assert.equal(hasLaunchBatchExecutionViolation(GRANT_0, {
      ...exact,
      reviewRepair: { ...exact.reviewRepair, auditModel: "grok" },
    }, binding), true);
    assert.equal(hasLaunchBatchExecutionViolation(GRANT_0, {
      ...exact,
      exactApplicationRoundtripReuse: {
        ...applicationRoundtripReuse,
        analysisArtifactSha256: SHA_D,
      },
    }, binding), true, "manifest와 다른 Kordoc bytes 결속은 live option으로 주입할 수 없음");
    const { exactApplicationRoundtripReuse: _omittedReuse, ...withoutExactReuse } = exact;
    assert.equal(
      hasLaunchBatchExecutionViolation(GRANT_0, withoutExactReuse, binding),
      true,
      "manifest exact reuse를 legacy full rerun으로 조용히 바꿀 수 없음",
    );
    assert.equal(hasLaunchBatchExecutionViolation(GRANT_1, exact, binding), true);
    assert.equal(hasLaunchBatchExecutionViolation("missing", exact, binding), true);
  });
});

test("launch CLI는 prepare/grant/run의 권한 단계를 분리한다", () => {
  assert.deepEqual(parseAnalysisLaunchCliArgs("prepare", [
    "--series=deep-v24",
    "--sequences=10-29",
    "--concurrency=2",
  ]), {
    kind: "prepare",
    seriesId: "deep-v24",
    sequenceFrom: 10,
    sequenceTo: 29,
    concurrency: 2,
  });
  assert.throws(() => parseAnalysisLaunchCliArgs("prepare", [
    "--series=deep-v24",
    "--sequences=10-29",
    "--with-kordoc",
  ]));
  assert.equal(parseAnalysisLaunchCliArgs("grant", [
    `--manifest=${SHA_A}`,
    "--approved-by=operator",
  ]).kind, "grant");
  assert.deepEqual(parseAnalysisLaunchCliArgs("run", [
    `--grant=${SHA_B}`,
    "--retry-errors",
  ]), { kind: "run", grantSha256: SHA_B, retryErrors: true });
  assert.deepEqual(parseAuthoringGuideRerunLaunchCliArgs([
    `--adoption-manifest=${SHA_A}`,
    "--concurrency=3",
  ]), { adoptionManifestSha256: SHA_A, concurrency: 3 });
  assert.deepEqual(parseIndependentReviewRepairLaunchCliArgs([
    "--aggregate=spike-out/review.aggregate.json",
    "--original-sequences=14,3",
    "--concurrency=2",
  ]), {
    aggregatePath: "spike-out/review.aggregate.json",
    originalSequences: [14, 3],
    includeNonPublishable: false,
    concurrency: 2,
  });
  assert.equal(parseIndependentReviewRepairLaunchCliArgs([
    "--aggregate=spike-out/review.aggregate.json",
    "--include-non-publishable=true",
  ]).includeNonPublishable, true);
  assert.throws(() => parseIndependentReviewRepairLaunchCliArgs([
    "--aggregate=spike-out/review.json",
  ]));
});

function adoptionItem(
  grantId: string,
  source: "kstartup" | "bizinfo",
  sourceSealed: boolean,
) {
  return {
    grantId,
    source,
    sourceId: `source-${grantId.slice(-1)}`,
    title: `공고 ${grantId.slice(-1)}`,
    disposition: "rerun_required" as const,
    reasons: sourceSealed
      ? ["input_sha256_drift" as const]
      : ["current_source_unsealed" as const, "input_sha256_drift" as const],
    requiresReleaseValidation: true as const,
    advisoryPreviewOnly: true as const,
    run: {
      runId: "run-2026-08-26T000000.000Z-test",
      artifactPath: "spike-out/run.json",
      artifactSha256: SHA_D,
      inputSha256: SHA_D,
      attachmentManifestSha256: SHA_C,
    },
    current: {
      inputSha256: SHA_A,
      attachmentManifestSha256: SHA_B,
      sourceRevisionSha256: SHA_C,
      sourceSealed,
      operationalInputSha256: SHA_A,
      operationalAttachmentManifestSha256: SHA_B,
      sourceBlockers: sourceSealed ? [] : [{
        code: "blocked_conversion",
        attachmentId: "attachment",
        message: "missing",
      }],
    },
    evidence: {
      programIntentPresent: true,
      criterionCount: 1,
      verifiedSourceSpanCount: 1,
      projectedCriterionCount: 1,
    },
    authoringGuidePreview: null,
  };
}

function launchReceiptTarget(
  sequence: number,
  grantId: string,
  status: AnalysisLaunchReceiptTarget["status"],
): AnalysisLaunchReceiptTarget {
  return {
    sequence,
    grantId,
    status,
    runArtifactPath: status === "skipped" ? null : `spike-out/${grantId}.json`,
    runArtifactSha256: status === "skipped" ? null : SHA_A,
    applicationRoundtripStatus: null,
    applicationDocumentCount: null,
    fieldReadyDocumentCount: null,
    recognizedFieldCount: null,
    error: status === "failed" ? "timeout" : null,
  };
}

function launchReceipt(
  targets: readonly AnalysisLaunchReceiptTarget[],
  finishedAt: string,
): AnalysisLaunchReceipt {
  return {
    schema: "analysis-launch-receipt-v1",
    grantSha256: SHA_D,
    manifestSha256: SHA_C,
    startedAt: "2026-08-26T00:00:00.000Z",
    finishedAt,
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: {
      publishable: targets.filter((target) => target.status === "publishable").length,
      held: targets.filter((target) => target.status === "held").length,
      failed: targets.filter((target) => target.status === "failed").length,
      skipped: targets.filter((target) => target.status === "skipped").length,
    },
    targets,
  };
}

function reuseBinding(
  sourceSequence: number,
  sourceLabRunId: string,
): AnalysisLaunchApplicationRoundtripReuseBinding {
  return {
    schema: "analysis-launch-application-roundtrip-reuse-v1",
    sourceSequence,
    sourceLabRunId,
    sourceLabRunArtifactPath: "spike-out/analysis-lab/source-run.json",
    sourceLabRunArtifactSha256: SHA_A,
    sourceRoundtripRunId: "roundtrip-2026-08-29T000000.000Z-a1b2c3",
    analysisArtifactSha256: SHA_B,
    manifestArtifactSha256: SHA_C,
    parsedMarkdown: [{ attachmentId: "attachment-1", sha256: SHA_D }],
    independentReviewAggregatePath: "spike-out/analysis-lab/independent-review/review.aggregate.json",
    independentReviewAggregateSha256: SHA_D,
    independentReviewManifestPath: "spike-out/analysis-lab/independent-review/review.manifest.json",
    independentReviewManifestSha256: SHA_C,
    sourceLaunchReceiptSha256: SHA_B,
  };
}
