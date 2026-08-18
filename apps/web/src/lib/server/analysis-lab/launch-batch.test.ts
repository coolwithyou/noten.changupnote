import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import {
  AnalysisLabExecutionBindingMismatchError,
  AnalysisLabExecutionPausedError,
  assertAnalysisLabLiveExecutionAdmitted,
  assertAnalysisLabReceiptBoundTransportAdmitted,
} from "./analysis-execution-admission";
import {
  assertAnalysisLaunchExecutionContract,
  createAnalysisLaunchGrant,
  createAnalysisLaunchManifest,
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
} from "./launch-batch-artifacts";
import { withAnalysisLaunchBatchExecution } from "./launch-batch-context";
import { parseAnalysisLaunchCliArgs } from "./launch-batch-cli";

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
    seriesId: "deep-v23",
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
    "--series=deep-v23",
    "--sequences=10-29",
    "--concurrency=2",
    "--with-kordoc",
  ]), {
    kind: "prepare",
    seriesId: "deep-v23",
    sequenceFrom: 10,
    sequenceTo: 29,
    concurrency: 2,
    withKordoc: true,
  });
  assert.equal(parseAnalysisLaunchCliArgs("grant", [
    `--manifest=${SHA_A}`,
    "--approved-by=operator",
  ]).kind, "grant");
  assert.deepEqual(parseAnalysisLaunchCliArgs("run", [
    `--grant=${SHA_B}`,
    "--retry-errors",
  ]), { kind: "run", grantSha256: SHA_B, retryErrors: true });
});
