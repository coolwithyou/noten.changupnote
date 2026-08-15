import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createDeepRepairExperimentPlan,
  replayDeepRepairExperiment,
} from "./deep-repair-experiment";

const fixture = JSON.parse(
  await readFile(
    new URL("./deep-repair-experiment.legacy-v17.fixture.json", import.meta.url),
    "utf8",
  ),
);

const api = await import("./deep-repair-experiment");
assert.deepEqual(
  Object.keys(api).sort(),
  ["createDeepRepairExperimentPlan", "replayDeepRepairExperiment"],
  "shadow kernel은 createPlan/replay 두 runtime seam만 공개한다",
);

function collectShaFields(value: unknown, path = "fixture"): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectShaFields(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    /sha256$/i.test(key) ? [[`${path}.${key}`, child]] : collectShaFields(child, `${path}.${key}`),
  );
}

for (const [path, value] of collectShaFields(fixture)) {
  assert.match(String(value), /^[a-f0-9]{64}$/, `${path}는 생략 없는 exact SHA-256이어야 한다`);
}
assert.equal(
  fixture.manifest.waves[0].cohort.sha256,
  "c961ea39c1a5bde864f00cd237edb1aa5db060b012c2cd511a776a426c76f2d9",
);
assert.equal(
  fixture.manifest.waves[1].cohort.sha256,
  "879bb3ef4a8ec4d2dec531005215f38d441bfe26f2d0abe0839344c0c369c540",
);
assert.deepEqual(fixture.manifest.provenance.unavailable, [
  "git_sha",
  "package_runtime_sha256",
  "validator_version",
  "attachment_manifest_sha256",
  "repair_ownership",
  "strata_version",
]);
const fixtureTargets = fixture.manifest.waves.flatMap((wave: { targets: unknown[] }) => wave.targets);
assert.equal(fixtureTargets.length, 15);
assert.equal(new Set(fixtureTargets.map((target: { grantId: string }) => target.grantId)).size, 15);
assert.ok(
  !fixtureTargets.some((target: { stratum: string }) => target.stratum === "bizinfo/thin"),
  "legacy 15건에는 bizinfo/thin이 없어 formal coverage로 승격할 수 없다",
);
assert.ok(
  fixture.negativeFixtures.mismatchedBulkPilot5.grantIds.every(
    (grantId: string) => !fixtureTargets.some((target: { grantId: string }) => target.grantId === grantId),
  ),
  "구 v17 이전 bulk-readiness pilot은 공식 15건 provenance로 혼입하지 않는다",
);

const legacyPlan = createDeepRepairExperimentPlan(fixture.manifest);
const pilotReceipt = replayDeepRepairExperiment(legacyPlan, {
  waveLifecycles: fixture.observations.waveLifecycles,
  notices: fixture.observations.notices.slice(0, 5),
});

assert.equal(pilotReceipt.observedCount, 5);
assert.equal(pilotReceipt.repairedNoticeCount, 0);
assert.equal(pilotReceipt.repairAttemptCount, 0);
assert.equal(pilotReceipt.statisticalVerdict, "CONTINUE");
assert.equal(pilotReceipt.verdict, "CONTINUE");
assert.equal(pilotReceipt.lifecycle, "unknown");
assert.equal(pilotReceipt.executionProvenance, null);
assert.equal(pilotReceipt.repairBreakdown, null);

console.log("✅ deep repair experiment — legacy pilot5 shadow replay");

const repeatedLegacyPlan = createDeepRepairExperimentPlan(structuredClone(fixture.manifest));
assert.equal(repeatedLegacyPlan.manifestSha256, legacyPlan.manifestSha256);
assert.equal(repeatedLegacyPlan.planSha256, legacyPlan.planSha256);
assert.equal(legacyPlan.manifestSha256, "9a08ee3ddff246c9abce1fa77aeaac20977937326ba07e8121646c4918b06cd3");
assert.equal(legacyPlan.planSha256, "2fef1b526e7c102121625f49f581c376b101be2ec28c6f948e0644439aa87161");

const mutableManifest = structuredClone(fixture.manifest);
const detachedPlan = createDeepRepairExperimentPlan(mutableManifest);
mutableManifest.policy.model = "mutated-after-create";
mutableManifest.waves[0].targets[0].grantId = "mutated-after-create";
assert.equal(detachedPlan.manifest.policy.model, "claude-opus-5");
assert.equal(detachedPlan.sequence[0]!.grantId, "e46e7e50-689e-4530-a38d-8619607dda56");
assert.ok(Object.isFrozen(detachedPlan));
assert.ok(Object.isFrozen(detachedPlan.manifest));

const repeatedPilotReceipt = replayDeepRepairExperiment(legacyPlan, {
  waveLifecycles: structuredClone(fixture.observations.waveLifecycles),
  notices: structuredClone(fixture.observations.notices.slice(0, 5)),
});
assert.equal(repeatedPilotReceipt.observationSha256, pilotReceipt.observationSha256);
assert.equal(repeatedPilotReceipt.receiptSha256, pilotReceipt.receiptSha256);
assert.equal(pilotReceipt.observationSha256, "8348b46c225cae93bd25e30553285f27a7dd89b1c4a77fa9abc7e846d36e91a7");
assert.equal(pilotReceipt.receiptSha256, "46e19786dc4d6ff5df0716ff05da4ceb5034170966887894224350329473c48d");
assert.ok(Object.isFrozen(repeatedPilotReceipt));

const legacyFullReceipt = replayDeepRepairExperiment(legacyPlan, fixture.observations);
assert.equal(legacyFullReceipt.observedCount, 15);
assert.equal(legacyFullReceipt.repairedNoticeCount, 6, "repair 횟수가 아니라 repair가 있었던 공고 수를 센다");
assert.equal(legacyFullReceipt.repairAttemptCount, 7);
assert.deepEqual(legacyFullReceipt.outcomes, { publishable: 11, held: 4 });
assert.equal(legacyFullReceipt.checkpoints[4]?.statisticalVerdict, "CONTINUE");
assert.equal(legacyFullReceipt.statisticalVerdict, "NO_GO");
assert.equal(legacyFullReceipt.verdict, "NO_GO");
assert.equal(legacyFullReceipt.lifecycle, "unknown", "pilot5 lifecycle 부재를 expand10 완료로 추측하지 않는다");
assert.equal(
  legacyFullReceipt.observationSha256,
  "7156d6cf038004616b7a3673d59fe9eb33e58bbd1fd970bcbdc8f6ea999c9f95",
);
assert.equal(
  legacyFullReceipt.receiptSha256,
  "5989129c9ceb9d2873d969e0178685d6df4837b0cbc53b5b4fa6ccead7b6ce7c",
);

function exactSha(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const REQUIRED_DEEP_REPAIR_STRATA = [
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
] as const;

function syntheticManifest(mode: "formal" | "legacy_shadow" = "formal", targetCount = 30) {
  return {
    schema: "deep-repair-series-manifest-v1",
    seriesId: `synthetic-${mode}-${targetCount}`,
    objective: "deep-primary-repair-rate",
    mode,
    formation: mode === "formal" ? "prospective" : "retrospective_concat",
    strataVersion: mode === "formal" ? "deep-repair-strata-v1" : null,
    provenance:
      mode === "formal"
        ? {
            status: "complete",
            unavailable: [],
            gitSha: "a".repeat(40),
            packageRuntimeSha256: exactSha(8001),
            validatorVersion: "synthetic-validator-v1",
          }
        : { status: "legacy_partial", unavailable: ["git_sha"] },
    policy: {
      promptVersion: "synthetic-v1",
      model: "claude-opus-5",
      transport: "claude-cli",
      qualityPolicyVersion: "analysis-quality-v1",
      gatePolicyVersion: "repair-sprt-v1",
    },
    waves: [
      {
        waveId: "wave-1",
        cohort: {
          artifactPath: "synthetic/cohort.json",
          sha256: exactSha(9000 + targetCount),
          selectedAt: "2026-08-14T00:00:00.000Z",
          seed: 20260814,
        },
        targets: Array.from({ length: targetCount }, (_, index) => {
          const plannedTarget = {
            grantId: `grant-${String(index + 1).padStart(2, "0")}`,
            stratum: REQUIRED_DEEP_REPAIR_STRATA[index % REQUIRED_DEEP_REPAIR_STRATA.length],
            inputSha256: exactSha(1000 + index + 1),
            attachmentManifestSha256: exactSha(2000 + index + 1),
          };
          return mode === "formal"
            ? plannedTarget
            : {
                ...plannedTarget,
                runId: `legacy-run-${String(index + 1).padStart(2, "0")}`,
                runArtifactPath: `synthetic/legacy-run-${index + 1}.json`,
                runArtifactSha256: exactSha(index + 1),
              };
        }),
      },
    ],
  };
}

type ExperimentPlan = ReturnType<typeof createDeepRepairExperimentPlan>;

function syntheticReplayInput(
  plan: ExperimentPlan,
  repairs: readonly boolean[],
  lifecycle: "finished" | "unknown" = "finished",
) {
  const formal = plan.manifest.mode === "formal";
  return {
    ...(formal
      ? {
          executionProvenance: {
            gitSha: plan.manifest.provenance.gitSha,
            packageRuntimeSha256: plan.manifest.provenance.packageRuntimeSha256,
            validatorVersion: plan.manifest.provenance.validatorVersion,
          },
        }
      : {}),
    waveLifecycles: [{ waveId: "wave-1", status: lifecycle }],
    notices: plan.sequence.slice(0, repairs.length).map((target, index) => {
      const runId = target.runBinding?.runId ?? `executed-run-${String(index + 1).padStart(2, "0")}`;
      return {
        waveId: target.waveId,
        grantId: target.grantId,
        runId,
        runArtifactPath: target.runBinding?.runArtifactPath ?? `synthetic/executed-run-${index + 1}.json`,
        runArtifactSha256: target.runBinding?.runArtifactSha256 ?? exactSha(3000 + index + 1),
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256,
        promptVersion: plan.manifest.policy.promptVersion,
        model: plan.manifest.policy.model,
        transport: plan.manifest.policy.transport,
        noticeOutcome: "publishable",
        primaryRepairCount: repairs[index] ? 1 : 0,
        ...(formal
          ? {
              deterministicPrimaryRepairCount: repairs[index] ? 1 : 0,
              modelPrimaryRepairCount: 0,
              reviewRepairCount: 0,
              newIssueAfterRepairCount: 0,
            }
          : {}),
        qualityProjection: {
          policyVersion: plan.manifest.policy.qualityPolicyVersion,
          grantId: target.grantId,
          runId,
          inputSealed: "passed",
          deepContract: "passed",
        },
      };
    }),
  };
}

for (const field of ["gitSha", "packageRuntimeSha256", "validatorVersion"] as const) {
  const missingFormalProvenance = syntheticManifest();
  delete (missingFormalProvenance.provenance as Record<string, unknown>)[field];
  assert.throws(
    () => createDeepRepairExperimentPlan(missingFormalProvenance),
    /formal experiments require exact provenance/,
  );
}

const missingAttachmentProvenance = syntheticManifest();
delete (missingAttachmentProvenance.waves[0]!.targets[0] as Record<string, unknown>)
  .attachmentManifestSha256;
assert.throws(
  () => createDeepRepairExperimentPlan(missingAttachmentProvenance),
  /exact attachmentManifestSha256 provenance/,
);

for (const field of ["runId", "runArtifactPath", "runArtifactSha256"] as const) {
  const prospectiveWithFutureRun = syntheticManifest();
  (prospectiveWithFutureRun.waves[0]!.targets[0] as Record<string, unknown>)[field] =
    field === "runArtifactSha256" ? exactSha(9900) : `future-${field}`;
  assert.throws(
    () => createDeepRepairExperimentPlan(prospectiveWithFutureRun),
    /prospective plans must not include future run bindings/,
  );
}

assert.throws(
  () => createDeepRepairExperimentPlan(syntheticManifest("formal", 15)),
  /formal experiment plan must pre-seal exactly 30 targets/,
);

const wrongStrataVersion = syntheticManifest();
wrongStrataVersion.strataVersion = "invented-strata-v2";
assert.throws(() => createDeepRepairExperimentPlan(wrongStrataVersion), /deep-repair-strata-v1/);

const exhaustedKstartupThickV2 = syntheticManifest();
exhaustedKstartupThickV2.strataVersion = "deep-repair-strata-v2";
for (const wave of exhaustedKstartupThickV2.waves) {
  for (const target of wave.targets) {
    if (target.stratum === "kstartup/thick") target.stratum = "kstartup/medium";
  }
}
const exhaustedKstartupThickV2Plan = createDeepRepairExperimentPlan(exhaustedKstartupThickV2);

const missingRequiredStratum = syntheticManifest();
for (const target of missingRequiredStratum.waves[0]!.targets) target.stratum = "bizinfo/medium";
assert.throws(() => createDeepRepairExperimentPlan(missingRequiredStratum), /required strata/);

const unsupportedStratum = syntheticManifest();
(unsupportedStratum.waves[0]!.targets.at(-1)! as { stratum: string }).stratum = "invented/extra";
assert.throws(() => createDeepRepairExperimentPlan(unsupportedStratum), /unsupported strata/);

const lateRequiredStratumManifest = syntheticManifest();
for (const target of lateRequiredStratumManifest.waves[0]!.targets.slice(0, 15)) {
  if (target.stratum === "bizinfo/thin") target.stratum = "bizinfo/medium";
}
assert.throws(
  () => createDeepRepairExperimentPlan(lateRequiredStratumManifest),
  /first 15 targets are missing required strata/,
);

const formalPlan = createDeepRepairExperimentPlan(syntheticManifest());
assert.equal(formalPlan.manifest.provenance.gitSha, "a".repeat(40));
assert.equal(formalPlan.manifest.provenance.packageRuntimeSha256, exactSha(8001));
assert.equal(formalPlan.manifest.provenance.validatorVersion, "synthetic-validator-v1");
assert.equal(formalPlan.sequence[0]!.attachmentManifestSha256, exactSha(2001));
assert.equal(formalPlan.sequence[0]!.runBinding, null, "prospective plan은 미래 run binding을 창작하지 않는다");
const formalZeroOfFifteen = replayDeepRepairExperiment(
  formalPlan,
  syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false)),
);
assert.equal(formalZeroOfFifteen.statisticalVerdict, "GO");
assert.equal(formalZeroOfFifteen.verdict, "GO");
assert.equal(formalZeroOfFifteen.lifecycle, "finished");
const v2ZeroOfFifteen = replayDeepRepairExperiment(
  exhaustedKstartupThickV2Plan,
  syntheticReplayInput(exhaustedKstartupThickV2Plan, Array<boolean>(15).fill(false)),
);
assert.equal(v2ZeroOfFifteen.verdict, "GO", "v2 필수 5층만 관측해도 통계 GO를 왜곡하지 않음");
assert.deepEqual(formalZeroOfFifteen.executionProvenance, {
  gitSha: "a".repeat(40),
  packageRuntimeSha256: exactSha(8001),
  validatorVersion: "synthetic-validator-v1",
});
assert.deepEqual(formalZeroOfFifteen.repairBreakdown, {
  deterministicPrimary: 0,
  modelPrimary: 0,
  review: 0,
  newIssuesAfterRepair: 0,
});

const missingExecutionProvenance = syntheticReplayInput(
  formalPlan,
  Array<boolean>(15).fill(false),
);
delete (missingExecutionProvenance as Record<string, unknown>).executionProvenance;
const missingExecutionReceipt = replayDeepRepairExperiment(formalPlan, missingExecutionProvenance);
assert.equal(missingExecutionReceipt.verdict, "INVALID");
assert.ok(missingExecutionReceipt.invalidReasons.includes("execution_provenance_missing"));

for (const field of ["gitSha", "packageRuntimeSha256", "validatorVersion"] as const) {
  const driftedExecution = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
  (driftedExecution.executionProvenance as Record<string, unknown>)[field] =
    field === "packageRuntimeSha256" ? exactSha(9902) : `drifted-${field}`;
  const receipt = replayDeepRepairExperiment(formalPlan, driftedExecution);
  assert.equal(receipt.verdict, "INVALID");
  assert.ok(
    receipt.invalidReasons.includes(
      field === "gitSha" ? "execution_provenance_malformed" : "execution_provenance_mismatch",
    ),
  );
}

const missingRepairProvenance = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
delete (missingRepairProvenance.notices[0] as Record<string, unknown>).reviewRepairCount;
const missingRepairReceipt = replayDeepRepairExperiment(formalPlan, missingRepairProvenance);
assert.equal(missingRepairReceipt.verdict, "INVALID");
assert.ok(missingRepairReceipt.invalidReasons.includes("repair_provenance_missing"));

const mismatchedRepairProvenance = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
mismatchedRepairProvenance.notices[0]!.deterministicPrimaryRepairCount = 1;
const mismatchedRepairReceipt = replayDeepRepairExperiment(formalPlan, mismatchedRepairProvenance);
assert.equal(mismatchedRepairReceipt.verdict, "INVALID");
assert.ok(mismatchedRepairReceipt.invalidReasons.includes("repair_provenance_mismatch"));

const contaminatedRepairProvenance = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
contaminatedRepairProvenance.notices[0]!.reviewRepairCount = 1;
const contaminatedRepairReceipt = replayDeepRepairExperiment(formalPlan, contaminatedRepairProvenance);
assert.equal(contaminatedRepairReceipt.verdict, "INVALID");
assert.ok(contaminatedRepairReceipt.invalidReasons.includes("confirmatory_review_repair_present"));

const missingRepairTransition = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
delete (missingRepairTransition.notices[0] as Record<string, unknown>).newIssueAfterRepairCount;
const missingRepairTransitionReceipt = replayDeepRepairExperiment(formalPlan, missingRepairTransition);
assert.equal(missingRepairTransitionReceipt.verdict, "INVALID");
assert.ok(missingRepairTransitionReceipt.invalidReasons.includes("repair_transition_provenance_missing"));

const regressedAfterRepair = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
regressedAfterRepair.notices[0]!.newIssueAfterRepairCount = 1;
const regressedAfterRepairReceipt = replayDeepRepairExperiment(formalPlan, regressedAfterRepair);
assert.equal(regressedAfterRepairReceipt.statisticalVerdict, "GO");
assert.equal(regressedAfterRepairReceipt.verdict, "INVALID");
assert.ok(regressedAfterRepairReceipt.invalidReasons.includes("new_issue_after_repair_present"));

for (const duplicateField of ["runId", "runArtifactPath", "runArtifactSha256"] as const) {
  const duplicatedRun = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
  duplicatedRun.notices[1]![duplicateField] = duplicatedRun.notices[0]![duplicateField];
  if (duplicateField === "runId") {
    duplicatedRun.notices[1]!.qualityProjection.runId = duplicatedRun.notices[0]!.runId;
  }
  const receipt = replayDeepRepairExperiment(formalPlan, duplicatedRun);
  assert.equal(receipt.verdict, "INVALID");
  assert.ok(receipt.invalidReasons.includes("duplicate_run_binding"));
}

const missingActualRunPath = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
delete (missingActualRunPath.notices[0] as Record<string, unknown>).runArtifactPath;
const missingActualRunPathReceipt = replayDeepRepairExperiment(formalPlan, missingActualRunPath);
assert.equal(missingActualRunPathReceipt.verdict, "INVALID");
assert.ok(missingActualRunPathReceipt.invalidReasons.includes("formal_run_binding_incomplete"));

for (const mutate of [
  (input: ReturnType<typeof syntheticReplayInput>) => {
    input.notices[0]!.noticeOutcome = "held";
  },
  (input: ReturnType<typeof syntheticReplayInput>) => {
    input.notices[0]!.qualityProjection.inputSealed = "failed";
  },
  (input: ReturnType<typeof syntheticReplayInput>) => {
    input.notices[0]!.qualityProjection.deepContract = "held";
  },
]) {
  const input = syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false));
  mutate(input);
  const receipt = replayDeepRepairExperiment(formalPlan, input);
  assert.equal(receipt.statisticalVerdict, "GO");
  assert.equal(receipt.verdict, "INVALID");
  assert.ok(receipt.invalidReasons.includes("quality_hard_gate_failed"));
}

const unfinishedFormalGo = replayDeepRepairExperiment(
  formalPlan,
  syntheticReplayInput(formalPlan, Array<boolean>(15).fill(false), "unknown"),
);
assert.equal(unfinishedFormalGo.statisticalVerdict, "GO");
assert.equal(unfinishedFormalGo.verdict, "INVALID");
assert.ok(unfinishedFormalGo.invalidReasons.includes("lifecycle_not_finished_for_go"));

const driftedCoveragePlan = structuredClone(formalPlan);
for (const target of driftedCoveragePlan.sequence.slice(0, 15)) {
  if (target.stratum === "bizinfo/thin") {
    (target as { stratum: string }).stratum = "bizinfo/medium";
  }
}
const incompleteCoverageGo = replayDeepRepairExperiment(
  driftedCoveragePlan,
  syntheticReplayInput(driftedCoveragePlan, Array<boolean>(15).fill(false)),
);
assert.equal(incompleteCoverageGo.statisticalVerdict, "GO");
assert.equal(incompleteCoverageGo.verdict, "INVALID");
assert.ok(incompleteCoverageGo.invalidReasons.includes("plan_sha_mismatch"));
assert.ok(incompleteCoverageGo.invalidReasons.includes("required_strata_unobserved"));

const legacySyntheticPlan = createDeepRepairExperimentPlan(syntheticManifest("legacy_shadow"));
const legacyHypotheticalGo = replayDeepRepairExperiment(
  legacySyntheticPlan,
  syntheticReplayInput(legacySyntheticPlan, Array<boolean>(15).fill(false)),
);
assert.equal(legacyHypotheticalGo.statisticalVerdict, "GO");
assert.equal(legacyHypotheticalGo.verdict, "INVALID");
assert.deepEqual(legacyHypotheticalGo.invalidReasons, ["legacy_shadow_cannot_issue_go"]);

const sixOfFifteen = [...Array<boolean>(6).fill(true), ...Array<boolean>(9).fill(false)];
const formalNoGoFinished = replayDeepRepairExperiment(
  formalPlan,
  syntheticReplayInput(formalPlan, sixOfFifteen, "finished"),
);
const formalNoGoUnknown = replayDeepRepairExperiment(
  formalPlan,
  syntheticReplayInput(formalPlan, sixOfFifteen, "unknown"),
);
assert.equal(formalNoGoFinished.statisticalVerdict, "NO_GO");
assert.equal(formalNoGoFinished.verdict, "NO_GO");
assert.equal(formalNoGoFinished.lifecycle, "finished");
assert.equal(formalNoGoUnknown.verdict, "NO_GO", "lifecycle 관측과 품질 판정을 결합하지 않는다");
assert.equal(formalNoGoUnknown.lifecycle, "unknown");

const fiveOfFifteen = [...Array<boolean>(5).fill(true), ...Array<boolean>(10).fill(false)];
const boundaryContinue = replayDeepRepairExperiment(
  formalPlan,
  syntheticReplayInput(formalPlan, fiveOfFifteen),
);
assert.equal(boundaryContinue.statisticalVerdict, "CONTINUE");
assert.ok(Math.abs((boundaryContinue.checkpoints.at(-1)?.logLikelihoodRatio ?? 0) - 2.2879055462358924) < 1e-12);

const fiveOfThirty = [...Array<boolean>(5).fill(true), ...Array<boolean>(25).fill(false)];
const boundaryInconclusive = replayDeepRepairExperiment(
  formalPlan,
  syntheticReplayInput(formalPlan, fiveOfThirty),
);
assert.equal(boundaryInconclusive.statisticalVerdict, "INCONCLUSIVE");
assert.equal(boundaryInconclusive.verdict, "INCONCLUSIVE");
assert.ok(Math.abs((boundaryInconclusive.checkpoints.at(-1)?.logLikelihoodRatio ?? 0) - 0.5211600113901418) < 1e-12);

const driftedPlan = structuredClone(legacyPlan);
(driftedPlan as unknown as { manifest: { policy: { model: string } } }).manifest.policy.model =
  "changed-without-replanning";
const driftedPlanReceipt = replayDeepRepairExperiment(driftedPlan, {
  waveLifecycles: fixture.observations.waveLifecycles,
  notices: fixture.observations.notices.slice(0, 5),
});
assert.equal(driftedPlanReceipt.verdict, "INVALID");
assert.ok(driftedPlanReceipt.invalidReasons.includes("plan_sha_mismatch"));
assert.ok(driftedPlanReceipt.invalidReasons.includes("manifest_sha_mismatch"));

const selfHashedForgedPlan = structuredClone(formalPlan);
(selfHashedForgedPlan.sequence[0] as { grantId: string }).grantId = "forged-grant-01";
(selfHashedForgedPlan as { planSha256: string }).planSha256 = canonicalSha256({
  schema: selfHashedForgedPlan.schema,
  manifest: selfHashedForgedPlan.manifest,
  sequence: selfHashedForgedPlan.sequence,
  manifestSha256: selfHashedForgedPlan.manifestSha256,
});
const forgedPlanReceipt = replayDeepRepairExperiment(
  selfHashedForgedPlan,
  syntheticReplayInput(selfHashedForgedPlan, Array<boolean>(15).fill(false)),
);
assert.equal(forgedPlanReceipt.verdict, "INVALID");
assert.ok(forgedPlanReceipt.invalidReasons.includes("plan_not_canonical"));

const swappedNotices = structuredClone(fixture.observations.notices.slice(0, 5));
[swappedNotices[0], swappedNotices[1]] = [swappedNotices[1], swappedNotices[0]];
const swappedReceipt = replayDeepRepairExperiment(legacyPlan, {
  waveLifecycles: fixture.observations.waveLifecycles,
  notices: swappedNotices,
});
assert.equal(swappedReceipt.verdict, "INVALID");
assert.ok(swappedReceipt.invalidReasons.includes("observation_order_or_binding_mismatch"));

for (const mutate of [
  (notice: Record<string, unknown>) => {
    notice.grantId = fixture.negativeFixtures.mismatchedBulkPilot5.grantIds[0];
  },
  (notice: Record<string, unknown>) => {
    notice.runId = "run-drift";
  },
  (notice: Record<string, unknown>) => {
    notice.runArtifactSha256 = exactSha(7001);
  },
  (notice: Record<string, unknown>) => {
    notice.inputSha256 = exactSha(7002);
  },
]) {
  const notices = structuredClone(fixture.observations.notices.slice(0, 5));
  mutate(notices[0]);
  const receipt = replayDeepRepairExperiment(legacyPlan, {
    waveLifecycles: fixture.observations.waveLifecycles,
    notices,
  });
  assert.equal(receipt.verdict, "INVALID");
  assert.ok(receipt.invalidReasons.includes("observation_order_or_binding_mismatch"));
}

const graphDriftNotices = structuredClone(fixture.observations.notices.slice(0, 5));
graphDriftNotices[0].qualityProjection.runId = "graph-run-drift";
const graphDriftReceipt = replayDeepRepairExperiment(legacyPlan, {
  waveLifecycles: fixture.observations.waveLifecycles,
  notices: graphDriftNotices,
});
assert.equal(graphDriftReceipt.verdict, "INVALID");
assert.ok(graphDriftReceipt.invalidReasons.includes("quality_projection_binding_mismatch"));

const graphGrantDriftNotices = structuredClone(fixture.observations.notices.slice(0, 5));
graphGrantDriftNotices[0].qualityProjection.grantId = "graph-grant-drift";
const graphGrantDriftReceipt = replayDeepRepairExperiment(legacyPlan, {
  waveLifecycles: fixture.observations.waveLifecycles,
  notices: graphGrantDriftNotices,
});
assert.equal(graphGrantDriftReceipt.verdict, "INVALID");
assert.ok(graphGrantDriftReceipt.invalidReasons.includes("quality_projection_binding_mismatch"));

const attachmentDriftInput = syntheticReplayInput(formalPlan, Array<boolean>(5).fill(false));
attachmentDriftInput.notices[0]!.attachmentManifestSha256 = exactSha(9901);
const attachmentDriftReceipt = replayDeepRepairExperiment(formalPlan, attachmentDriftInput);
assert.equal(attachmentDriftReceipt.verdict, "INVALID");
assert.ok(attachmentDriftReceipt.invalidReasons.includes("observation_order_or_binding_mismatch"));

for (const repairs of [
  Array<boolean>(16).fill(false),
  [...Array<boolean>(6).fill(true), ...Array<boolean>(10).fill(false)],
]) {
  const terminalExtraReceipt = replayDeepRepairExperiment(
    formalPlan,
    syntheticReplayInput(formalPlan, repairs),
  );
  assert.equal(terminalExtraReceipt.verdict, "INVALID");
  assert.ok(terminalExtraReceipt.invalidReasons.includes("observation_after_terminal_gate"));
}

type OperatingCharacteristics = Record<"GO" | "NO_GO" | "INCONCLUSIVE", number>;

function enumerateOperatingCharacteristics(repairProbability: number): OperatingCharacteristics {
  let active = new Map<number, { probability: number; repairs: boolean[] }>([
    [0, { probability: 1, repairs: [] }],
  ]);
  const outcomes: OperatingCharacteristics = { GO: 0, NO_GO: 0, INCONCLUSIVE: 0 };

  for (let sampleSize = 1; sampleSize <= 30; sampleSize += 1) {
    const next = new Map<number, { probability: number; repairs: boolean[] }>();
    for (const state of active.values()) {
      for (const repaired of [false, true]) {
        const branchProbability = state.probability * (repaired ? repairProbability : 1 - repairProbability);
        const repairs = [...state.repairs, repaired];
        const receipt = replayDeepRepairExperiment(formalPlan, syntheticReplayInput(formalPlan, repairs));
        if (receipt.verdict === "CONTINUE") {
          const repairCount = repairs.filter(Boolean).length;
          const existing = next.get(repairCount);
          if (existing) existing.probability += branchProbability;
          else next.set(repairCount, { probability: branchProbability, repairs });
        } else {
          assert.ok(
            receipt.verdict === "GO" ||
              receipt.verdict === "NO_GO" ||
              receipt.verdict === "INCONCLUSIVE",
            `DP branch unexpectedly ended as ${receipt.verdict}`,
          );
          outcomes[receipt.verdict] += branchProbability;
        }
      }
    }
    active = next;
  }
  assert.equal(active.size, 0, "Nmax에서는 CONTINUE 상태가 남지 않아야 한다");
  return outcomes;
}

function assertOperatingCharacteristics(
  actual: OperatingCharacteristics,
  expected: OperatingCharacteristics,
): void {
  for (const verdict of ["GO", "NO_GO", "INCONCLUSIVE"] as const) {
    assert.ok(
      Math.abs(actual[verdict] - expected[verdict]) < 1e-12,
      `${verdict}: expected ${expected[verdict]}, received ${actual[verdict]}`,
    );
  }
  assert.ok(Math.abs(Object.values(actual).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
}

assertOperatingCharacteristics(enumerateOperatingCharacteristics(0.1), {
  GO: 0.5282462215804146,
  NO_GO: 0.012488644543179533,
  INCONCLUSIVE: 0.45926513387640683,
});
assertOperatingCharacteristics(enumerateOperatingCharacteristics(0.2), {
  GO: 0.09923958408014412,
  NO_GO: 0.274548552828356,
  INCONCLUSIVE: 0.6262118630915016,
});

console.log("✅ deep repair experiment — binding, sequential gate, lifecycle, DP operating characteristics");
