import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readTerminalRepairSource, selectTerminalRepairTargets } from "./terminal-repair-source";
import { parseTerminalRepairLaunchArgs } from "./terminal-repair-launch-cli";
import { buildCurrentInventoryLaunchManifest, storeCurrentLaunchInventory, verifyCurrentInventoryLaunchBinding,
  TERMINAL_REPAIR_POLICY, type CurrentLaunchInventory } from "./current-inventory-launch";
import { createAnalysisLaunchGrant, encodeCanonical, normalizeAnalysisLaunchManifest, writeAnalysisLaunchArtifact,
  type AnalysisLaunchReceipt, type AnalysisLaunchReceiptTarget,
  type AnalysisLaunchTerminalRepairBinding } from "./launch-batch-artifacts";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";

const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const provenance = { gitSha: "1".repeat(40), packageRuntimeSha256: "e".repeat(64), validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION };
const REAL_REPAIR_MANIFEST = "51b6d453aae839d257fdc7dcb14d57b8af82fc486ea5bf8964867f1e968c65d3";
const REAL_REPAIR_GRANT = "d3ada92247040d18e2a445f6f61f7a3053dadf8fe7d980be481b2da7c4d7f62d";
const REAL_REPAIR_RECEIPT = "4a227717747b93c430559d4828e222cc8db2d450b11097d2f13adf2e28256712";
async function fixture(root: string, previousVersion = false) {
  const inventory: CurrentLaunchInventory = { schema: "analysis-current-inventory-v1", seriesId: "current-20260915",
    observedAt: "2026-09-15T00:00:00.000Z", model: "claude-opus-5", policy: "open-visible-current-period-unseen-v1",
    historicalGrantIdsSha256: "a".repeat(64), targets: [0, 1, 2].map(sequence => ({ sequence, grantId: id(sequence),
      stratum: "bizinfo/medium", inputSha256: "b".repeat(64), attachmentManifestSha256: "c".repeat(64), sourceRevisionSha256: "d".repeat(64) })) };
  const stored = await storeCurrentLaunchInventory(root, inventory);
  const manifest = buildCurrentInventoryLaunchManifest({ inventory, inventorySha256: stored.sha256, provenance,
    concurrency: 1, now: new Date("2026-09-15T00:01:00.000Z") });
  const historical = { ...manifest, execution: { ...manifest.execution, promptVersion: "lab-deep-v28",
    validatorVersion: previousVersion ? "deep-analysis-validator-v22" : "deep-analysis-validator-v21",
    applicationFieldAnalysisVersion: previousVersion ? "kordoc-application-roundtrip-v17" : "kordoc-application-roundtrip-v15" } };
  assert.throws(() => normalizeAnalysisLaunchManifest(historical), /정책/);
  const sourceManifest = await writeAnalysisLaunchArtifact("manifests", historical, root);
  const grant = await writeAnalysisLaunchArtifact("grants", createAnalysisLaunchGrant({ manifestSha256: sourceManifest.sha256,
    targetCount: 3, approvedBy: "fixture", now: new Date("2026-09-15T00:02:00.000Z") }), root);
  await mkdir(join(root, "spike-out/analysis-lab/runs"), { recursive: true });
  const runs = await Promise.all(inventory.targets.map(async t => {
    const bytes = encodeCanonical({ grantId: t.grantId, inputSha256: t.inputSha256, attachmentManifestSha256: t.attachmentManifestSha256 });
    const path = `spike-out/analysis-lab/runs/${t.sequence}.json`;
    await writeFile(join(root, path), bytes);
    return { path, sha256: sha(bytes) };
  }));
  const receipt = (statuses: AnalysisLaunchReceiptTarget["status"][], hour: number): AnalysisLaunchReceipt => ({
    schema: "analysis-launch-receipt-v1", grantSha256: grant.sha256, manifestSha256: sourceManifest.sha256,
    startedAt: `2026-09-15T0${hour}:00:00.000Z`, finishedAt: `2026-09-15T0${hour}:10:00.000Z`, lifecycle: "finished",
    stopReason: "completed", systemicFailure: null,
    summary: { publishable: statuses.filter(s => s === "publishable").length, held: statuses.filter(s => s === "held").length,
      failed: statuses.filter(s => s === "failed").length, skipped: statuses.filter(s => s === "skipped").length },
    targets: statuses.map((status, sequence) => ({ sequence, grantId: id(sequence), status,
      runArtifactPath: status === "skipped" ? null : runs[sequence]!.path,
      runArtifactSha256: status === "skipped" ? null : runs[sequence]!.sha256,
      applicationRoundtripStatus: null, applicationDocumentCount: null, fieldReadyDocumentCount: null,
      recognizedFieldCount: null, error: null })),
  });
  const first = receipt(["failed", "publishable", "skipped"], 1);
  const second = receipt(["skipped", "skipped", "held"], 2);
  const r1 = await writeAnalysisLaunchArtifact("receipts", first, root);
  const r2 = await writeAnalysisLaunchArtifact("receipts", second, root);
  return { inventory, manifest, sourceManifest, grant, receipt, first, second, r1, r2 };
}

type InventoryTarget = CurrentLaunchInventory["targets"][number];
async function writeRepairLayer(input: {
  root: string;
  parentBinding: AnalysisLaunchTerminalRepairBinding;
  parentTargets: readonly InventoryTarget[];
  statuses: readonly ("publishable" | "held" | "failed")[];
  layer: number;
}) {
  assert.equal(input.statuses.length, input.parentTargets.length);
  const inventory: CurrentLaunchInventory = {
    schema: "analysis-current-inventory-v1",
    seriesId: `current-terminal-repair-test-${input.layer}`,
    observedAt: new Date(Date.UTC(2026, 8, 15, 4, input.layer)).toISOString(),
    model: "claude-opus-5",
    policy: TERMINAL_REPAIR_POLICY,
    historicalGrantIdsSha256: sha(Buffer.from("terminal-repair-history")),
    targets: input.parentTargets.map((target, sequence) => ({
      ...target,
      sequence,
      inputSha256: sha(Buffer.from(`input-${input.layer}-${target.grantId}`)),
      attachmentManifestSha256: sha(Buffer.from(`attachment-${input.layer}-${target.grantId}`)),
    })),
  };
  const storedInventory = await storeCurrentLaunchInventory(input.root, inventory);
  const manifest = buildCurrentInventoryLaunchManifest({
    inventory,
    inventorySha256: storedInventory.sha256,
    provenance,
    concurrency: 1,
    now: new Date(Date.UTC(2026, 8, 15, 4, input.layer, 10)),
    terminalRepair: input.parentBinding,
  });
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", manifest, input.root);
  const grant = await writeAnalysisLaunchArtifact("grants", createAnalysisLaunchGrant({
    manifestSha256: storedManifest.sha256,
    targetCount: inventory.targets.length,
    approvedBy: "fixture",
    now: new Date(Date.UTC(2026, 8, 15, 4, input.layer, 20)),
  }), input.root);
  await mkdir(join(input.root, "spike-out/analysis-lab/runs"), { recursive: true });
  const runs = await Promise.all(inventory.targets.map(async (target) => {
    const bytes = encodeCanonical({ grantId: target.grantId, inputSha256: target.inputSha256,
      attachmentManifestSha256: target.attachmentManifestSha256 });
    const path = `spike-out/analysis-lab/runs/repair-${input.layer}-${target.sequence}.json`;
    await writeFile(join(input.root, path), bytes);
    return { path, sha256: sha(bytes) };
  }));
  const receiptValue: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: grant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: new Date(Date.UTC(2026, 8, 15, 5, input.layer, 0)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 8, 15, 5, input.layer, 30)).toISOString(),
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: {
      publishable: input.statuses.filter(status => status === "publishable").length,
      held: input.statuses.filter(status => status === "held").length,
      failed: input.statuses.filter(status => status === "failed").length,
      skipped: 0,
    },
    targets: input.statuses.map((status, sequence) => ({
      sequence,
      grantId: inventory.targets[sequence]!.grantId,
      status,
      runArtifactPath: runs[sequence]!.path,
      runArtifactSha256: runs[sequence]!.sha256,
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      error: null,
    })),
  };
  const receipt = await writeAnalysisLaunchArtifact("receipts", receiptValue, input.root);
  const binding: AnalysisLaunchTerminalRepairBinding = {
    schema: "analysis-launch-terminal-repair-v1",
    sourceManifestSha256: storedManifest.sha256,
    sourceGrantSha256: grant.sha256,
    receiptSha256s: [receipt.sha256],
    originalSequences: input.statuses.flatMap((status, sequence) => (
      status === "held" || status === "failed" ? [sequence] : []
    )),
  };
  return { inventory, manifest, storedManifest, grant, receipt, receiptValue, binding };
}

function selectedInventoryTargets(
  inventory: CurrentLaunchInventory,
  selected: readonly { sequence: number }[],
): InventoryTarget[] {
  return selected.map((target, sequence) => ({ ...inventory.targets[target.sequence]!, sequence }));
}

test("terminal repair: skipped preservation, latest outcomes, scope and chronology", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-terminal-repair-"));
  try {
    const f = await fixture(root);
    const receipts = [{ sha256: f.r1.sha256, receipt: f.first }, { sha256: f.r2.sha256, receipt: f.second }];
    assert.deepEqual(selectTerminalRepairTargets(f.manifest, receipts).map(t => t.sequence), [0, 2]);
    assert.deepEqual(selectTerminalRepairTargets(f.manifest, [...receipts, { sha256: "f".repeat(64),
      receipt: f.receipt(["publishable", "skipped", "skipped"], 3) }]).map(t => t.sequence), [2]);
    assert.throws(() => selectTerminalRepairTargets(f.manifest, receipts.slice(0, 1)), /미착수/);
    assert.throws(() => selectTerminalRepairTargets(f.manifest, [...receipts].reverse()), /시간/);
    const mismatch = { ...f.second, targets: f.second.targets.map((t, i) => i === 0 ? { ...t, grantId: id(99) } : t) };
    assert.throws(() => selectTerminalRepairTargets(f.manifest, [receipts[0]!, { sha256: "f".repeat(64), receipt: mismatch }]), /target/);
    assert.throws(() => selectTerminalRepairTargets(f.manifest, [{ sha256: "f".repeat(64), receipt: { ...f.second, stopReason: "aborted" } }]), /정상 종료/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sealed repair verifies source files, excludes success and rejects newly arriving receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-terminal-repair-"));
  try {
    const f = await fixture(root);
    const source = await readTerminalRepairSource(root, f.sourceManifest.sha256, f.grant.sha256);
    assert.deepEqual(source.binding.originalSequences, [0, 2]);
    const inventory: CurrentLaunchInventory = { ...f.inventory, policy: TERMINAL_REPAIR_POLICY,
      seriesId: "current-terminal-repair-20260915", targets: source.selected.map((t, sequence) => ({
        ...f.inventory.targets[t.sequence]!, sequence, inputSha256: "f".repeat(64) })) };
    const stored = await storeCurrentLaunchInventory(root, inventory);
    const args = { inventory, inventorySha256: stored.sha256, provenance, concurrency: 1, now: new Date() };
    assert.throws(() => buildCurrentInventoryLaunchManifest(args), /ancestry/);
    const manifest = buildCurrentInventoryLaunchManifest({ ...args, terminalRepair: source.binding });
    assert.equal(manifest.execution.existingRunPolicy, "rerun_exact_targets");
    assert.deepEqual(manifest.targets.map(t => t.grantId), [id(0), id(2)]);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, manifest), inventory);
    const forged = { ...manifest, source: { ...manifest.source, terminalRepair: { ...source.binding, originalSequences: [1, 2] } } };
    await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root, forged), /최종 실패/);
    const runPath = join(root, "spike-out/analysis-lab/runs/0.json");
    const bytes = await readFile(runPath); await writeFile(runPath, "{}");
    await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root, manifest), /원 run SHA/);
    await writeFile(runPath, bytes);
    await writeAnalysisLaunchArtifact("receipts", f.receipt(["publishable", "skipped", "skipped"], 3), root);
    await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root, manifest), /최종 실패/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v17 종료 receipt는 v18 전환 후에도 성공을 보존하며 오프라인 repair 원본으로 읽힌다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-terminal-v17-"));
  try {
    const f = await fixture(root, true);
    const source = await readTerminalRepairSource(root, f.sourceManifest.sha256, f.grant.sha256);
    assert.equal(source.manifest.execution.applicationFieldAnalysisVersion, "kordoc-application-roundtrip-v17");
    assert.deepEqual(source.binding.originalSequences, [0, 2]);
    assert.throws(() => normalizeAnalysisLaunchManifest(source.manifest), /정책/,
      "역사 receipt 소비를 기존 v17 live 실행 권한으로 승격하지 않는다");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("실제 v17 terminal repair의 후속 repair는 성공 5건을 제외하고 local seq1만 선택한다", {
  skip: !(await Promise.all([
    ["manifests", REAL_REPAIR_MANIFEST], ["grants", REAL_REPAIR_GRANT], ["receipts", REAL_REPAIR_RECEIPT],
  ].map(async ([kind, digest]) => {
    try {
      await access(join(process.cwd(), `spike-out/analysis-lab/launch/${kind}/${digest}.json`));
      return true;
    } catch { return false; }
  }))).every(Boolean),
}, async () => {
  const source = await readTerminalRepairSource(process.cwd(), REAL_REPAIR_MANIFEST, REAL_REPAIR_GRANT);
  assert.deepEqual(source.binding.receiptSha256s, [REAL_REPAIR_RECEIPT]);
  assert.deepEqual(source.binding.originalSequences, [1]);
  assert.deepEqual(source.selected.map(target => ({ sequence: target.sequence, grantId: target.grantId })), [{
    sequence: 1,
    grantId: "925bf2f1-6bbb-44b1-9dfe-27b3dc56ad9b",
  }]);
  assert.equal(source.manifest.source.terminalRepair?.originalSequences[1], 23,
    "root seq23은 검증된 부모 ancestry에서 감사 가능해야 한다");
});

test("repair-of-repair는 full ancestry를 검증하고 현재 부모의 실패·보류만 봉인한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-terminal-nested-"));
  try {
    const base = await fixture(root, true);
    const parent = await readTerminalRepairSource(root, base.sourceManifest.sha256, base.grant.sha256);
    const repair = await writeRepairLayer({
      root,
      parentBinding: parent.binding,
      parentTargets: selectedInventoryTargets(base.inventory, parent.selected),
      statuses: ["publishable", "held"],
      layer: 1,
    });
    const nested = await readTerminalRepairSource(root, repair.storedManifest.sha256, repair.grant.sha256);
    assert.deepEqual(nested.binding.originalSequences, [1], "binding은 immediate source의 local sequence를 유지한다");
    assert.deepEqual(nested.selected.map(target => target.grantId), [id(2)]);
    assert.equal(repair.manifest.source.terminalRepair?.originalSequences[1], 2,
      "root sequence는 부모 binding을 따라 감사할 수 있다");

    const successorInventory: CurrentLaunchInventory = {
      ...repair.inventory,
      seriesId: "current-terminal-repair-test-successor",
      targets: selectedInventoryTargets(repair.inventory, nested.selected),
    };
    const stored = await storeCurrentLaunchInventory(root, successorInventory);
    const successor = buildCurrentInventoryLaunchManifest({ inventory: successorInventory,
      inventorySha256: stored.sha256, provenance, concurrency: 1, now: new Date(), terminalRepair: nested.binding });
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, successor), successorInventory);

    await writeAnalysisLaunchArtifact("receipts", base.receipt(["publishable", "skipped", "skipped"], 3), root);
    await assert.rejects(
      () => readTerminalRepairSource(root, repair.storedManifest.sha256, repair.grant.sha256),
      /조상 receipt 집합 또는 최종 대상/,
      "이미 봉인된 부모보다 아래 계층에 receipt가 추가돼도 거부한다",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repair-of-repair는 부모 target 재배열과 과도한 ancestry 깊이를 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-terminal-nested-reject-"));
  try {
    const base = await fixture(root);
    const parent = await readTerminalRepairSource(root, base.sourceManifest.sha256, base.grant.sha256);
    const parentTargets = selectedInventoryTargets(base.inventory, parent.selected);
    const reordered = await writeRepairLayer({
      root,
      parentBinding: parent.binding,
      parentTargets: [...parentTargets].reverse().map((target, sequence) => ({ ...target, sequence })),
      statuses: ["held", "held"],
      layer: 1,
    });
    await assert.rejects(
      () => readTerminalRepairSource(root, reordered.storedManifest.sha256, reordered.grant.sha256),
      /조상 최종 실패·보류 대상과 source target/,
    );

    let binding = parent.binding;
    let targets: readonly InventoryTarget[] = parentTargets;
    let deepest: Awaited<ReturnType<typeof writeRepairLayer>> | null = null;
    for (let layer = 1; layer <= 16; layer += 1) {
      deepest = await writeRepairLayer({ root, parentBinding: binding, parentTargets: targets,
        statuses: targets.map(() => "held" as const), layer: layer + 10 });
      binding = deepest.binding;
      targets = deepest.inventory.targets;
    }
    assert.ok(deepest);
    await assert.rejects(
      () => readTerminalRepairSource(root, deepest!.storedManifest.sha256, deepest!.grant.sha256),
      /ancestry 깊이/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal repair CLI accepts only source binding and concurrency", () => {
  assert.equal(parseTerminalRepairLaunchArgs([`--source-manifest=${"a".repeat(64)}`, `--source-grant=${"b".repeat(64)}`, "--concurrency=1"]).concurrency, 1);
  assert.throws(() => parseTerminalRepairLaunchArgs(["--grant-ids=anything", "--concurrency=1"]));
  assert.throws(() => parseTerminalRepairLaunchArgs([`--source-manifest=${"a".repeat(64)}`, `--source-grant=${"b".repeat(64)}`, "--concurrency=5"]));
});
