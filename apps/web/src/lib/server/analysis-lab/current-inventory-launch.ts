import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCurrentInventoryAnalysisLaunchManifest,
  encodeCanonical,
  type AnalysisLaunchManifest,
  type AnalysisLaunchPlanTarget,
} from "./launch-batch-artifacts";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";

export const CURRENT_INVENTORY_SCHEMA = "analysis-current-inventory-v1" as const;
export const MISSING_WORKSPACE_FIELDS_POLICY = "open-visible-current-period-missing-fields-v1" as const;
export type CurrentInventoryPolicy = "open-visible-current-period-unseen-v1" | typeof MISSING_WORKSPACE_FIELDS_POLICY;
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
    || (inventory.policy !== "open-visible-current-period-unseen-v1" && inventory.policy !== MISSING_WORKSPACE_FIELDS_POLICY)
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
}): AnalysisLaunchManifest {
  const inventory = validateCurrentLaunchInventory(input.inventory);
  if (sha(encodeCanonical(inventory)) !== input.inventorySha256) throw new Error("current inventory SHA가 다릅니다.");
  return createCurrentInventoryAnalysisLaunchManifest({
    inventory: { ...inventory, planSha256: input.inventorySha256, planArtifactSha256: input.inventorySha256 },
    sequenceFrom: 0, sequenceTo: inventory.targets.length - 1,
    preparedTargets: inventory.targets,
    provenance: input.provenance, withApplicationRoundtrip: true,
    concurrency: input.concurrency, now: input.now,
  });
}

/** grant/실행에서 inventory를 다시 읽어 임의 target 대체와 봉인 파일 손상을 거부한다. */
export async function verifyCurrentInventoryLaunchBinding(root: string, manifest: AnalysisLaunchManifest) {
  if (manifest.source.kind !== "current_inventory") return null;
  const inventory = await readCurrentLaunchInventory(root, manifest.source.planArtifactSha256);
  if (manifest.source.planSha256 !== manifest.source.planArtifactSha256
    || manifest.source.seriesId !== inventory.seriesId || manifest.execution.model !== inventory.model
    || manifest.source.sequenceFrom !== 0 || manifest.targets.length !== inventory.targets.length) {
    throw new Error("launch와 current inventory 범위가 다릅니다.");
  }
  for (const [index, target] of inventory.targets.entries()) {
    const actual = manifest.targets[index];
    if (!actual || actual.sequence !== target.sequence || actual.grantId !== target.grantId
      || actual.stratum !== target.stratum || actual.inputSha256 !== target.inputSha256
      || actual.attachmentManifestSha256 !== target.attachmentManifestSha256
      || actual.inventoryInputSha256 !== target.inputSha256
      || actual.inventoryAttachmentManifestSha256 !== target.attachmentManifestSha256
      || actual.changedSinceInventory || actual.reviewRepair || actual.applicationRoundtripReuse) throw new Error("launch target이 current inventory와 다릅니다.");
  }
  return inventory;
}

function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
