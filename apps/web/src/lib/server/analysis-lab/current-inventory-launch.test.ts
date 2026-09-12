import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURRENT_INVENTORY_SCHEMA, buildCurrentInventoryLaunchManifest,
  MISSING_WORKSPACE_FIELDS_POLICY,
  currentLaunchInventoryPath, readCurrentLaunchInventory, storeCurrentLaunchInventory,
  validateCurrentLaunchInventory, verifyCurrentInventoryLaunchBinding,
  type CurrentLaunchInventory,
} from "./current-inventory-launch";
import { assertCurrentInventoryHistoryEligibility, assertMissingWorkspaceFieldsState, verifyCurrentInventoryLaunchTarget } from "./current-inventory-launch-production";
import { parseCurrentInventoryLaunchArgs } from "./current-inventory-launch-cli";
import { partitionCohortEntries } from "./batch-plan";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { deepRepairTargetCountForSeries } from "./deep-repair-formal-policy";
import { encodeCanonical, normalizeAnalysisLaunchManifest, createAnalysisLaunchGrant } from "./launch-batch-artifacts";
import { shouldForceExactManifestReanalysis } from "./launch-batch-production";
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
