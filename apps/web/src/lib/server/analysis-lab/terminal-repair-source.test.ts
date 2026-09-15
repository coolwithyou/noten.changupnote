import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readTerminalRepairSource, selectTerminalRepairTargets } from "./terminal-repair-source";
import { parseTerminalRepairLaunchArgs } from "./terminal-repair-launch-cli";
import { buildCurrentInventoryLaunchManifest, storeCurrentLaunchInventory, verifyCurrentInventoryLaunchBinding,
  TERMINAL_REPAIR_POLICY, type CurrentLaunchInventory } from "./current-inventory-launch";
import { createAnalysisLaunchGrant, encodeCanonical, normalizeAnalysisLaunchManifest, writeAnalysisLaunchArtifact,
  type AnalysisLaunchReceipt, type AnalysisLaunchReceiptTarget } from "./launch-batch-artifacts";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";

const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const provenance = { gitSha: "1".repeat(40), packageRuntimeSha256: "e".repeat(64), validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION };
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

test("terminal repair CLI accepts only source binding and concurrency", () => {
  assert.equal(parseTerminalRepairLaunchArgs([`--source-manifest=${"a".repeat(64)}`, `--source-grant=${"b".repeat(64)}`, "--concurrency=1"]).concurrency, 1);
  assert.throws(() => parseTerminalRepairLaunchArgs(["--grant-ids=anything", "--concurrency=1"]));
  assert.throws(() => parseTerminalRepairLaunchArgs([`--source-manifest=${"a".repeat(64)}`, `--source-grant=${"b".repeat(64)}`, "--concurrency=5"]));
});
