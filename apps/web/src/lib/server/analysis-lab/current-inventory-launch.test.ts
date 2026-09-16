import assert from "node:assert/strict";
import "./terminal-repair-source.test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURRENT_INVENTORY_SCHEMA, buildCurrentInventoryLaunchManifest,
  MISSING_WORKSPACE_FIELDS_POLICY,
  currentLaunchInventoryPath, readCurrentLaunchInventory, storeCurrentLaunchInventory,
  readAndVerifyCompletedCurrentInventoryLaunch,
  validateCurrentLaunchInventory, verifyCurrentInventoryLaunchBinding,
  type CurrentLaunchInventory,
} from "./current-inventory-launch";
import { assertCurrentInventoryHistoryEligibility, assertMissingWorkspaceFieldsState, verifyCurrentInventoryLaunchTarget } from "./current-inventory-launch-production";
import { parseCurrentInventoryLaunchArgs } from "./current-inventory-launch-cli";
import { partitionCohortEntries } from "./batch-plan";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { deepRepairTargetCountForSeries } from "./deep-repair-formal-policy";
import {
  encodeCanonical,
  normalizeAnalysisLaunchManifest,
  normalizeCompletedCurrentInventorySourceManifest,
  createAnalysisLaunchGrant,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchCompletedCurrentInventoryBinding,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import {
  prepareCompletedCurrentInventoryLaunchManifest,
  shouldForceExactManifestReanalysis,
} from "./launch-batch-production";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";

const id = (n: number) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
const digest = (value: unknown) => createHash("sha256").update(encodeCanonical(value)).digest("hex");
function inventory(count = 47): CurrentLaunchInventory {
  return { schema: CURRENT_INVENTORY_SCHEMA, seriesId: "current-20260910",
    observedAt: "2026-09-09T19:45:00.000Z", model: "claude-opus-5",
    policy: "open-visible-current-period-unseen-v1", historicalGrantIdsSha256: "a".repeat(64),
    targets: Array.from({ length: count }, (_, sequence) => ({ sequence, grantId: id(sequence),
      stratum: "bizinfo/medium", inputSha256: "b".repeat(64),
      attachmentManifestSha256: "c".repeat(64), sourceRevisionSha256: "d".repeat(64) })),
  };
}
function manifest(value = inventory()) {
  return buildCurrentInventoryLaunchManifest({ inventory: value, inventorySha256: digest(value),
    concurrency: 2, now: new Date("2026-09-09T20:00:00.000Z"),
    provenance: { gitSha: "1".repeat(40), packageRuntimeSha256: "e".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION } });
}

async function completedLaunchFixture(root: string, value = inventory(2)) {
  const storedInventory = await storeCurrentLaunchInventory(root, value);
  const sourceManifest = structuredClone(manifest(value)) as any;
  sourceManifest.execution.promptVersion = "lab-deep-v26";
  sourceManifest.execution.validatorVersion = "deep-analysis-validator-v19";
  sourceManifest.execution.applicationFieldAnalysisVersion = "kordoc-application-roundtrip-v14";
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", sourceManifest, root);
  const sourceGrant = createAnalysisLaunchGrant({
    manifestSha256: storedManifest.sha256,
    targetCount: sourceManifest.targets.length,
    approvedBy: "test-reviewer",
    now: new Date("2026-09-09T20:01:00.000Z"),
  });
  const storedGrant = await writeAnalysisLaunchArtifact("grants", sourceGrant, root);
  const receipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-09T20:02:00.000Z",
    finishedAt: "2026-09-09T20:03:00.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: value.targets.length, held: 0, failed: 0, skipped: 0 },
    targets: value.targets.map((target) => ({
      sequence: target.sequence,
      grantId: target.grantId,
      status: "publishable" as const,
      runArtifactPath: `spike-out/runs/${target.sequence}.json`,
      runArtifactSha256: digest({ run: target.sequence }),
      applicationRoundtripStatus: "complete",
      applicationDocumentCount: 1,
      fieldReadyDocumentCount: 1,
      recognizedFieldCount: 1,
      error: null,
    })),
  };
  const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
  const binding: AnalysisLaunchCompletedCurrentInventoryBinding = {
    schema: "analysis-launch-completed-current-inventory-v1",
    inventorySha256: storedInventory.sha256,
    sourceManifestSha256: storedManifest.sha256,
    sourceGrantSha256: storedGrant.sha256,
    terminalReceiptSha256: storedReceipt.sha256,
  };
  return { value, sourceManifest, sourceGrant, receipt, binding };
}

test("완료된 v14 current inventory ancestry만 현행 v17 exact 재실행으로 재봉인한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-"));
  try {
    const fixture = await completedLaunchFixture(root);
    assert.throws(
      () => normalizeAnalysisLaunchManifest(fixture.sourceManifest),
      /source\/existing run 정책 결속/,
      "역사 v14 manifest는 live normalizer에서 계속 거부",
    );
    assert.equal(
      normalizeCompletedCurrentInventorySourceManifest(fixture.sourceManifest)
        .execution.applicationFieldAnalysisVersion,
      "kordoc-application-roundtrip-v14",
    );
    assert.deepEqual(
      await readAndVerifyCompletedCurrentInventoryLaunch(root, fixture.binding),
      fixture.value,
    );
    const resealed = buildCurrentInventoryLaunchManifest({
      inventory: fixture.value,
      inventorySha256: fixture.binding.inventorySha256,
      completedLaunch: fixture.binding,
      concurrency: 1,
      now: new Date("2026-09-09T20:04:00.000Z"),
      provenance: {
        gitSha: "2".repeat(40),
        packageRuntimeSha256: "f".repeat(64),
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      },
    });
    assert.equal(resealed.execution.applicationFieldAnalysisVersion, "kordoc-application-roundtrip-v19");
    assert.equal(resealed.execution.existingRunPolicy, "rerun_exact_targets");
    assert.deepEqual(resealed.source.completedLaunch, fixture.binding);
    assert.deepEqual(normalizeAnalysisLaunchManifest(resealed), resealed);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, resealed), fixture.value);
    assert.equal(shouldForceExactManifestReanalysis({
      existingRunPolicy: resealed.execution.existingRunPolicy,
      retryErrors: false,
    }), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("재봉인 ancestry의 4SHA·inventory 전체 범위·terminal receipt 결속을 fail-closed한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-tamper-"));
  try {
    const fixture = await completedLaunchFixture(root);
    const writeSource = async (change: (source: any) => void) => {
      const source = structuredClone(fixture.sourceManifest) as any;
      change(source);
      const storedManifest = await writeAnalysisLaunchArtifact("manifests", source, root);
      const grant = createAnalysisLaunchGrant({
        manifestSha256: storedManifest.sha256,
        targetCount: source.targets.length,
        approvedBy: "test-reviewer",
        now: new Date("2026-09-09T20:06:00.000Z"),
      });
      const storedGrant = await writeAnalysisLaunchArtifact("grants", grant, root);
      const receipt: AnalysisLaunchReceipt = {
        ...fixture.receipt,
        manifestSha256: storedManifest.sha256,
        grantSha256: storedGrant.sha256,
        summary: { publishable: source.targets.length, held: 0, failed: 0, skipped: 0 },
        targets: source.targets.map((target: any) => ({
          ...fixture.receipt.targets[0]!,
          sequence: target.sequence,
          grantId: target.grantId,
          runArtifactPath: `spike-out/runs/${target.sequence}.json`,
          runArtifactSha256: digest({ changedRun: target.sequence }),
        })),
      };
      const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
      return {
        source,
        binding: {
          ...fixture.binding,
          sourceManifestSha256: storedManifest.sha256,
          sourceGrantSha256: storedGrant.sha256,
          terminalReceiptSha256: storedReceipt.sha256,
        },
      };
    };
    const changedSeries = await writeSource((source) => { source.source.seriesId = "current-20260911"; });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, changedSeries.binding), /범위/);
    const changedModel = await writeSource((source) => { source.execution.model = "claude-sonnet-5"; });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, changedModel.binding), /범위/);
    const changedRange = await writeSource((source) => {
      source.source.sequenceTo = 2;
      source.targets.push({ ...source.targets[1], sequence: 2, grantId: id(20) });
    });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, changedRange.binding), /범위/);
    const v9 = await writeSource((source) => {
      source.execution.applicationFieldAnalysisVersion = "kordoc-application-roundtrip-v9";
    });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...v9.binding,
    }), /exact v14/);
    const swappedReceipt: AnalysisLaunchReceipt = {
      ...fixture.receipt,
      targets: [
        { ...fixture.receipt.targets[1]!, sequence: 0 },
        { ...fixture.receipt.targets[0]!, sequence: 1 },
      ],
    };
    const storedSwappedReceipt = await writeAnalysisLaunchArtifact("receipts", swappedReceipt, root);
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...fixture.binding, terminalReceiptSha256: storedSwappedReceipt.sha256,
    }), /receipt target/);
    const abortedReceipt: AnalysisLaunchReceipt = {
      ...fixture.receipt, stopReason: "aborted",
    };
    const storedAbortedReceipt = await writeAnalysisLaunchArtifact("receipts", abortedReceipt, root);
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...fixture.binding, terminalReceiptSha256: storedAbortedReceipt.sha256,
    }), /ancestry 결속/);
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...fixture.binding, sourceGrantSha256: "f".repeat(64),
    }), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("재봉인 production prepare는 current input/source/provenance를 봉인 직전 재검증한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-production-"));
  try {
    const fixture = await completedLaunchFixture(root);
    const provenance = {
      gitSha: "2".repeat(40),
      packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    };
    let provenanceReads = 0;
    let verifyReads = 0;
    let prepareReads = 0;
    const result = await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      now: () => new Date("2026-09-09T20:05:00.000Z"),
      readProvenance: async () => { provenanceReads += 1; return provenance; },
      verifyTarget: async (current, grantId) => {
        verifyReads += 1;
        assert.ok(current.targets.some((target) => target.grantId === grantId));
      },
      prepareTarget: async (grantId) => {
        prepareReads += 1;
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
    });
    assert.equal(result.manifest.execution.existingRunPolicy, "rerun_exact_targets");
    assert.equal(provenanceReads, 2);
    assert.equal(prepareReads, fixture.value.targets.length * 2);
    assert.equal(verifyReads, fixture.value.targets.length * 3);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, result.manifest), fixture.value);

    let writes = 0;
    let driftVerifyReads = 0;
    await assert.rejects(() => prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => provenance,
      verifyTarget: async () => {
        driftVerifyReads += 1;
        if (driftVerifyReads > fixture.value.targets.length * 2) throw new Error("공고 원천 drift");
      },
      prepareTarget: async (grantId) => {
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
      writeManifest: async () => { writes += 1; throw new Error("write must not run"); },
    }), /공고 원천 drift/);
    assert.equal(writes, 0, "마지막 prepare 뒤 source drift면 manifest를 저장하지 않음");

    let provenanceCall = 0;
    await assert.rejects(() => prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => ({
        ...provenance,
        packageRuntimeSha256: (++provenanceCall === 1 ? "f" : "e").repeat(64),
      }),
      verifyTarget: async () => {},
      prepareTarget: async (grantId) => {
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
      writeManifest: async () => { writes += 1; throw new Error("write must not run"); },
    }), /실행 코드가 변경/);
    assert.equal(writes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("재봉인 target의 input/attachment drift와 수동 rerun policy 삽입을 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-input-drift-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(1));
    assert.throws(() => buildCurrentInventoryLaunchManifest({
      inventory: fixture.value,
      inventorySha256: fixture.binding.inventorySha256,
      completedLaunch: fixture.binding,
      preparedTargets: [{ grantId: id(0), inputSha256: "f".repeat(64),
        attachmentManifestSha256: fixture.value.targets[0]!.attachmentManifestSha256 }],
      concurrency: 1,
      now: new Date(),
      provenance: { gitSha: "2".repeat(40), packageRuntimeSha256: "e".repeat(64),
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION },
    }), /현재 입력\/첨부/);
    const ordinary = manifest(fixture.value);
    assert.throws(() => normalizeAnalysisLaunchManifest({
      ...ordinary,
      execution: { ...ordinary.execution, existingRunPolicy: "rerun_exact_targets" },
    }), /source\/existing run 정책/);
    assert.throws(() => normalizeAnalysisLaunchManifest({
      ...ordinary,
      source: { ...ordinary.source, completedLaunch: {
        ...fixture.binding, inventorySha256: "e".repeat(64),
      } },
      execution: { ...ordinary.execution, existingRunPolicy: "rerun_exact_targets" },
    }), /source\/existing run 정책/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("현재 재고 47건은 독립 source로 봉인하며 deep-v35 100건 계약을 보존한다", () => {
  const result = manifest();
  assert.equal(result.source.kind, "current_inventory");
  assert.equal(result.targets.length, 47);
  assert.equal(result.execution.withApplicationRoundtrip, true);
  assert.equal(result.execution.roundtripModel, "claude-opus-5");
  assert.equal(result.execution.transport, "claude-cli");
  assert.equal(result.execution.concurrency, 2);
  assert.equal(result.execution.existingRunPolicy, "skip_existing");
  assert.deepEqual(normalizeAnalysisLaunchManifest(JSON.parse(encodeCanonical(result).toString())), result);
  assert.equal(deepRepairTargetCountForSeries("deep-v35"), 100);
  assert.equal(deepRepairTargetCountForSeries("deep-v31"), 50);
  assert.equal(manifest(inventory(1)).targets.length, 1);
  assert.equal(manifest(inventory(100)).targets.length, 100);
});

test("빈 재고·상한 초과·중복·잘못된 sequence·결속 SHA를 거부한다", () => {
  for (const count of [0, 101]) assert.throws(() => validateCurrentLaunchInventory(inventory(count)));
  const value = inventory(2);
  for (const changed of [
    { ...value, targets: [value.targets[0], value.targets[0]] },
    { ...value, targets: [{ ...value.targets[0], sequence: 1 }] },
    { ...value, targets: [{ ...value.targets[0], sourceRevisionSha256: "bad" }] },
    { ...value, targets: [{ ...value.targets[0], stratum: "unknown/thin" }] },
    { ...value, policy: "include_history" }, { ...value, seriesId: "deep-v35" },
    { ...value, observedAt: "invalid" },
  ]) assert.throws(() => validateCurrentLaunchInventory(changed));
  assert.throws(() => buildCurrentInventoryLaunchManifest({ inventory: value, inventorySha256: "f".repeat(64),
    concurrency: 2, now: new Date(), provenance: { gitSha: "1".repeat(40), packageRuntimeSha256: "e".repeat(64), validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION } }));
});

test("필드 분석 생략·API 전환·강제 재분석·repair 지시 삽입을 거부한다", () => {
  const value = manifest(inventory(1));
  for (const execution of [
    { ...value.execution, withApplicationRoundtrip: false, roundtripModel: null },
    { ...value.execution, transport: "api" },
    { ...value.execution, existingRunPolicy: "force_reanalysis" },
    { ...value.execution, roundtripModel: "other" },
  ]) assert.throws(() => normalizeAnalysisLaunchManifest({ ...value, execution }));
  assert.throws(() => normalizeAnalysisLaunchManifest({ ...value,
    targets: [{ ...value.targets[0], reviewRepair: { sourceRunId: "run-a", reviewModel: "model-a", blockingCount: 1, taskInstruction: "injected" } }] }));
  assert.throws(() => normalizeAnalysisLaunchManifest({ ...value,
    source: { ...value.source, planSha256: "f".repeat(64) } }));
});

test("봉인된 전체 대상만 허용하며 subset·대체·drift를 grant 전에 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-inventory-"));
  try {
    const source = inventory(2); await storeCurrentLaunchInventory(root, source);
    const value = manifest(source); await verifyCurrentInventoryLaunchBinding(root, value);
    for (const changed of [
      { ...value, targets: value.targets.slice(0, 1) },
      { ...value, targets: [{ ...value.targets[0]!, grantId: id(10) }, value.targets[1]!] },
      { ...value, targets: [{ ...value.targets[0]!, inputSha256: "f".repeat(64) }, value.targets[1]!] },
      { ...value, targets: [{ ...value.targets[0]!, changedSinceInventory: true }, value.targets[1]!] },
    ]) await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root, changed));
    // 재승인 없이도 grant 전체가 같은 exact inventory와 결속되도록 읽기 검증만 수행한다.
    const grant = createAnalysisLaunchGrant({ targetCount: value.targets.length, manifestSha256: digest(value), approvedBy: "test-reviewer", now: new Date() });
    assert.equal(grant.targetCount, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("미실행 inventory도 전체 과거 이력에서 제외하되 formal-baseline은 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-history-"));
  try {
    const value = inventory(2); const stored = await storeCurrentLaunchInventory(root, value);
    assert.deepEqual(await readCurrentLaunchInventory(root, stored.sha256), value);
    const rootDir = join(root, "spike-out", "analysis-lab");
    assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir, scope: "all" }), [id(0), id(1)]);
    assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir, scope: "formal-baseline" }), []);
    await writeFile(stored.path, "{}");
    await assert.rejects(() => readCurrentLaunchInventory(root, stored.sha256), /content address/);
    await assert.rejects(() => readDeepRepairHistoricalGrantIds({ rootDir, scope: "all" }), /SHA mismatch/);
    assert.throws(() => currentLaunchInventoryPath(root, "../../escape"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("명시된 exact IDs와 동시성만 CLI에서 허용한다", () => {
  assert.deepEqual(parseCurrentInventoryLaunchArgs(["--", `--grant-ids=${id(0)},${id(1)}`, "--concurrency=2"]), { grantIds: [id(0), id(1)], concurrency: 2 });
  for (const args of [[], [`--grant-ids=${id(0)},${id(0)}`, "--concurrency=2"],
    [`--grant-ids=${id(0)}`, "--concurrency=5"], [`--grant-ids=${id(0)}`, "--execute=true"],
    [`--grant-ids=${id(0)}`, "--grant-ids=other"], [`--grant-ids=${id(0)}`, "--concurrency=2", "--force=true"],
  ]) assert.throws(() => parseCurrentInventoryLaunchArgs(args));
});


test("대상 착수에서 범위 밖 ID·현재 지원 조건 실패·원천 변경을 거부한다", async () => {
  const value = inventory(1);
  let reads = 0;
  const read = async (ids: readonly string[]) => {
    reads++; assert.deepEqual(ids, [id(0)]);
    return [{ grantId: id(0), sourceRevisionSha256: "d".repeat(64) }];
  };
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(1), read));
  assert.equal(reads, 0);
  await verifyCurrentInventoryLaunchTarget(value, id(0), read);
  assert.equal(reads, 1);
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(0), async () => []));
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(0), async () => [{ grantId: id(0), sourceRevisionSha256: "e".repeat(64) }]));
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(0), async () => { throw new Error("공고 마감"); }), /공고 마감/);
});

test("과거 공고의 누락 필드 보완은 별도 정책으로 봉인하며 신규 모집단의 이력 제외를 보존한다", async () => {
  const unseen = inventory(1);
  assert.throws(() => assertCurrentInventoryHistoryEligibility([id(0)], [id(0)], unseen.policy), /과거 이력/);
  const repair: CurrentLaunchInventory = { ...unseen,
    policy: MISSING_WORKSPACE_FIELDS_POLICY, seriesId: "current-field-repair-20260910" };
  assertCurrentInventoryHistoryEligibility([id(0)], [id(0)], repair.policy);
  assert.throws(() => validateCurrentLaunchInventory({ ...repair, seriesId: unseen.seriesId }), /독립된/);
  assert.throws(() => validateCurrentLaunchInventory({ ...unseen, seriesId: repair.seriesId }), /독립된/);
  const launch = manifest(repair);
  assert.equal(launch.execution.withApplicationRoundtrip, true);
  assert.equal(launch.execution.transport, "claude-cli");
  assert.equal(launch.execution.existingRunPolicy, "skip_existing");
  assert.equal(launch.targets.length, 1);
  const historicalPrimaryWithoutRoundtrip = new Map([[
    id(0),
    {
      okCurrent: true,
      okOutdated: false,
      heldCurrent: false,
      errorCurrent: false,
      applicationFieldAnalysisReadyCurrent: false,
    },
  ]]);
  const scheduled = partitionCohortEntries(
    [{ grantId: id(0) }],
    historicalPrimaryWithoutRoundtrip,
    {
      retryErrors: false,
      reanalyzeOutdated: false,
      exactManifestReanalysis: shouldForceExactManifestReanalysis({
        existingRunPolicy: launch.execution.existingRunPolicy,
        retryErrors: false,
      }),
      requireApplicationFieldAnalysis: launch.execution.withApplicationRoundtrip,
    },
  );
  assert.deepEqual(scheduled.pending, [{ grantId: id(0) }]);
  assert.deepEqual(scheduled.skippedOk, []);
  const root = await mkdtemp(join(tmpdir(), "cunote-field-repair-"));
  try {
    await storeCurrentLaunchInventory(root, repair);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, launch), repair);
    await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root,
      { ...launch, source: { ...launch.source, seriesId: unseen.seriesId } }), /범위/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("누락 필드 보완은 필드 0개와 보관된 편집 양식이 필요하며 모델 착수 전 다시 확인한다", async () => {
  assertMissingWorkspaceFieldsState({ fieldCount: 0, editableSurfaceCount: 2 });
  for (const state of [
    { fieldCount: 1, editableSurfaceCount: 2 },
    { fieldCount: 0, editableSurfaceCount: 0 },
    { fieldCount: -1, editableSurfaceCount: 1 },
  ]) assert.throws(() => assertMissingWorkspaceFieldsState(state), /필드 0개/);
  const repair: CurrentLaunchInventory = { ...inventory(1),
    policy: MISSING_WORKSPACE_FIELDS_POLICY, seriesId: "current-field-repair-20260910" };
  let currentFieldCount = 0;
  const read = async (ids: readonly string[], policy: CurrentLaunchInventory["policy"]) => {
    assert.deepEqual(ids, [id(0)]);
    assert.equal(policy, MISSING_WORKSPACE_FIELDS_POLICY);
    assertMissingWorkspaceFieldsState({ fieldCount: currentFieldCount, editableSurfaceCount: 2 });
    return [{ grantId: id(0), sourceRevisionSha256: "d".repeat(64) }];
  };
  await verifyCurrentInventoryLaunchTarget(repair, id(0), read);
  currentFieldCount = 1;
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(repair, id(0), read), /필드 0개/);
});
