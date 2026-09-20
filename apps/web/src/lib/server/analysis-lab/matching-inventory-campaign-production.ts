import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getCunoteDb } from "../db/client";
import {
  readDeepAnalysisRuntimeAdmissionSnapshot,
  type DeepAnalysisRuntimeAdmissionSnapshot,
} from "../deep-analysis/runtimeControl";
import {
  prepareMatchingCampaignLaunch,
  prepareTerminalRepairLaunch,
  readCurrentEligibleMatchingTargets,
  type CurrentEligibleMatchingTarget,
} from "./current-inventory-launch-production";
import { verifyCurrentInventoryLaunchBinding } from "./current-inventory-launch";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { isImmutableArtifactTempFileName } from "./immutable-artifact-fs";
import {
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  normalizeCompletedAnalysisLaunchManifestForOfflineConsumption,
  encodeCanonical,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
  type AnalysisLaunchGrant,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import { inspectAnalysisLaunchIndependentReview } from "./analysis-launch-promotion";
import type { AnalysisLaunchIndependentReviewInspection } from "./analysis-launch-promotion";
import { readAnalysisLaunchStatus, type AnalysisLaunchStatus } from "./launch-status";
import {
  classifyMatchingInventorySnapshot,
  createMatchingCampaignRunNextPlan,
  createMatchingCampaignIndex,
  MATCHING_CAMPAIGN_MAX_CHILD_TARGETS,
  partitionMatchingCampaignGrantIds,
  readMatchingCampaignIndex,
  selectMatchingCampaignResume,
  storeMatchingCampaignIndex,
  storeMatchingInventoryClassification,
  type MatchingCampaignChildInput,
  type MatchingCampaignIndex,
  type MatchingCampaignReceiptArtifact,
  type MatchingInventoryClassification,
  type MatchingInventoryHistory,
} from "./matching-inventory-campaign";
import { findMonorepoRoot } from "./run-store";

const SHA_FILE = /^([a-f0-9]{64})\.json$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export interface MatchingCampaignHistoryRecord {
  readonly grantId: string;
  readonly history: MatchingInventoryHistory;
  readonly manifest: AnalysisLaunchManifest | null;
  readonly manifestSha256: string | null;
  readonly grantSha256: string | null;
}

export interface MatchingCampaignProductionDependencies {
  readonly root: string;
  readonly readCurrentTargets: (asOf: Date) => Promise<readonly CurrentEligibleMatchingTarget[]>;
  readonly readHistory: (
    current: readonly CurrentEligibleMatchingTarget[],
  ) => Promise<ReadonlyMap<string, MatchingCampaignHistoryRecord>>;
  readonly prepareCurrent: (
    grantIds: readonly string[],
    classification: MatchingInventoryClassification,
  ) => Promise<MatchingCampaignChildInput>;
  readonly prepareTerminal: (
    sourceManifestSha256: string,
    sourceGrantSha256: string,
  ) => Promise<MatchingCampaignChildInput>;
  readonly storeClassification: (
    value: MatchingInventoryClassification,
  ) => Promise<{ sha256: string; path: string }>;
  readonly storeIndex: (value: MatchingCampaignIndex) => Promise<{ sha256: string; path: string }>;
}

export function classifyCampaignTerminalHistoryOutcome(
  status: AnalysisLaunchReceipt["targets"][number]["status"],
  sourceHasHeld: boolean,
): "failed" | "quality_held" | null {
  if (status === "held") return "quality_held";
  if (status === "failed") return sourceHasHeld ? "quality_held" : "failed";
  return null;
}

export function matchingHistoryReviewDisposition(
  inspection: AnalysisLaunchIndependentReviewInspection | null,
): "passed" | "pending" | "held" {
  return inspection === "blocked" ? "held" : inspection ?? "pending";
}

export function activeLaunchGrantShaFromRuntime(
  runtime: DeepAnalysisRuntimeAdmissionSnapshot,
): string | null {
  if (runtime.activeDeepLeases !== 0 || runtime.activeApplicationLeases !== 0) {
    throw new Error("runtime에 campaign과 결속할 수 없는 active queue lease가 있습니다.");
  }
  const observedAt = Date.parse(runtime.databaseObservedAt);
  if (!Number.isFinite(observedAt)) throw new Error("runtime databaseObservedAt이 잘못됐습니다.");
  if (runtime.mode !== "local_subscription") {
    if (runtime.localOwnerId !== null || runtime.localLeaseExpiresAt !== null) {
      throw new Error("runtime 비-local mode에 local ownership이 남아 있습니다.");
    }
    return null;
  }
  if (!runtime.localOwnerId || !runtime.localLeaseExpiresAt) {
    throw new Error("runtime local ownership 결속이 불완전합니다.");
  }
  const expiresAt = Date.parse(runtime.localLeaseExpiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("runtime local lease 시각이 잘못됐습니다.");
  if (expiresAt <= observedAt) return null;
  const match = /^승인된 launch cohort lease: ([a-f0-9]{64})$/u.exec(runtime.changeReason ?? "");
  if (!match) throw new Error("active local runtime owner를 launch grant에 결속할 수 없습니다.");
  return match[1]!;
}

export function resolveActiveLaunchManifest(input: {
  readonly runtime: DeepAnalysisRuntimeAdmissionSnapshot;
  readonly status: AnalysisLaunchStatus | null;
  readonly grant: AnalysisLaunchGrant | null;
}): string | null {
  const grantSha256 = activeLaunchGrantShaFromRuntime(input.runtime);
  if (!grantSha256) return null;
  if (!input.status
    || !input.grant
    || input.status.lifecycle !== "running"
    || input.status.grantSha256 !== grantSha256
    || input.grant.manifestSha256 !== input.status.manifestSha256) {
    throw new Error("active runtime ownership과 running launch status가 결속되지 않았습니다.");
  }
  return input.status.manifestSha256;
}

export function applyActiveLaunchOwnership(input: {
  readonly result: Map<string, MatchingCampaignHistoryRecord>;
  readonly currentGrantIds: ReadonlySet<string>;
  readonly manifestSha256: string;
  readonly manifest: AnalysisLaunchManifest;
  readonly status: AnalysisLaunchStatus;
  readonly latestReceipt: { readonly sha256: string; readonly receipt: AnalysisLaunchReceipt } | null;
}): void {
  if (input.status.lifecycle !== "running"
    || input.status.manifestSha256 !== input.manifestSha256
    || !encodeCanonical(input.status.execution).equals(encodeCanonical(input.manifest.execution))
    || input.status.targets.length !== input.manifest.targets.length) {
    throw new Error("active launch status와 manifest 범위가 다릅니다.");
  }
  for (const [sequence, manifestTarget] of input.manifest.targets.entries()) {
    const statusTarget = input.status.targets[sequence];
    const receiptTarget = input.latestReceipt?.receipt.targets[sequence];
    if (!statusTarget
      || statusTarget.sequence !== manifestTarget.sequence
      || statusTarget.grantId !== manifestTarget.grantId
      || (receiptTarget && (
        receiptTarget.sequence !== manifestTarget.sequence
        || receiptTarget.grantId !== manifestTarget.grantId
      ))) {
      throw new Error("active launch target material 범위가 manifest와 다릅니다.");
    }
    if (!input.currentGrantIds.has(manifestTarget.grantId)) continue;
    const active = statusTarget.status === "running"
      || (statusTarget.status === "pending" && (
        !receiptTarget || receiptTarget.status === "failed" || receiptTarget.status === "skipped"
      ));
    if (!active) continue;
    input.result.set(manifestTarget.grantId, {
      grantId: manifestTarget.grantId,
      history: {
        kind: "prepared",
        inputSha256: manifestTarget.inputSha256,
        attachmentManifestSha256: manifestTarget.attachmentManifestSha256,
        contractCompatible: input.manifest.execution.analysisMode === "matching_only",
        manifestSha256: input.manifestSha256,
        ownership: "active_elsewhere",
      },
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      grantSha256: input.status.grantSha256,
    });
  }
}

export async function readActiveLaunchManifest(
  root: string,
  manifestSha256: string,
): Promise<AnalysisLaunchManifest> {
  return normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", manifestSha256, root),
  );
}

/**
 * history 스캔의 관심 대상만 먼저 고른다. 오래된 current-inventory manifest가 현행
 * live 계약으로 정규화되지 않더라도, 그 target은 inventory 이력으로 held 처리할 수 있다.
 */
export function readCurrentInventoryHistoryTargetIds(value: unknown): readonly string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("launch history manifest가 객체가 아닙니다.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "analysis-launch-manifest-v1") {
    throw new Error("launch history manifest schema가 다릅니다.");
  }
  if (!record.source || typeof record.source !== "object" || Array.isArray(record.source)) {
    throw new Error("launch history source가 객체가 아닙니다.");
  }
  const sourceKind = (record.source as Record<string, unknown>).kind;
  if (sourceKind !== undefined
    && sourceKind !== "formal_plan"
    && sourceKind !== "current_inventory"
    && sourceKind !== "authoring_guide_adoption"
    && sourceKind !== "independent_review_repair") {
    throw new Error("launch history source kind가 잘못됐습니다.");
  }
  if (sourceKind !== "current_inventory") return null;
  if (!Array.isArray(record.targets) || record.targets.length === 0) {
    throw new Error("current inventory launch history target이 없습니다.");
  }
  const ids = new Set<string>();
  for (const target of record.targets) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("current inventory launch history target이 객체가 아닙니다.");
    }
    const grantId = (target as Record<string, unknown>).grantId;
    if (typeof grantId !== "string" || !UUID.test(grantId) || ids.has(grantId)) {
      throw new Error("current inventory launch history grantId가 잘못됐습니다.");
    }
    ids.add(grantId);
  }
  return Object.freeze([...ids]);
}

/** DB/로컬 이력을 읽고 child manifest와 권한 없는 campaign index까지만 준비한다. */
export async function prepareMatchingInventoryCampaign(input: {
  readonly asOf: Date;
  readonly allowedStage: MatchingCampaignIndex["execution"]["allowedStage"];
  readonly childSize?: number;
  readonly dependencies?: MatchingCampaignProductionDependencies;
}) {
  const dependencies = input.dependencies ?? defaultDependencies();
  const childSize = input.childSize ?? MATCHING_CAMPAIGN_MAX_CHILD_TARGETS;
  partitionMatchingCampaignGrantIds([], childSize);
  const current = await dependencies.readCurrentTargets(input.asOf);
  if (current.length === 0) throw new Error("현행 지원 가능 matching campaign 모집단이 없습니다.");
  const history = await dependencies.readHistory(current);
  const classification = classifyMatchingInventorySnapshot({
    observedAt: input.asOf.toISOString(),
    targets: current.map((target) => ({
      ...target,
      eligibility: { eligible: true as const },
      history: history.get(target.grantId)?.history ?? { kind: "none" as const },
    })),
  });
  const storedClassification = await dependencies.storeClassification(classification);

  const children: MatchingCampaignChildInput[] = [];
  const existingManifestShas = new Set<string>();
  const reusedPreparedGrantIds = new Set<string>();
  for (const entry of classification.entries) {
    if (!entry.campaignEligible || entry.category !== "prepared_not_started") continue;
    const record = history.get(entry.grantId);
    if (!record?.manifest || !record.manifestSha256) {
      throw new Error(`prepared target manifest가 없습니다: ${entry.grantId}`);
    }
    const exactReusableManifest = record.manifest.targets.every((target) => {
      const classified = classification.entries.find((item) => item.grantId === target.grantId);
      const targetHistory = history.get(target.grantId);
      return record.manifest?.execution.analysisMode === "matching_only"
        && classified?.campaignEligible
        && classified.category === "prepared_not_started"
        && targetHistory?.manifestSha256 === record.manifestSha256;
    });
    if (exactReusableManifest
      && record.manifest.targets.length <= childSize
      && !existingManifestShas.has(record.manifestSha256)) {
      existingManifestShas.add(record.manifestSha256);
      children.push({ manifest: record.manifest, manifestSha256: record.manifestSha256 });
      for (const target of record.manifest.targets) reusedPreparedGrantIds.add(target.grantId);
    }
  }

  const currentPrepareIds = classification.entries
    .filter((entry) => entry.campaignEligible && (
      entry.category === "new"
      || entry.category === "source_changed"
      || (entry.category === "prepared_not_started" && !reusedPreparedGrantIds.has(entry.grantId))
    ))
    .map((entry) => entry.grantId);
  for (const grantIds of partitionMatchingCampaignGrantIds(currentPrepareIds, childSize)) {
    children.push(await dependencies.prepareCurrent(grantIds, classification));
  }

  const terminalSources = new Map<string, {
    manifestSha256: string;
    grantSha256: string;
    targetGrantIds: string[];
  }>();
  for (const entry of classification.entries) {
    if (!entry.campaignEligible || entry.category !== "terminal_recovery") continue;
    const record = history.get(entry.grantId);
    if (!record?.manifestSha256 || !record.grantSha256) {
      throw new Error(`terminal recovery source가 없습니다: ${entry.grantId}`);
    }
    const key = `${record.manifestSha256}:${record.grantSha256}`;
    const source = terminalSources.get(key) ?? {
      manifestSha256: record.manifestSha256,
      grantSha256: record.grantSha256,
      targetGrantIds: [],
    };
    source.targetGrantIds.push(entry.grantId);
    terminalSources.set(key, source);
  }
  for (const source of terminalSources.values()) {
    if (source.targetGrantIds.length > childSize) {
      throw new Error(
        `terminal recovery source가 child-size를 초과합니다: ${source.manifestSha256} (${source.targetGrantIds.length} > ${childSize})`,
      );
    }
    children.push(await dependencies.prepareTerminal(source.manifestSha256, source.grantSha256));
  }

  if (children.length === 0) {
    throw new Error("campaign 실행 대상이 없습니다. 재사용·검수·보류 분류만 존재합니다.");
  }
  const index = createMatchingCampaignIndex({
    classification,
    children,
    allowedStage: input.allowedStage,
    now: new Date(),
    childSize,
  });
  if (index.snapshot.classificationSha256 !== storedClassification.sha256) {
    throw new Error("campaign index classification 결속이 저장 artifact와 다릅니다.");
  }
  const stored = await dependencies.storeIndex(index);
  return Object.freeze({
    campaignSha256: stored.sha256,
    campaignPath: stored.path,
    classificationSha256: storedClassification.sha256,
    classificationPath: storedClassification.path,
    index,
    classification,
    liveExecutionAuthorized: false,
    modelCalls: 0,
    serviceWrites: 0,
  });
}

export async function readMatchingCampaignResumeStatus(input: {
  readonly campaignSha256: string;
  readonly root?: string;
}) {
  const root = input.root ?? findMonorepoRoot();
  const campaign = await readMatchingCampaignIndex(root, input.campaignSha256);
  const receipts = await readCampaignReceipts(root, campaign);
  const selection = selectMatchingCampaignResume({ campaign, receipts });
  const child = selection.status === "resume_child"
    ? campaign.children[selection.childSequence]
    : null;
  if (selection.status === "resume_child" && child?.manifestSha256 !== selection.childManifestSha256) {
    throw new Error("campaign status next child 결속이 다릅니다.");
  }
  const grantSha256s = child
    ? await readGrantSha256s(root, child.manifestSha256, child.targetCount)
    : [];
  return Object.freeze({ campaign, selection, grantSha256s });
}

export async function readMatchingCampaignRunNextPlan(input: {
  readonly campaignSha256: string;
  readonly expectedChildManifestSha256: string;
  readonly approvedBy: string;
  readonly root?: string;
}) {
  const root = input.root ?? findMonorepoRoot();
  const status = await readMatchingCampaignResumeStatus({
    campaignSha256: input.campaignSha256,
    root,
  });
  const runtime = await readDeepAnalysisRuntimeAdmissionSnapshot(getCunoteDb());
  return createMatchingCampaignRunNextPlan({
    campaignSha256: input.campaignSha256,
    expectedChildManifestSha256: input.expectedChildManifestSha256,
    approvedBy: input.approvedBy,
    campaign: status.campaign,
    selection: status.selection,
    existingGrantSha256s: status.grantSha256s,
    runtime,
  });
}

function defaultDependencies(): MatchingCampaignProductionDependencies {
  const root = findMonorepoRoot();
  return {
    root,
    readCurrentTargets: readCurrentEligibleMatchingTargets,
    readHistory: (current) => readVerifiedCurrentLaunchHistory(root, current),
    prepareCurrent: async (grantIds, classification) => {
      const prepared = await prepareMatchingCampaignLaunch({
        grantIds,
        concurrency: 2,
        classification,
        classificationSha256: createHash("sha256").update(encodeCanonical(classification)).digest("hex"),
      });
      return { manifest: prepared.manifest, manifestSha256: prepared.manifestSha256 };
    },
    prepareTerminal: async (sourceManifestSha256, sourceGrantSha256) => {
      const prepared = await prepareTerminalRepairLaunch({
        sourceManifestSha256,
        sourceGrantSha256,
        concurrency: 2,
        analysisMode: "matching_only",
      });
      return { manifest: prepared.manifest, manifestSha256: prepared.manifestSha256 };
    },
    storeClassification: (value) => storeMatchingInventoryClassification(root, value),
    storeIndex: (value) => storeMatchingCampaignIndex(root, value),
  };
}

/** 현행 current-inventory artifact만 자동 판정하고 나머지 과거 이력은 fail-safe held로 둔다. */
export async function readVerifiedCurrentLaunchHistory(
  root: string,
  current: readonly CurrentEligibleMatchingTarget[],
): Promise<ReadonlyMap<string, MatchingCampaignHistoryRecord>> {
  const runtime = await readDeepAnalysisRuntimeAdmissionSnapshot(getCunoteDb());
  const activeGrantSha256 = activeLaunchGrantShaFromRuntime(runtime);
  const activeStatus = activeGrantSha256
    ? await readAnalysisLaunchStatus(activeGrantSha256, root)
    : null;
  const activeGrant = activeGrantSha256
    ? normalizeAnalysisLaunchGrant(await readAnalysisLaunchArtifact("grants", activeGrantSha256, root))
    : null;
  const activeManifestSha256 = resolveActiveLaunchManifest({ runtime, status: activeStatus, grant: activeGrant });
  const activeManifest = activeManifestSha256
    ? await readActiveLaunchManifest(root, activeManifestSha256)
    : null;
  const currentIds = new Set(current.map((target) => target.grantId));
  const historical = new Set(await readDeepRepairHistoricalGrantIds({
    rootDir: join(root, "spike-out", "analysis-lab"),
    scope: "all",
  }));
  const manifestations: { sha256: string; manifest: AnalysisLaunchManifest }[] = [];
  for (const sha256 of await artifactShas(root, "manifests")) {
    const raw = await readAnalysisLaunchArtifact("manifests", sha256, root);
    const historyTargetIds = readCurrentInventoryHistoryTargetIds(raw);
    if (!historyTargetIds?.some((grantId) => currentIds.has(grantId))) continue;
    let manifest: AnalysisLaunchManifest;
    try {
      manifest = normalizeCompletedAnalysisLaunchManifestForOfflineConsumption(raw);
    } catch (error) {
      const relevantTargetIds = historyTargetIds.filter((grantId) => currentIds.has(grantId));
      if (relevantTargetIds.every((grantId) => historical.has(grantId))) continue;
      throw error;
    }
    if (manifest.execution.analysisMode === "application_only") continue;
    await verifyCurrentInventoryLaunchBinding(root, manifest);
    manifestations.push({ sha256, manifest });
  }
  manifestations.sort((left, right) => (
    left.manifest.preparedAt.localeCompare(right.manifest.preparedAt)
    || left.sha256.localeCompare(right.sha256)
  ));

  const receiptsByManifest = new Map<string, { sha256: string; receipt: AnalysisLaunchReceipt }[]>();
  for (const sha256 of await artifactShas(root, "receipts")) {
    const receipt = normalizeAnalysisLaunchReceipt(await readAnalysisLaunchArtifact("receipts", sha256, root));
    const receipts = receiptsByManifest.get(receipt.manifestSha256) ?? [];
    receipts.push({ sha256, receipt });
    receiptsByManifest.set(receipt.manifestSha256, receipts);
  }
  for (const receipts of receiptsByManifest.values()) {
    receipts.sort((left, right) => left.receipt.finishedAt.localeCompare(right.receipt.finishedAt));
  }

  const result = new Map<string, MatchingCampaignHistoryRecord>();
  for (const { sha256: manifestSha256, manifest } of manifestations) {
    const receipts = receiptsByManifest.get(manifestSha256) ?? [];
    const latest = receipts.at(-1);
    // 현행 terminal-repair reader는 같은 source의 held와 failed를 함께 고른다.
    // semantic held를 동일 입력으로 재실행하지 않도록 혼합 source의 failed도 자동 복구하지 않는다.
    const hasHeld = latest?.receipt.targets.some((target) => target.status === "held") ?? false;
    for (const manifestTarget of manifest.targets) {
      if (!currentIds.has(manifestTarget.grantId)) continue;
      let history: MatchingInventoryHistory;
      let grantSha256: string | null = null;
      if (!latest) {
        history = {
          kind: "prepared",
          inputSha256: manifestTarget.inputSha256,
          attachmentManifestSha256: manifestTarget.attachmentManifestSha256,
          contractCompatible: manifest.execution.analysisMode === "matching_only",
          manifestSha256,
          // grant artifact나 stale status 단독은 ownership이 아니다. 현재 DB lease와
          // 같은 grant의 running status가 이 manifest에 결속될 때만 active다.
          ownership: "unowned",
        };
      } else {
        grantSha256 = latest.receipt.grantSha256;
        const target = latest.receipt.targets.find((item) => item.grantId === manifestTarget.grantId);
        if (!target) throw new Error(`current launch receipt target이 없습니다: ${manifestTarget.grantId}`);
        if (target.status === "publishable") {
          const reviewRoot = join(root, "spike-out", "analysis-lab", "independent-review", latest.sha256);
          const reviewComplete = await hasIndependentReviewAggregate(reviewRoot);
          const review = reviewComplete
            ? await inspectAnalysisLaunchIndependentReview({
                launchReceiptSha256: latest.sha256,
                grantId: target.grantId,
                repositoryRoot: root,
              })
            : null;
          if (!target.runArtifactSha256) throw new Error(`publishable run SHA가 없습니다: ${target.grantId}`);
          history = {
            kind: "primary",
            inputSha256: manifestTarget.inputSha256,
            attachmentManifestSha256: manifestTarget.attachmentManifestSha256,
            contractCompatible: true,
            review: matchingHistoryReviewDisposition(review),
            sourceRunArtifactSha256: target.runArtifactSha256,
          };
        } else if (classifyCampaignTerminalHistoryOutcome(target.status, hasHeld) === "failed"
          && latest.receipt.stopReason === "completed") {
          history = {
            kind: "terminal",
            inputSha256: manifestTarget.inputSha256,
            attachmentManifestSha256: manifestTarget.attachmentManifestSha256,
            contractCompatible: true,
            outcome: "failed",
            sourceManifestSha256: manifestSha256,
            sourceReceiptSha256: latest.sha256,
          };
        } else if (target.status === "skipped" && latest.receipt.targets.every((item) => item.status === "skipped")) {
          history = {
            kind: "prepared",
            inputSha256: manifestTarget.inputSha256,
            attachmentManifestSha256: manifestTarget.attachmentManifestSha256,
            contractCompatible: true,
            manifestSha256,
            ownership: "unowned",
          };
        } else {
          history = {
            kind: "terminal",
            inputSha256: manifestTarget.inputSha256,
            attachmentManifestSha256: manifestTarget.attachmentManifestSha256,
            contractCompatible: true,
            outcome: "quality_held",
            sourceManifestSha256: manifestSha256,
            sourceReceiptSha256: latest.sha256,
          };
        }
      }
      result.set(manifestTarget.grantId, {
        grantId: manifestTarget.grantId,
        history,
        manifest,
        manifestSha256,
        grantSha256,
      });
    }
  }

  if (activeManifestSha256 && activeStatus && activeManifest) {
    const receipts = receiptsByManifest.get(activeManifestSha256) ?? [];
    applyActiveLaunchOwnership({
      result,
      currentGrantIds: currentIds,
      manifestSha256: activeManifestSha256,
      manifest: activeManifest,
      status: activeStatus,
      latestReceipt: receipts.at(-1) ?? null,
    });
  }

  for (const target of current) {
    if (!result.has(target.grantId) && historical.has(target.grantId)) {
      result.set(target.grantId, {
        grantId: target.grantId,
        history: { kind: "legacy", evidence: "deep_repair_history" },
        manifest: null,
        manifestSha256: null,
        grantSha256: null,
      });
    }
  }
  return result;
}

async function readCampaignReceipts(
  root: string,
  campaign: MatchingCampaignIndex,
): Promise<MatchingCampaignReceiptArtifact[]> {
  const manifestShas = new Set(campaign.children.map((child) => child.manifestSha256));
  const receipts: MatchingCampaignReceiptArtifact[] = [];
  for (const sha256 of await artifactShas(root, "receipts")) {
    const receipt = normalizeAnalysisLaunchReceipt(await readAnalysisLaunchArtifact("receipts", sha256, root));
    if (manifestShas.has(receipt.manifestSha256)) receipts.push({ sha256, receipt });
  }
  return receipts;
}

async function readGrantSha256s(
  root: string,
  manifestSha256: string,
  targetCount: number,
): Promise<readonly string[]> {
  const grants: string[] = [];
  for (const sha256 of await artifactShas(root, "grants")) {
    const grant = normalizeAnalysisLaunchGrant(await readAnalysisLaunchArtifact("grants", sha256, root));
    if (grant.manifestSha256 !== manifestSha256) continue;
    if (grant.targetCount !== targetCount) {
      throw new Error("campaign child grant targetCount가 manifest와 다릅니다.");
    }
    grants.push(sha256);
  }
  return Object.freeze(grants.sort());
}

async function artifactShas(root: string, kind: "manifests" | "grants" | "receipts"): Promise<string[]> {
  const entries = await readdir(join(root, "spike-out", "analysis-lab", "launch", kind), { withFileTypes: true })
    .catch((error: unknown) => isNotFound(error) ? [] : Promise.reject(error));
  const shas: string[] = [];
  for (const entry of entries) {
    if (isImmutableArtifactTempFileName(entry.name)) continue;
    const match = entry.isFile() ? SHA_FILE.exec(entry.name) : null;
    if (!match) throw new Error(`unexpected launch ${kind} entry: ${entry.name}`);
    shas.push(match[1]!);
  }
  return shas.sort();
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function hasIndependentReviewAggregate(reviewRoot: string): Promise<boolean> {
  if (!await exists(reviewRoot)) return false;
  const runRoot = join(reviewRoot, "review-runs");
  const runs = await readdir(runRoot, { withFileTypes: true })
    .catch((error: unknown) => isNotFound(error) ? [] : Promise.reject(error));
  for (const run of runs) {
    if (!run.isDirectory() || !/^[a-f0-9]{64}$/u.test(run.name)) {
      throw new Error(`unexpected independent review run entry: ${run.name}`);
    }
    const files = await readdir(join(runRoot, run.name), { withFileTypes: true });
    if (files.some((file) => file.isFile() && /^[a-f0-9]{64}\.aggregate\.json$/u.test(file.name))) {
      return true;
    }
  }
  return false;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
