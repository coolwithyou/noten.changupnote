import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCurrentInventoryAnalysisLaunchManifest,
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchReceipt,
  normalizeCompletedCurrentInventorySourceManifest,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchCompletedCurrentInventoryBinding,
  type AnalysisLaunchTerminalRepairBinding,
  type AnalysisLaunchManifest,
  type AnalysisLaunchPreparedTarget,
  type AnalysisLaunchPlanTarget,
} from "./launch-batch-artifacts";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { readTerminalRepairSource } from "./terminal-repair-source";

export const CURRENT_INVENTORY_SCHEMA = "analysis-current-inventory-v1" as const;
export const MISSING_WORKSPACE_FIELDS_POLICY = "open-visible-current-period-missing-fields-v1" as const;
export const TERMINAL_REPAIR_POLICY = "open-visible-current-period-terminal-repair-v1" as const;
export type CurrentInventoryPolicy = "open-visible-current-period-unseen-v1" | typeof MISSING_WORKSPACE_FIELDS_POLICY | typeof TERMINAL_REPAIR_POLICY;
export interface CurrentLaunchInventory {
  readonly schema: typeof CURRENT_INVENTORY_SCHEMA;
  readonly seriesId: string;
  readonly observedAt: string;
  readonly model: string;
  readonly policy: CurrentInventoryPolicy;
  readonly historicalGrantIdsSha256: string;
  readonly targets: readonly (AnalysisLaunchPlanTarget & {
    readonly sourceRevisionSha256: string;
  })[];
}

const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function validateCurrentLaunchInventory(value: unknown): CurrentLaunchInventory {
  if (!value || typeof value !== "object") throw new Error("current inventory가 없습니다.");
  const inventory = value as CurrentLaunchInventory;
  if (inventory.schema !== CURRENT_INVENTORY_SCHEMA
    || (inventory.policy !== "open-visible-current-period-unseen-v1" && inventory.policy !== MISSING_WORKSPACE_FIELDS_POLICY && inventory.policy !== TERMINAL_REPAIR_POLICY)
    || typeof inventory.seriesId !== "string"
    || !/^current-[a-z0-9][a-z0-9-]{0,70}$/u.test(inventory.seriesId)
    || typeof inventory.model !== "string" || !inventory.model.trim()
    || typeof inventory.observedAt !== "string"
    || !Number.isFinite(Date.parse(inventory.observedAt))
    || !SHA.test(inventory.historicalGrantIdsSha256)
    || !Array.isArray(inventory.targets) || inventory.targets.length < 1
    || inventory.targets.length > 100) throw new Error("current inventory 계약이 잘못됐습니다.");
  if ((inventory.policy === MISSING_WORKSPACE_FIELDS_POLICY) !== inventory.seriesId.startsWith("current-field-repair-")) {
    throw new Error("누락 필드 보완은 독립된 field-repair inventory로 봉인해야 합니다.");
  }
  if ((inventory.policy === TERMINAL_REPAIR_POLICY) !== inventory.seriesId.startsWith("current-terminal-repair-")) {
    throw new Error("terminal repair는 독립된 inventory로 봉인해야 합니다.");
  }
  const ids = new Set<string>();
  for (const [index, target] of inventory.targets.entries()) {
    if (!target || target.sequence !== index || !UUID.test(target.grantId)
      || ids.has(target.grantId) || typeof target.stratum !== "string"
      || !/^(bizinfo|kstartup)\/(thin|medium|thick)$/u.test(target.stratum)
      || !SHA.test(target.inputSha256) || !SHA.test(target.attachmentManifestSha256)
      || !SHA.test(target.sourceRevisionSha256)) throw new Error("current inventory target 결속이 잘못됐습니다.");
    ids.add(target.grantId);
  }
  return inventory;
}

export function currentLaunchInventoryPath(root: string, digest: string): string {
  if (!SHA.test(digest)) throw new Error("current inventory SHA가 잘못됐습니다.");
  return join(root, "spike-out", "analysis-lab", "launch", "inventories", `${digest}.json`);
}

export async function readCurrentLaunchInventory(root: string, digest: string): Promise<CurrentLaunchInventory> {
  const bytes = await readFile(currentLaunchInventoryPath(root, digest));
  if (sha(bytes) !== digest) throw new Error("current inventory content address가 다릅니다.");
  const value = validateCurrentLaunchInventory(JSON.parse(bytes.toString("utf8")));
  if (!bytes.equals(encodeCanonical(value))) throw new Error("current inventory canonical bytes가 다릅니다.");
  return value;
}

export async function storeCurrentLaunchInventory(root: string, value: CurrentLaunchInventory) {
  const inventory = validateCurrentLaunchInventory(value);
  const bytes = encodeCanonical(inventory);
  const digest = sha(bytes);
  const path = currentLaunchInventoryPath(root, digest);
  await writeImmutableBytesAtomic(path, bytes);
  await readCurrentLaunchInventory(root, digest);
  return { sha256: digest, path };
}

export function buildCurrentInventoryLaunchManifest(input: {
  readonly inventory: CurrentLaunchInventory;
  readonly inventorySha256: string;
  readonly provenance: { gitSha: string; packageRuntimeSha256: string; validatorVersion: string };
  readonly concurrency: number;
  readonly now: Date;
  readonly completedLaunch?: AnalysisLaunchCompletedCurrentInventoryBinding;
  readonly terminalRepair?: AnalysisLaunchTerminalRepairBinding;
  readonly preparedTargets?: readonly AnalysisLaunchPreparedTarget[];
}): AnalysisLaunchManifest {
  const inventory = validateCurrentLaunchInventory(input.inventory);
  if ((inventory.policy === TERMINAL_REPAIR_POLICY) !== Boolean(input.terminalRepair)) throw new Error("terminal repair ancestry가 필요합니다.");
  if (sha(encodeCanonical(inventory)) !== input.inventorySha256) throw new Error("current inventory SHA가 다릅니다.");
  const manifest = createCurrentInventoryAnalysisLaunchManifest({
    inventory: { ...inventory, planSha256: input.inventorySha256, planArtifactSha256: input.inventorySha256 },
    sequenceFrom: 0, sequenceTo: inventory.targets.length - 1,
    preparedTargets: input.preparedTargets ?? inventory.targets,
    provenance: input.provenance, withApplicationRoundtrip: true,
    concurrency: input.concurrency, now: input.now,
    ...(input.completedLaunch ? { completedLaunch: input.completedLaunch } : {}),
    ...(input.terminalRepair ? { terminalRepair: input.terminalRepair } : {}),
  });
  if (input.completedLaunch && manifest.targets.some((target) => target.changedSinceInventory)) {
    throw new Error("완료 launch 재봉인 target의 현재 입력/첨부가 원본 inventory와 다릅니다.");
  }
  return manifest;
}

/** grant/실행에서 inventory를 다시 읽어 임의 target 대체와 봉인 파일 손상을 거부한다. */
export async function verifyCurrentInventoryLaunchBinding(root: string, manifest: AnalysisLaunchManifest) {
  if (manifest.source.kind !== "current_inventory") return null;
  const inventory = await readCurrentLaunchInventory(root, manifest.source.planArtifactSha256);
  assertCurrentInventoryManifestBinding(manifest, inventory);
  if (manifest.source.completedLaunch) {
    await readAndVerifyCompletedCurrentInventoryLaunch(root, manifest.source.completedLaunch, inventory);
  }
  if ((inventory.policy === TERMINAL_REPAIR_POLICY) !== Boolean(manifest.source.terminalRepair)) throw new Error("terminal repair inventory 정책이 다릅니다.");
  if (manifest.source.terminalRepair) {
    const binding = manifest.source.terminalRepair;
    const source = await readTerminalRepairSource(root, binding.sourceManifestSha256, binding.sourceGrantSha256);
    if (!encodeCanonical(binding).equals(encodeCanonical(source.binding))
      || !encodeCanonical(inventory.targets.map(t => t.grantId)).equals(encodeCanonical(source.selected.map(t => t.grantId)))) {
      throw new Error("terminal repair 최종 실패·보류 대상 또는 receipt 집합이 변경됐습니다.");
    }
  }
  return inventory;
}

export function assertCurrentInventoryManifestBinding(
  manifest: AnalysisLaunchManifest,
  inventory: CurrentLaunchInventory,
): void {
  if (manifest.source.planSha256 !== manifest.source.planArtifactSha256
    || manifest.source.seriesId !== inventory.seriesId || manifest.execution.model !== inventory.model
    || manifest.source.sequenceFrom !== 0 || manifest.targets.length !== inventory.targets.length) {
    throw new Error("launch와 current inventory 범위가 다릅니다.");
  }
  assertCurrentInventoryManifestTargets(manifest, inventory);
}

function assertCurrentInventoryManifestTargets(
  manifest: AnalysisLaunchManifest,
  inventory: CurrentLaunchInventory,
): void {
  for (const [index, target] of inventory.targets.entries()) {
    const actual = manifest.targets[index];
    if (!actual || actual.sequence !== target.sequence || actual.grantId !== target.grantId
      || actual.stratum !== target.stratum || actual.inputSha256 !== target.inputSha256
      || actual.attachmentManifestSha256 !== target.attachmentManifestSha256
      || actual.inventoryInputSha256 !== target.inputSha256
      || actual.inventoryAttachmentManifestSha256 !== target.attachmentManifestSha256
      || actual.changedSinceInventory || actual.reviewRepair || actual.applicationRoundtripReuse) throw new Error("launch target이 current inventory와 다릅니다.");
  }
}

export async function readAndVerifyCompletedCurrentInventoryLaunch(
  root: string,
  binding: AnalysisLaunchCompletedCurrentInventoryBinding,
  expectedInventory?: CurrentLaunchInventory,
): Promise<CurrentLaunchInventory> {
  const inventory = await readCurrentLaunchInventory(root, binding.inventorySha256);
  if (expectedInventory && !encodeCanonical(expectedInventory).equals(encodeCanonical(inventory))) {
    throw new Error("재봉인 ancestry inventory가 새 manifest inventory와 다릅니다.");
  }
  const sourceManifest = normalizeCompletedCurrentInventorySourceManifest(
    await readAnalysisLaunchArtifact("manifests", binding.sourceManifestSha256, root),
  );
  const sourceGrant = normalizeAnalysisLaunchGrant(
    await readAnalysisLaunchArtifact("grants", binding.sourceGrantSha256, root),
  );
  const receipt = normalizeAnalysisLaunchReceipt(
    await readAnalysisLaunchArtifact("receipts", binding.terminalReceiptSha256, root),
  );
  if (
    sourceManifest.source.planSha256 !== binding.inventorySha256
    || sourceManifest.source.planArtifactSha256 !== binding.inventorySha256
    || sourceGrant.manifestSha256 !== binding.sourceManifestSha256
    || sourceGrant.targetCount !== sourceManifest.targets.length
    || receipt.manifestSha256 !== binding.sourceManifestSha256
    || receipt.grantSha256 !== binding.sourceGrantSha256
    || receipt.stopReason !== "completed"
    || receipt.systemicFailure !== null
    || receipt.targets.length !== sourceManifest.targets.length
  ) {
    throw new Error("완료 current inventory launch ancestry 결속이 다릅니다.");
  }
  assertCurrentInventoryManifestBinding(sourceManifest, inventory);
  for (const [index, sourceTarget] of sourceManifest.targets.entries()) {
    const receiptTarget = receipt.targets[index];
    if (
      !receiptTarget
      || receiptTarget.sequence !== sourceTarget.sequence
      || receiptTarget.grantId !== sourceTarget.grantId
    ) {
      throw new Error("완료 launch receipt target이 manifest와 다릅니다.");
    }
  }
  return inventory;
}

function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
