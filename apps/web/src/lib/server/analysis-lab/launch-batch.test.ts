import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/lib/server/analysis-lab/lab-contract";
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
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
} from "./launch-batch-artifacts";
import { partitionCohortEntries } from "./batch-plan";
import { withAnalysisLaunchBatchExecution } from "./launch-batch-context";
import { parseAnalysisLaunchCliArgs } from "./launch-batch-cli";
import { parseAuthoringGuideRerunLaunchCliArgs } from "./authoring-guide-rerun-launch-cli";

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
  assert.deepEqual(normalizeAnalysisLaunchManifest(JSON.parse(encodeCanonical(manifest).toString("utf8"))), manifest);
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
