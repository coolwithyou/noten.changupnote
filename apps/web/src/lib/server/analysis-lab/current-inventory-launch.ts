import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCurrentInventoryAnalysisLaunchManifest,
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  normalizeCompletedAnalysisLaunchManifestForOfflineConsumption,
  normalizeCompletedCurrentInventorySourceManifest,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchCompletedCurrentInventoryBinding,
  type AnalysisLaunchPrimaryReuseBinding,
  type AnalysisLaunchTerminalRepairBinding,
  type AnalysisLaunchManifest,
  type AnalysisLaunchPreparedTarget,
  type AnalysisLaunchPlanTarget,
} from "./launch-batch-artifacts";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import type { LabRun } from "./lab-contract";
import { classifyLabRunOutcome } from "./run-outcome";
import { readTerminalRepairSource } from "./terminal-repair-source";

export const CURRENT_INVENTORY_SCHEMA = "analysis-current-inventory-v1" as const;
export const MATCHING_MATERIAL_SOURCE_BINDING_SCHEMA = "analysis-matching-material-source-binding-v1" as const;
export const MISSING_WORKSPACE_FIELDS_POLICY = "open-visible-current-period-missing-fields-v1" as const;
export const TERMINAL_REPAIR_POLICY = "open-visible-current-period-terminal-repair-v1" as const;
export const MATCHING_CAMPAIGN_POLICY = "open-visible-current-period-matching-campaign-v1" as const;
export type CurrentInventoryPolicy = "open-visible-current-period-unseen-v1" | typeof MISSING_WORKSPACE_FIELDS_POLICY | typeof TERMINAL_REPAIR_POLICY | typeof MATCHING_CAMPAIGN_POLICY;
export interface CurrentLaunchInventory {
  readonly schema: typeof CURRENT_INVENTORY_SCHEMA;
  readonly seriesId: string;
  readonly observedAt: string;
  readonly model: string;
  readonly policy: CurrentInventoryPolicy;
  readonly historicalGrantIdsSha256: string;
  readonly targets: readonly (AnalysisLaunchPlanTarget & {
    readonly sourceRevisionSha256: string;
    readonly matchingMaterialSourceBinding?: {
      readonly schema: typeof MATCHING_MATERIAL_SOURCE_BINDING_SCHEMA;
      readonly materialSourceRevisionSha256: string;
      /** 준비 시점 원문 provenance이며 matching-only 착수 drift 판정에는 사용하지 않는다. */
      readonly sourceRawSha256: string;
    };
  })[];
}

const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function validateCurrentLaunchInventory(value: unknown): CurrentLaunchInventory {
  if (!value || typeof value !== "object") throw new Error("current inventory가 없습니다.");
  const inventory = value as CurrentLaunchInventory;
  if (inventory.schema !== CURRENT_INVENTORY_SCHEMA
    || (inventory.policy !== "open-visible-current-period-unseen-v1" && inventory.policy !== MISSING_WORKSPACE_FIELDS_POLICY && inventory.policy !== TERMINAL_REPAIR_POLICY && inventory.policy !== MATCHING_CAMPAIGN_POLICY)
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
  if ((inventory.policy === MATCHING_CAMPAIGN_POLICY) !== inventory.seriesId.startsWith("current-matching-campaign-")) {
    throw new Error("matching campaign은 독립된 campaign inventory로 봉인해야 합니다.");
  }
  const ids = new Set<string>();
  let matchingMaterialBindingCount = 0;
  for (const [index, target] of inventory.targets.entries()) {
    if (!target || target.sequence !== index || !UUID.test(target.grantId)
      || ids.has(target.grantId) || typeof target.stratum !== "string"
      || !/^(bizinfo|kstartup)\/(thin|medium|thick)$/u.test(target.stratum)
      || !SHA.test(target.inputSha256) || !SHA.test(target.attachmentManifestSha256)
      || !SHA.test(target.sourceRevisionSha256)) throw new Error("current inventory target 결속이 잘못됐습니다.");
    if (target.matchingMaterialSourceBinding !== undefined) {
      const binding = target.matchingMaterialSourceBinding;
      if (binding.schema !== MATCHING_MATERIAL_SOURCE_BINDING_SCHEMA
        || !SHA.test(binding.materialSourceRevisionSha256)
        || !SHA.test(binding.sourceRawSha256)) {
        throw new Error("current inventory matching material 결속이 잘못됐습니다.");
      }
      matchingMaterialBindingCount += 1;
    }
    ids.add(target.grantId);
  }
  if (matchingMaterialBindingCount !== 0 && matchingMaterialBindingCount !== inventory.targets.length) {
    throw new Error("current inventory matching material 결속은 전체 target에 필요합니다.");
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
  readonly analysisMode?: AnalysisLaunchManifest["execution"]["analysisMode"];
  readonly primaryReuse?: readonly AnalysisLaunchPrimaryReuseBinding[];
}): AnalysisLaunchManifest {
  const inventory = validateCurrentLaunchInventory(input.inventory);
  const analysisMode = input.analysisMode ?? "primary_and_application";
  if ((inventory.policy === TERMINAL_REPAIR_POLICY) !== Boolean(input.terminalRepair)) throw new Error("terminal repair ancestry가 필요합니다.");
  if (sha(encodeCanonical(inventory)) !== input.inventorySha256) throw new Error("current inventory SHA가 다릅니다.");
  const projectedTargets = completedLaunchProjectionTargets(inventory, input.completedLaunch);
  const projectedInventory = {
    ...inventory,
    targets: projectedTargets,
    planSha256: input.inventorySha256,
    planArtifactSha256: input.inventorySha256,
  };
  if ((input.primaryReuse?.length ?? 0) !== (analysisMode === "application_only" ? projectedTargets.length : 0)) {
    throw new Error("application-only primary 재사용 target 수가 다릅니다.");
  }
  const baseManifest = createCurrentInventoryAnalysisLaunchManifest({
    inventory: projectedInventory,
    sequenceFrom: 0, sequenceTo: projectedTargets.length - 1,
    preparedTargets: input.preparedTargets ?? projectedTargets,
    provenance: input.provenance,
    analysisMode: analysisMode === "application_only" ? "primary_and_application" : analysisMode,
    withApplicationRoundtrip: analysisMode !== "matching_only",
    concurrency: input.concurrency, now: input.now,
    ...(input.completedLaunch ? { completedLaunch: input.completedLaunch } : {}),
    ...(input.terminalRepair ? { terminalRepair: input.terminalRepair } : {}),
  });
  const manifest = analysisMode === "application_only"
    ? normalizeAnalysisLaunchManifest({
        ...baseManifest,
        execution: {
          ...baseManifest.execution,
          analysisMode,
        },
        targets: baseManifest.targets.map((target, index) => ({
          ...target,
          primaryReuse: input.primaryReuse![index],
        })),
      })
    : baseManifest;
  if (input.completedLaunch && manifest.targets.some((target) => target.changedSinceInventory)) {
    throw new Error("완료 launch 재봉인 target의 현재 입력/첨부가 원본 inventory와 다릅니다.");
  }
  return manifest;
}

/** grant/실행에서 inventory를 다시 읽어 임의 target 대체와 봉인 파일 손상을 거부한다. */
export async function verifyCurrentInventoryLaunchBinding(root: string, manifest: AnalysisLaunchManifest) {
  return verifyCurrentInventoryLaunchBindingWithContext(root, manifest, {
    completedManifestSha256s: new Set(),
    depth: 0,
  });
}

const MAX_COMPLETED_LAUNCH_ANCESTRY_DEPTH = 16;
interface CompletedLaunchAncestryContext {
  readonly completedManifestSha256s: ReadonlySet<string>;
  readonly depth: number;
}

async function verifyCurrentInventoryLaunchBindingWithContext(
  root: string,
  manifest: AnalysisLaunchManifest,
  context: CompletedLaunchAncestryContext,
) {
  if (manifest.source.kind !== "current_inventory") return null;
  const inventory = await readCurrentLaunchInventory(root, manifest.source.planArtifactSha256);
  assertCurrentInventoryManifestBinding(manifest, inventory);
  if (manifest.source.completedLaunch) {
    const completed = await readAndVerifyCompletedCurrentInventoryLaunchDetailsWithContext(
      root,
      manifest.source.completedLaunch,
      inventory,
      context,
    );
    const expectedTerminalRepair = completed.sourceManifest.source.terminalRepair;
    if (Boolean(manifest.source.terminalRepair) !== Boolean(expectedTerminalRepair)
      || (manifest.source.terminalRepair && expectedTerminalRepair
        && !encodeCanonical(manifest.source.terminalRepair).equals(encodeCanonical(expectedTerminalRepair)))) {
      throw new Error("완료 launch의 terminal repair ancestry가 새 manifest에 그대로 결속되지 않았습니다.");
    }
    await verifyApplicationOnlyPrimaryReuse(root, manifest, completed);
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

async function verifyApplicationOnlyPrimaryReuse(
  root: string,
  manifest: AnalysisLaunchManifest,
  completed: VerifiedCompletedCurrentInventoryLaunch,
): Promise<void> {
  if (manifest.execution.analysisMode !== "application_only") return;
  for (const target of manifest.targets) {
    const reuse = target.primaryReuse;
    const receiptTarget = completed.receipt.targets.find((item) => item.grantId === target.grantId);
    if (
      !reuse
      || !receiptTarget?.runArtifactPath
      || !receiptTarget.runArtifactSha256
      || reuse.sourceSequence !== receiptTarget.sequence
      || reuse.sourceLabRunArtifactPath !== receiptTarget.runArtifactPath
      || reuse.sourceLabRunArtifactSha256 !== receiptTarget.runArtifactSha256
      || reuse.sourceLaunchReceiptSha256 !== manifest.source.completedLaunch?.terminalReceiptSha256
    ) {
      throw new Error("application-only primary 재사용이 완료 receipt와 다릅니다.");
    }
    const bytes = await readFile(join(root, reuse.sourceLabRunArtifactPath));
    if (sha(bytes) !== reuse.sourceLabRunArtifactSha256) {
      throw new Error("application-only primary 재사용 artifact SHA가 다릅니다.");
    }
    const run = JSON.parse(bytes.toString("utf8")) as LabRun;
    if (
      run.runId !== reuse.sourceLabRunId
      || run.grantId !== target.grantId
      || run.inputSha256 !== target.inputSha256
      || run.attachmentManifestSha256 !== target.attachmentManifestSha256
      || run.model !== manifest.execution.model
      || run.transport !== manifest.execution.transport
      || run.promptVersion !== manifest.execution.promptVersion
      || classifyLabRunOutcome(run) !== "publishable"
      || (run.matchingReadiness !== "ready" && run.matchingReadiness !== "conditional")
      || !run.primaryRepairProvenance
      || run.primaryMatchingProjection?.verification !== "verified"
    ) {
      throw new Error("application-only primary 재사용 run 계약이 다릅니다.");
    }
  }
}

export function assertCurrentInventoryManifestBinding(
  manifest: AnalysisLaunchManifest,
  inventory: CurrentLaunchInventory,
): void {
  const expectedTargets = completedLaunchProjectionTargets(inventory, manifest.source.completedLaunch);
  if (manifest.source.planSha256 !== manifest.source.planArtifactSha256
    || manifest.source.seriesId !== inventory.seriesId || manifest.execution.model !== inventory.model
    || manifest.source.sequenceFrom !== 0 || manifest.targets.length !== expectedTargets.length) {
    throw new Error("launch와 current inventory 범위가 다릅니다.");
  }
  if (
    manifest.source.completedLaunch?.schema === "analysis-launch-completed-current-inventory-v2"
    && manifest.source.terminalRepair
    && manifest.source.terminalRepair.originalSequences.length !== inventory.targets.length
  ) {
    throw new Error("완료 terminal repair ancestry 전체 범위가 원 inventory와 다릅니다.");
  }
  assertCurrentInventoryManifestTargets(manifest, expectedTargets);
}

function assertCurrentInventoryManifestTargets(
  manifest: AnalysisLaunchManifest,
  expectedTargets: CurrentLaunchInventory["targets"],
): void {
  for (const [index, target] of expectedTargets.entries()) {
    const actual = manifest.targets[index];
    if (!actual || actual.sequence !== target.sequence || actual.grantId !== target.grantId
      || actual.stratum !== target.stratum || actual.inputSha256 !== target.inputSha256
      || actual.attachmentManifestSha256 !== target.attachmentManifestSha256
      || actual.inventoryInputSha256 !== target.inputSha256
      || actual.inventoryAttachmentManifestSha256 !== target.attachmentManifestSha256
      || actual.changedSinceInventory || actual.reviewRepair || actual.applicationRoundtripReuse
      || (manifest.execution.analysisMode === "application_only") !== Boolean(actual.primaryReuse)) {
      throw new Error("launch target이 current inventory와 다릅니다.");
    }
  }
}

export async function readAndVerifyCompletedCurrentInventoryLaunch(
  root: string,
  binding: AnalysisLaunchCompletedCurrentInventoryBinding,
  expectedInventory?: CurrentLaunchInventory,
): Promise<CurrentLaunchInventory> {
  return (await readAndVerifyCompletedCurrentInventoryLaunchDetails(
    root,
    binding,
    expectedInventory,
  )).inventory;
}

export interface VerifiedCompletedCurrentInventoryLaunch {
  readonly inventory: CurrentLaunchInventory;
  readonly sourceManifest: AnalysisLaunchManifest;
  readonly receipt: ReturnType<typeof normalizeAnalysisLaunchReceipt>;
}

export async function readAndVerifyCompletedCurrentInventoryLaunchDetails(
  root: string,
  binding: AnalysisLaunchCompletedCurrentInventoryBinding,
  expectedInventory?: CurrentLaunchInventory,
): Promise<VerifiedCompletedCurrentInventoryLaunch> {
  return readAndVerifyCompletedCurrentInventoryLaunchDetailsWithContext(
    root,
    binding,
    expectedInventory,
    { completedManifestSha256s: new Set(), depth: 0 },
  );
}

async function readAndVerifyCompletedCurrentInventoryLaunchDetailsWithContext(
  root: string,
  binding: AnalysisLaunchCompletedCurrentInventoryBinding,
  expectedInventory: CurrentLaunchInventory | undefined,
  context: CompletedLaunchAncestryContext,
): Promise<VerifiedCompletedCurrentInventoryLaunch> {
  if (context.depth >= MAX_COMPLETED_LAUNCH_ANCESTRY_DEPTH) {
    throw new Error("completed current inventory ancestry 깊이가 허용 범위를 넘었습니다.");
  }
  if (context.completedManifestSha256s.has(binding.sourceManifestSha256)) {
    throw new Error("completed current inventory ancestry에 순환이 있습니다.");
  }
  const nextManifestSha256s = new Set(context.completedManifestSha256s);
  nextManifestSha256s.add(binding.sourceManifestSha256);
  const nextContext = {
    completedManifestSha256s: nextManifestSha256s,
    depth: context.depth + 1,
  };
  const inventory = await readCurrentLaunchInventory(root, binding.inventorySha256);
  if (expectedInventory && !encodeCanonical(expectedInventory).equals(encodeCanonical(inventory))) {
    throw new Error("재봉인 ancestry inventory가 새 manifest inventory와 다릅니다.");
  }
  const rawSourceManifest = await readAnalysisLaunchArtifact(
    "manifests",
    binding.sourceManifestSha256,
    root,
  );
  const sourceManifest = binding.schema === "analysis-launch-completed-current-inventory-v2"
    ? normalizeCompletedCurrentInventorySubsetSource(rawSourceManifest)
    : normalizeCompletedCurrentInventorySourceManifest(rawSourceManifest);
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
  await verifyCurrentInventoryLaunchBindingWithContext(root, sourceManifest, nextContext);
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
  if (binding.schema === "analysis-launch-completed-current-inventory-v2") {
    assertCompletedSubsetWasExecutedBySource({
      binding,
      inventory,
      sourceManifest,
      receipt,
    });
  }
  return Object.freeze({ inventory, sourceManifest, receipt });
}

function assertCompletedSubsetWasExecutedBySource(input: {
  readonly binding: Extract<AnalysisLaunchCompletedCurrentInventoryBinding, {
    readonly schema: "analysis-launch-completed-current-inventory-v2";
  }>;
  readonly inventory: CurrentLaunchInventory;
  readonly sourceManifest: AnalysisLaunchManifest;
  readonly receipt: ReturnType<typeof normalizeAnalysisLaunchReceipt>;
}): void {
  const sourceOriginalSequences = input.sourceManifest.source.completedLaunch?.schema
      === "analysis-launch-completed-current-inventory-v2"
    ? input.sourceManifest.source.completedLaunch.selectedOriginalSequences
    : input.sourceManifest.targets.map((target) => target.sequence);
  for (const originalSequence of input.binding.selectedOriginalSequences) {
    const sourceIndex = sourceOriginalSequences.indexOf(originalSequence);
    const inventoryTarget = input.inventory.targets[originalSequence];
    const sourceTarget = sourceIndex < 0 ? undefined : input.sourceManifest.targets[sourceIndex];
    const receiptTarget = sourceIndex < 0 ? undefined : input.receipt.targets[sourceIndex];
    if (
      !inventoryTarget
      || !sourceTarget
      || !receiptTarget
      || sourceTarget.grantId !== inventoryTarget.grantId
      || sourceTarget.inputSha256 !== inventoryTarget.inputSha256
      || sourceTarget.attachmentManifestSha256 !== inventoryTarget.attachmentManifestSha256
      || receiptTarget.sequence !== sourceTarget.sequence
      || receiptTarget.grantId !== sourceTarget.grantId
      || receiptTarget.status === "skipped"
    ) {
      throw new Error("재봉인 선택 target은 원 completed manifest와 terminal receipt에서 exact 실행돼야 합니다.");
    }
  }
}

function normalizeCompletedCurrentInventorySubsetSource(value: unknown): AnalysisLaunchManifest {
  try {
    return normalizeCompletedAnalysisLaunchManifestForOfflineConsumption(value);
  } catch {
    return normalizeCompletedCurrentInventorySourceManifest(value);
  }
}

function completedLaunchProjectionTargets(
  inventory: CurrentLaunchInventory,
  completedLaunch: AnalysisLaunchCompletedCurrentInventoryBinding | undefined,
): CurrentLaunchInventory["targets"] {
  if (!completedLaunch || completedLaunch.schema === "analysis-launch-completed-current-inventory-v1") {
    return inventory.targets;
  }
  const selected = completedLaunch.selectedOriginalSequences.map((originalSequence, sequence) => {
    const target = inventory.targets[originalSequence];
    if (!target || target.sequence !== originalSequence) {
      throw new Error("completed current inventory 선택 sequence가 원 inventory 범위를 벗어났습니다.");
    }
    return Object.freeze({ ...target, sequence });
  });
  if (new Set(completedLaunch.selectedOriginalSequences).size !== selected.length) {
    throw new Error("completed current inventory 선택 sequence가 중복됐습니다.");
  }
  return Object.freeze(selected);
}

function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
