import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_LOSS_RECOVERY_POLICY,
  assertCurrentInventoryManifestBinding,
  buildCurrentInventoryLaunchManifest,
  validateCurrentLaunchInventory,
  type CurrentLaunchInventory,
} from "./current-inventory-launch";
import { assertCurrentInventoryHistoryEligibility, assertNoCurrentArtifactLossSuccess } from "./current-inventory-launch-production";

const grantId = "76069674-e762-456e-9c69-9c94e76eba1f";
const sha = "a".repeat(64);
const inventory: CurrentLaunchInventory = {
  schema: "analysis-current-inventory-v1",
  seriesId: "current-artifact-loss-20260925",
  observedAt: "2026-09-25T09:00:00.000Z",
  model: "claude-opus-4-8",
  policy: ARTIFACT_LOSS_RECOVERY_POLICY,
  historicalGrantIdsSha256: sha,
  artifactLossRecovery: {
    schema: "analysis-artifact-loss-reanalysis-attestation-v1",
    evidenceStatus: "session-transcript-only",
    sessionTranscriptSha256: sha,
    priorManifestSha256: sha,
    priorGrantSha256: sha,
    priorTerminalReceiptSha256: sha,
    targets: [{
      grantId,
      priorSequence: 18,
      priorRunId: "run-2026-09-25T033757.034Z-c6f4e3",
      priorSourceRevisionSha256: sha,
      priorInputSha256: sha,
      priorAttachmentManifestSha256: sha,
    }],
  },
  targets: [{
    sequence: 0,
    grantId,
    stratum: "kstartup/medium",
    inputSha256: sha,
    attachmentManifestSha256: sha,
    sourceRevisionSha256: sha,
    matchingMaterialSourceBinding: {
      schema: "analysis-matching-material-source-binding-v1",
      materialSourceRevisionSha256: sha,
      sourceRawSha256: sha,
    },
  }],
};

test("artifact loss recovery는 역사 대상과 현재 material을 별도로 결속한다", () => {
  assert.equal(validateCurrentLaunchInventory(inventory).policy, ARTIFACT_LOSS_RECOVERY_POLICY);
  assert.doesNotThrow(() => assertCurrentInventoryHistoryEligibility([grantId], [grantId], ARTIFACT_LOSS_RECOVERY_POLICY));
  assert.throws(() => assertCurrentInventoryHistoryEligibility([grantId], [], ARTIFACT_LOSS_RECOVERY_POLICY), /역사 실행/);
  assert.throws(() => validateCurrentLaunchInventory({
    ...inventory,
    targets: [{ ...inventory.targets[0]!, inputSha256: "b".repeat(64) }],
  }), /과거 관측과 현재 material/);
  assert.throws(() => validateCurrentLaunchInventory({
    ...inventory,
    artifactLossRecovery: undefined,
  }), /attestation 결속/);
  assert.throws(() => validateCurrentLaunchInventory({
    ...inventory,
    artifactLossRecovery: { ...inventory.artifactLossRecovery!, targets: [{
      ...inventory.artifactLossRecovery!.targets[0]!, grantId: "13892d8b-a06b-4717-aeda-da44772a786c",
    }] },
  }), /과거 관측과 현재 material/);
  assert.throws(() => assertNoCurrentArtifactLossSuccess([grantId], new Map([[grantId, { okCurrent: true }]])), /성공 LabRun/);
  assert.doesNotThrow(() => assertNoCurrentArtifactLossSuccess([grantId], new Map([[grantId, { okCurrent: false }]])));
  assert.throws(() => buildCurrentInventoryLaunchManifest({
    inventory,
    inventorySha256: sha,
    provenance: { gitSha: "a".repeat(40), packageRuntimeSha256: sha, validatorVersion: "deep-analysis-validator-v23" },
    concurrency: 2,
    now: new Date("2026-09-25T09:00:00.000Z"),
  }), /matching-only 신규 실행/);
  assert.throws(() => assertCurrentInventoryManifestBinding({
    source: {}, execution: { analysisMode: "application_only" },
  } as never, inventory), /matching-only 신규 실행/);
});
