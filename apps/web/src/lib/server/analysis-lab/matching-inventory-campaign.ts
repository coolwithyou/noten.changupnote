import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  encodeCanonical,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import type { GrantNextWorkAction } from "../productReadiness/grantNextWork";
import type { GrantSupplyAssessment, GrantSupplyStage } from "../productReadiness/grantSupply";

export const MATCHING_INVENTORY_CLASSIFICATION_SCHEMA =
  "analysis-matching-inventory-classification-v2" as const;
const LEGACY_MATCHING_INVENTORY_CLASSIFICATION_SCHEMA = "analysis-matching-inventory-classification-v1" as const;
const LEGACY_MATCHING_CAMPAIGN_INDEX_SCHEMA = "analysis-matching-campaign-index-v1" as const;
export const MATCHING_CAMPAIGN_INDEX_SCHEMA = "analysis-matching-campaign-index-v2" as const;
export const MATCHING_CAMPAIGN_MAX_CHILD_TARGETS = 100;

const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export type MatchingInventoryCategory =
  | "reusable"
  | "primary_review_required"
  | "prepared_not_started"
  | "new"
  | "terminal_recovery"
  | "source_changed"
  | "quality_held"
  | "excluded";

export type MatchingInventoryExclusionReason =
  | "source_unavailable"
  | "closed"
  | "hidden"
  | "duplicate";

interface MatchingInventoryMaterialBinding {
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly contractCompatible: boolean;
}

export type MatchingInventoryHistory =
  | { readonly kind: "none" }
  | { readonly kind: "legacy"; readonly evidence: "deep_repair_history" }
  | (MatchingInventoryMaterialBinding & {
      readonly kind: "prepared";
      readonly manifestSha256: string;
      readonly ownership: "unowned" | "active_elsewhere";
    })
  | (MatchingInventoryMaterialBinding & {
      readonly kind: "primary";
      readonly review: "passed" | "pending" | "held";
      readonly sourceRunArtifactSha256: string;
    })
  | (MatchingInventoryMaterialBinding & {
      readonly kind: "terminal";
      readonly outcome: "failed" | "quality_held";
      readonly sourceManifestSha256: string;
      readonly sourceReceiptSha256: string;
    });

export interface MatchingInventorySnapshotTarget {
  readonly grantId: string;
  readonly inputSha256: string | null;
  readonly attachmentManifestSha256: string | null;
  readonly closesToday: boolean;
  readonly preparationFailure?: "grant_missing" | "input_integrity";
  readonly supplyAssessment?: GrantSupplyAssessment;
  readonly eligibility:
    | { readonly eligible: true }
    | {
        readonly eligible: false;
        readonly reason: MatchingInventoryExclusionReason;
        readonly duplicateOfGrantId?: string;
      };
  /** 부재는 역사 artifact/test 호환. 신규 production snapshot은 모든 대상에 반드시 결속한다. */
  readonly readinessNextWork?: GrantNextWorkAction;
  readonly history: MatchingInventoryHistory;
}

export interface MatchingInventoryClassificationEntry {
  readonly grantId: string;
  readonly category: MatchingInventoryCategory;
  readonly closesToday: boolean;
  readonly campaignEligible: boolean;
  readonly reason: string;
  readonly supplyStage?: GrantSupplyStage | "inactive" | null;
  readonly supplyEvidenceSha256?: string | null;
  readonly nextAction:
    | "reuse"
    | "independent_review"
    | "reuse_prepared_manifest"
    | "wait_for_active_owner"
    | "prepare_matching_only"
    | "prepare_terminal_recovery"
    | "prepare_changed_source"
    | "review_current_conditions"
    | "prepare_confirmation_questions"
    | "recover_source"
    | "review_source_change"
    | "refresh_source_evidence"
    | "refresh_recruitment_status"
    | "review_source_coverage"
    | "resolve_quality_hold"
    | "review_existing_analysis"
    | "review_question_draft"
    | "prepare_promotion_release"
    | "await_approved_release"
    | "inspect_asset_inventory"
    | "resolve_asset_selection_conflict"
    | "none";
  readonly sourceManifestSha256: string | null;
  readonly sourceReceiptSha256: string | null;
  readonly current: {
    readonly inputSha256: string | null;
    readonly attachmentManifestSha256: string | null;
  };
  readonly history: {
    readonly kind: MatchingInventoryHistory["kind"];
    readonly inputSha256: string | null;
    readonly attachmentManifestSha256: string | null;
    readonly contractCompatible: boolean | null;
  };
}

export interface MatchingInventoryClassification {
  readonly schema: typeof MATCHING_INVENTORY_CLASSIFICATION_SCHEMA | typeof LEGACY_MATCHING_INVENTORY_CLASSIFICATION_SCHEMA;
  readonly observedAt: string;
  readonly targetCount: number;
  readonly targetGrantIds: readonly string[];
  readonly counts: Readonly<Record<MatchingInventoryCategory, number>>;
  readonly entries: readonly MatchingInventoryClassificationEntry[];
}

export function classifyMatchingInventorySnapshot(input: {
  readonly observedAt: string;
  readonly targets: readonly MatchingInventorySnapshotTarget[];
}): MatchingInventoryClassification {
  exactInstant(input.observedAt, "observedAt");
  if (input.targets.length === 0) throw new Error("matching inventory snapshot 대상이 없습니다.");
  const ids = new Set<string>();
  const entries = input.targets.map((target) => {
    const grantId = exactUuid(target.grantId, "grantId");
    if (ids.has(grantId)) throw new Error("matching inventory snapshot grantId가 중복됐습니다.");
    ids.add(grantId);
    if ((target.inputSha256 === null) !== (target.attachmentManifestSha256 === null)) {
      throw new Error("matching inventory 입력/첨부 SHA 결속이 불완전합니다.");
    }
    if (target.inputSha256 !== null) exactSha(target.inputSha256, "inputSha256");
    if (target.attachmentManifestSha256 !== null) exactSha(target.attachmentManifestSha256, "attachmentManifestSha256");
    return classifyTarget(target);
  });
  const counts = emptyCategoryCounts();
  for (const entry of entries) counts[entry.category] += 1;
  const counted = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (counted !== input.targets.length) throw new Error("matching inventory 분류 수량이 보존되지 않았습니다.");
  return Object.freeze({
    schema: MATCHING_INVENTORY_CLASSIFICATION_SCHEMA,
    observedAt: input.observedAt,
    targetCount: entries.length,
    targetGrantIds: Object.freeze(entries.map((entry) => entry.grantId)),
    counts: Object.freeze(counts),
    entries: Object.freeze(entries),
  });
}

function classifyTarget(target: MatchingInventorySnapshotTarget): MatchingInventoryClassificationEntry {
  const supply = target.supplyAssessment;
  if (supply && supply.grantId !== target.grantId) {
    throw new Error("matching supply evidence grantId가 대상과 다릅니다.");
  }
  if (supply?.schema === "grant-supply-inactive-v1") {
    return entry(target, "excluded", false, `supply:${supply.reason}`, "none");
  }
  if (!target.eligibility.eligible) {
    if (target.eligibility.reason === "duplicate") {
      exactUuid(target.eligibility.duplicateOfGrantId ?? "", "duplicateOfGrantId");
      if (target.eligibility.duplicateOfGrantId === target.grantId) {
        throw new Error("중복 대표 grantId는 자기 자신일 수 없습니다.");
      }
    } else if (target.eligibility.duplicateOfGrantId !== undefined) {
      throw new Error("duplicateOfGrantId는 duplicate 제외에만 허용됩니다.");
    }
    return entry(target, "excluded", false, `excluded:${target.eligibility.reason}`, "none");
  }
  validateHistory(target.history);
  if (target.preparationFailure) {
    if (target.inputSha256 !== null || target.attachmentManifestSha256 !== null) {
      throw new Error("준비 실패 target에 material SHA가 있을 수 없습니다.");
    }
    return entry(target, "quality_held", false, `preparation:${target.preparationFailure}`, "recover_source");
  }
  if (target.history.kind === "prepared" && target.history.ownership === "active_elsewhere") {
    return entry(target, "prepared_not_started", false, "active_owner_preserved", "wait_for_active_owner", target.history.manifestSha256);
  }
  if (supply?.schema === "grant-supply-plan-v1") {
    if (supply.modelCalls !== 0 || !SHA.test(supply.evidenceSha256)) {
      throw new Error("matching supply evidence 결속이 잘못됐습니다.");
    }
    const reason = `supply:${supply.stage}:${supply.reason}`;
    switch (supply.stage) {
      case "ready": return entry(target, "reusable", false, reason, "reuse");
      case "source_review":
        return supply.nextWorkAction === "condition_review"
          ? entry(target, "primary_review_required", false, reason, "review_current_conditions")
          : supply.nextWorkAction === "source_recovery"
            ? entry(target, "quality_held", false, reason, "recover_source")
            : supply.nextWorkAction === "coverage_review"
              ? entry(target, "source_changed", false, reason, "review_source_coverage")
              : entry(target, "source_changed", false, reason, "review_source_change");
      case "review_existing_analysis": return entry(target, "primary_review_required", false, reason, "review_existing_analysis");
      case "prepare_question_draft": return entry(target, "primary_review_required", false, reason, "prepare_confirmation_questions");
      case "review_question_draft": return entry(target, "primary_review_required", false, reason, "review_question_draft");
      case "prepare_promotion_release": return entry(target, "reusable", false, reason, "prepare_promotion_release");
      case "await_approved_release": return entry(target, "reusable", false, reason, "await_approved_release");
      case "recheck_recruitment": return entry(target, "source_changed", false, reason, "refresh_recruitment_status");
      case "asset_inventory_unavailable": return entry(target, "quality_held", false, reason, "inspect_asset_inventory");
      case "asset_selection_conflict": return entry(target, "quality_held", false, reason, "resolve_asset_selection_conflict");
      case "await_approved_model_run":
        if (supply.nextWorkAction !== "condition_analysis") {
          throw new Error("matching 공급 모델 실행 단계의 nextWork가 다릅니다.");
        }
        break;
    }
  }
  if (target.readinessNextWork && target.readinessNextWork !== "condition_analysis") {
    switch (target.readinessNextWork) {
      case "reuse_ready":
        return entry(target, "reusable", false, "readiness:reuse_ready", "reuse");
      case "condition_review":
        return entry(
          target,
          "primary_review_required",
          false,
          "readiness:condition_review",
          "review_current_conditions",
        );
      case "question_preparation":
        return entry(
          target,
          "primary_review_required",
          false,
          "readiness:question_preparation",
          "prepare_confirmation_questions",
        );
      case "source_recovery":
        return entry(target, "quality_held", false, "readiness:source_recovery", "recover_source");
      case "source_change_review":
        return entry(target, "source_changed", false, "readiness:source_change_review", "review_source_change");
      case "source_rebind":
        return entry(target, "source_changed", false, "readiness:source_rebind", "refresh_source_evidence");
      case "recruitment_refresh":
        return entry(target, "source_changed", false, "readiness:recruitment_refresh", "refresh_recruitment_status");
      case "coverage_review":
        return entry(target, "source_changed", false, "readiness:coverage_review", "review_source_coverage");
    }
  }
  if (target.history.kind === "legacy") {
    return entry(target, "quality_held", false, "legacy_history_requires_manual_review", "resolve_quality_hold");
  }
  if (target.inputSha256 === null || target.attachmentManifestSha256 === null) {
    throw new Error(`matching 실행 판정에 current material이 없습니다: ${target.grantId}`);
  }
  if (target.history.kind !== "none") {
    const changed: string[] = [];
    if (target.history.inputSha256 !== target.inputSha256) changed.push("input");
    if (target.history.attachmentManifestSha256 !== target.attachmentManifestSha256) changed.push("attachment");
    if (!target.history.contractCompatible) changed.push("contract");
    if (changed.length > 0) {
      return entry(target, "source_changed", true, `changed:${changed.join("+")}`, "prepare_changed_source");
    }
  }
  switch (target.history.kind) {
    case "none":
      return entry(target, "new", true, "no_execution_history", "prepare_matching_only");
    case "prepared":
      return entry(target, "prepared_not_started", true, "prepared_manifest_unstarted", "reuse_prepared_manifest", target.history.manifestSha256);
    case "primary":
      if (target.history.review === "passed") {
        return entry(target, "reusable", false, "current_primary_review_passed", "reuse");
      }
      if (target.history.review === "pending") {
        return entry(target, "primary_review_required", false, "current_primary_review_pending", "independent_review");
      }
      return entry(target, "quality_held", false, "independent_review_held", "resolve_quality_hold");
    case "terminal":
      return target.history.outcome === "failed"
        ? entry(target, "terminal_recovery", true, "terminal_execution_failed", "prepare_terminal_recovery", target.history.sourceManifestSha256, target.history.sourceReceiptSha256)
        : entry(target, "quality_held", false, "terminal_quality_held", "resolve_quality_hold", target.history.sourceManifestSha256, target.history.sourceReceiptSha256);
  }
}

function entry(
  target: MatchingInventorySnapshotTarget,
  category: MatchingInventoryCategory,
  campaignEligible: boolean,
  reason: string,
  nextAction: MatchingInventoryClassificationEntry["nextAction"],
  sourceManifestSha256: string | null = null,
  sourceReceiptSha256: string | null = null,
): MatchingInventoryClassificationEntry {
  return Object.freeze({
    grantId: target.grantId,
    category,
    closesToday: target.closesToday,
    campaignEligible,
    reason,
    supplyStage: target.supplyAssessment?.schema === "grant-supply-plan-v1"
      ? target.supplyAssessment.stage
      : target.supplyAssessment ? "inactive" : null,
    supplyEvidenceSha256: target.supplyAssessment?.schema === "grant-supply-plan-v1"
      ? target.supplyAssessment.evidenceSha256 : null,
    nextAction,
    sourceManifestSha256,
    sourceReceiptSha256,
    current: Object.freeze({
      inputSha256: target.inputSha256,
      attachmentManifestSha256: target.attachmentManifestSha256,
    }),
    history: Object.freeze(target.history.kind === "none" || target.history.kind === "legacy" ? {
      kind: target.history.kind,
      inputSha256: null,
      attachmentManifestSha256: null,
      contractCompatible: null,
    } : {
      kind: target.history.kind,
      inputSha256: target.history.inputSha256,
      attachmentManifestSha256: target.history.attachmentManifestSha256,
      contractCompatible: target.history.contractCompatible,
    }),
  });
}

function validateHistory(history: MatchingInventoryHistory): void {
  if (history.kind === "none" || history.kind === "legacy") return;
  exactSha(history.inputSha256, "history.inputSha256");
  exactSha(history.attachmentManifestSha256, "history.attachmentManifestSha256");
  if (history.kind === "prepared") exactSha(history.manifestSha256, "history.manifestSha256");
  if (history.kind === "primary") exactSha(history.sourceRunArtifactSha256, "history.sourceRunArtifactSha256");
  if (history.kind === "terminal") {
    exactSha(history.sourceManifestSha256, "history.sourceManifestSha256");
    exactSha(history.sourceReceiptSha256, "history.sourceReceiptSha256");
  }
}

function emptyCategoryCounts(): Record<MatchingInventoryCategory, number> {
  return {
    reusable: 0,
    primary_review_required: 0,
    prepared_not_started: 0,
    new: 0,
    terminal_recovery: 0,
    source_changed: 0,
    quality_held: 0,
    excluded: 0,
  };
}

export function partitionMatchingCampaignGrantIds(
  grantIds: readonly string[],
  maxTargets = MATCHING_CAMPAIGN_MAX_CHILD_TARGETS,
): readonly (readonly string[])[] {
  if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > MATCHING_CAMPAIGN_MAX_CHILD_TARGETS) {
    throw new Error("campaign child target 상한은 1~100이어야 합니다.");
  }
  const ids = new Set<string>();
  for (const grantId of grantIds) {
    exactUuid(grantId, "grantId");
    if (ids.has(grantId)) throw new Error("campaign grantId가 중복됐습니다.");
    ids.add(grantId);
  }
  const partitions: string[][] = [];
  for (let offset = 0; offset < grantIds.length; offset += maxTargets) {
    partitions.push([...grantIds.slice(offset, offset + maxTargets)]);
  }
  return Object.freeze(partitions.map((partition) => Object.freeze(partition)));
}

export interface MatchingCampaignChildInput {
  readonly manifestSha256: string;
  readonly manifest: AnalysisLaunchManifest;
}

export interface MatchingCampaignIndex {
  readonly schema: typeof MATCHING_CAMPAIGN_INDEX_SCHEMA;
  readonly preparedAt: string;
  readonly snapshot: {
    readonly observedAt: string;
    readonly classificationSha256: string;
    readonly targetCount: number;
    readonly targetGrantIds: readonly string[];
    readonly counts: Readonly<Record<MatchingInventoryCategory, number>>;
  };
  readonly execution: {
    readonly strategy: "sequential_child_manifests";
    readonly concurrency: 2;
    readonly childSize: number;
    readonly liveAuthority: "none";
    readonly requiredAuthority: "analysis-launch-grant-v1-per-child";
    readonly allowedStage: "prepare" | "grant" | "launch";
  };
  readonly children: readonly {
    readonly sequence: number;
    readonly manifestSha256: string;
    readonly inventorySha256: string;
    readonly targetCount: number;
    readonly targetGrantIds: readonly string[];
    readonly classifications: readonly MatchingInventoryCategory[];
    readonly ancestry: {
      readonly completedManifestSha256: string | null;
      readonly terminalRepairManifestSha256: string | null;
    };
    readonly material: {
      readonly model: string;
      readonly promptVersion: string;
      readonly validatorVersion: string;
      readonly packageRuntimeSha256: string;
      readonly analysisMode: "matching_only";
    };
  }[];
  readonly userScope: {
    readonly childManifestSha256s: readonly string[];
    readonly allowedStage: "prepare" | "grant" | "launch";
    readonly grantsStillRequired: true;
  };
}

export function createMatchingCampaignIndex(input: {
  readonly classification: MatchingInventoryClassification;
  readonly children: readonly MatchingCampaignChildInput[];
  readonly allowedStage: MatchingCampaignIndex["execution"]["allowedStage"];
  readonly now: Date;
  readonly childSize?: number;
}): MatchingCampaignIndex {
  const classification = normalizeClassification(input.classification);
  const childSize = validateMatchingCampaignChildSize(
    input.childSize ?? MATCHING_CAMPAIGN_MAX_CHILD_TARGETS,
  );
  exactInstant(input.now.toISOString(), "preparedAt");
  if (input.children.length === 0) throw new Error("matching campaign child manifest가 없습니다.");
  const classificationById = new Map(classification.entries.map((item) => [item.grantId, item]));
  const seen = new Set<string>();
  const children = input.children.map((child, sequence) => {
    exactSha(child.manifestSha256, "manifestSha256");
    const manifest = normalizeAnalysisLaunchManifest(child.manifest);
    if (sha(encodeCanonical(manifest)) !== child.manifestSha256) throw new Error("campaign child manifest SHA가 다릅니다.");
    if (manifest.source.kind !== "current_inventory"
      || manifest.execution.analysisMode !== "matching_only"
      || manifest.execution.concurrency !== 2
      || manifest.targets.length < 1
      || manifest.targets.length > childSize) {
      throw new Error("campaign child는 선택한 child-size 이하인 동시성 2의 matching_only current inventory여야 합니다.");
    }
    const classifications = new Set<MatchingInventoryCategory>();
    for (const target of manifest.targets) {
      const classified = classificationById.get(target.grantId);
      if (!classified?.campaignEligible) throw new Error("campaign child에 실행 불가 target이 있습니다.");
      if (target.inputSha256 !== classified.current.inputSha256
        || target.attachmentManifestSha256 !== classified.current.attachmentManifestSha256) {
        throw new Error("campaign child target material이 classification과 다릅니다.");
      }
      if (classified.category === "terminal_recovery") {
        const repair = manifest.source.terminalRepair;
        if (!repair
          || repair.sourceManifestSha256 !== classified.sourceManifestSha256
          || !classified.sourceReceiptSha256
          || !repair.receiptSha256s.includes(classified.sourceReceiptSha256)) {
          throw new Error("terminal recovery child ancestry가 classification과 다릅니다.");
        }
      } else if (manifest.source.terminalRepair) {
        throw new Error("terminal repair child에는 terminal_recovery target만 허용됩니다.");
      }
      if (seen.has(target.grantId)) throw new Error("campaign child target이 중복됐습니다.");
      seen.add(target.grantId);
      classifications.add(classified.category);
    }
    return Object.freeze({
      sequence,
      manifestSha256: child.manifestSha256,
      inventorySha256: manifest.source.planArtifactSha256,
      targetCount: manifest.targets.length,
      targetGrantIds: Object.freeze(manifest.targets.map((target) => target.grantId)),
      classifications: Object.freeze([...classifications].sort()),
      ancestry: Object.freeze({
        completedManifestSha256: manifest.source.completedLaunch?.sourceManifestSha256 ?? null,
        terminalRepairManifestSha256: manifest.source.terminalRepair?.sourceManifestSha256 ?? null,
      }),
      material: Object.freeze({
        model: manifest.execution.model,
        promptVersion: manifest.execution.promptVersion,
        validatorVersion: manifest.execution.validatorVersion,
        packageRuntimeSha256: manifest.execution.packageRuntimeSha256,
        analysisMode: "matching_only" as const,
      }),
    });
  });
  const expected = classification.entries.filter((entry) => entry.campaignEligible).map((entry) => entry.grantId).sort();
  if (encodeCanonical([...seen].sort()).compare(encodeCanonical(expected)) !== 0) {
    throw new Error("campaign child 범위가 분류된 실행 대상 전체와 다릅니다.");
  }
  const childManifestSha256s = Object.freeze(children.map((child) => child.manifestSha256));
  return Object.freeze({
    schema: MATCHING_CAMPAIGN_INDEX_SCHEMA,
    preparedAt: input.now.toISOString(),
    snapshot: Object.freeze({
      observedAt: classification.observedAt,
      classificationSha256: sha(encodeCanonical(classification)),
      targetCount: classification.targetCount,
      targetGrantIds: classification.targetGrantIds,
      counts: classification.counts,
    }),
    execution: Object.freeze({
      strategy: "sequential_child_manifests",
      concurrency: 2,
      childSize,
      liveAuthority: "none",
      requiredAuthority: "analysis-launch-grant-v1-per-child",
      allowedStage: input.allowedStage,
    }),
    children: Object.freeze(children),
    userScope: Object.freeze({
      childManifestSha256s,
      allowedStage: input.allowedStage,
      grantsStillRequired: true,
    }),
  });
}

export function matchingCampaignIndexPath(root: string, digest: string): string {
  return join(root, "spike-out", "analysis-lab", "launch", "campaigns", `${exactSha(digest, "campaign SHA")}.json`);
}

export function matchingInventoryClassificationPath(root: string, digest: string): string {
  return join(root, "spike-out", "analysis-lab", "launch", "campaign-classifications", `${exactSha(digest, "classification SHA")}.json`);
}

export async function storeMatchingInventoryClassification(
  root: string,
  value: MatchingInventoryClassification,
) {
  const classification = normalizeClassification(value);
  const bytes = encodeCanonical(classification);
  const digest = sha(bytes);
  const path = matchingInventoryClassificationPath(root, digest);
  await writeImmutableBytesAtomic(path, bytes);
  const loaded = await readMatchingInventoryClassification(root, digest);
  if (!encodeCanonical(loaded).equals(bytes)) throw new Error("classification 저장 검증에 실패했습니다.");
  return Object.freeze({ sha256: digest, path });
}

export async function readMatchingInventoryClassification(
  root: string,
  digest: string,
): Promise<MatchingInventoryClassification> {
  const bytes = await readFile(matchingInventoryClassificationPath(root, digest));
  if (sha(bytes) !== digest) throw new Error("classification content address가 다릅니다.");
  const value = JSON.parse(bytes.toString("utf8")) as MatchingInventoryClassification;
  if (!bytes.equals(encodeCanonical(value))) throw new Error("classification canonical bytes가 다릅니다.");
  return normalizeClassification(value);
}

export async function storeMatchingCampaignIndex(root: string, value: MatchingCampaignIndex) {
  const campaign = validateCampaignIndexShape(value);
  const bytes = encodeCanonical(campaign);
  const digest = sha(bytes);
  const path = matchingCampaignIndexPath(root, digest);
  await writeImmutableBytesAtomic(path, bytes);
  const loaded = await readMatchingCampaignIndex(root, digest);
  if (encodeCanonical(loaded).compare(bytes) !== 0) throw new Error("campaign index 저장 검증에 실패했습니다.");
  return Object.freeze({ sha256: digest, path });
}

export async function readMatchingCampaignIndex(root: string, digest: string): Promise<MatchingCampaignIndex> {
  const bytes = await readFile(matchingCampaignIndexPath(root, digest));
  if (sha(bytes) !== digest) throw new Error("campaign index content address가 다릅니다.");
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!bytes.equals(encodeCanonical(value))) throw new Error("campaign index canonical bytes가 다릅니다.");
  return validateCampaignIndexShape(value);
}

export type MatchingCampaignChildOutcome = "individual_terminal" | "shared_stop";

export function classifyMatchingCampaignChildReceipt(receipt: AnalysisLaunchReceipt): MatchingCampaignChildOutcome {
  const normalized = normalizeAnalysisLaunchReceipt(receipt);
  return normalized.stopReason === "completed" && normalized.systemicFailure === null
    ? "individual_terminal"
    : "shared_stop";
}

export interface MatchingCampaignReceiptArtifact {
  readonly sha256: string;
  readonly receipt: AnalysisLaunchReceipt;
}

export type MatchingCampaignResumeSelection =
  | {
      readonly status: "resume_child";
      readonly childSequence: number;
      readonly childManifestSha256: string;
      readonly resumeGrantIds: readonly string[];
      readonly completedGrantIds: readonly string[];
      readonly reason: "not_started" | "shared_stop";
    }
  | {
      readonly status: "complete";
      readonly completedGrantIds: readonly string[];
      readonly individualResultGrantIds: readonly string[];
    };

export type MatchingCampaignRunNextPlan =
  | {
      readonly status: "command_plan";
      readonly campaignSha256: string;
      readonly childSequence: number;
      readonly childManifestSha256: string;
      readonly targetCount: number;
      readonly runtimeGeneration: number;
      readonly runtimeObservedAt: string;
      readonly automaticExecution: false;
      readonly userApprovalVerified: false;
      readonly commandKind: "grant" | "launch";
      readonly command: string;
      readonly note: string;
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | "shared_stop"
        | "multiple_grants"
        | "campaign_stage_prepare"
        | "campaign_stage_grant";
      readonly campaignSha256: string;
      readonly childManifestSha256: string;
      readonly automaticExecution: false;
      readonly userApprovalVerified: false;
      readonly existingGrantSha256s: readonly string[];
      readonly note: string;
    }
  | {
      readonly status: "complete";
      readonly campaignSha256: string;
      readonly automaticExecution: false;
      readonly userApprovalVerified: false;
      readonly note: string;
    };

export function createMatchingCampaignRunNextPlan(input: {
  readonly campaignSha256: string;
  readonly expectedChildManifestSha256: string;
  readonly approvedBy: string;
  readonly campaign: MatchingCampaignIndex;
  readonly selection: MatchingCampaignResumeSelection;
  readonly existingGrantSha256s: readonly string[];
  readonly runtime: {
    readonly mode: string;
    readonly generation: number;
    readonly localOwnerId: string | null;
    readonly localLeaseExpiresAt: string | null;
    readonly databaseObservedAt: string;
    readonly activeDeepLeases: number;
    readonly activeApplicationLeases: number;
  };
}): MatchingCampaignRunNextPlan {
  exactSha(input.campaignSha256, "campaign SHA");
  exactSha(input.expectedChildManifestSha256, "expected child manifest SHA");
  const campaign = validateCampaignIndexShape(input.campaign);
  if (sha(encodeCanonical(campaign)) !== input.campaignSha256) {
    throw new Error("run-next campaign SHA가 campaign index와 다릅니다.");
  }
  if (!input.approvedBy.trim()) throw new Error("run-next approved-by가 비어 있습니다.");
  const grants = [...new Set(input.existingGrantSha256s.map((value) => exactSha(value, "grant SHA")))].sort();
  if (grants.length !== input.existingGrantSha256s.length) {
    throw new Error("run-next existing grant SHA가 중복됐습니다.");
  }
  if (input.selection.status === "complete") {
    return Object.freeze({
      status: "complete",
      campaignSha256: input.campaignSha256,
      automaticExecution: false,
      userApprovalVerified: false,
      note: "campaign terminal receipt 확인이 끝났습니다. grant 또는 launch를 실행하지 않습니다.",
    });
  }
  if (input.selection.childManifestSha256 !== input.expectedChildManifestSha256) {
    throw new Error("run-next expected child SHA가 현재 다음 child와 다릅니다.");
  }
  const child = campaign.children[input.selection.childSequence];
  if (!child || child.manifestSha256 !== input.selection.childManifestSha256) {
    throw new Error("run-next selection이 campaign child와 다릅니다.");
  }
  assertPausedMatchingCampaignRuntime(input.runtime);
  const blocked = (
    reason: Extract<MatchingCampaignRunNextPlan, { status: "blocked" }>["reason"],
    note: string,
  ): MatchingCampaignRunNextPlan => Object.freeze({
    status: "blocked",
    reason,
    campaignSha256: input.campaignSha256,
    childManifestSha256: child.manifestSha256,
    automaticExecution: false,
    userApprovalVerified: false,
    existingGrantSha256s: Object.freeze(grants),
    note,
  });
  if (input.selection.reason === "shared_stop") {
    return blocked("shared_stop", "shared stop은 자동 재개하지 않습니다. 원인과 사용창을 확인한 뒤 같은 child를 별도로 재개해야 합니다.");
  }
  if (campaign.execution.allowedStage === "prepare") {
    return blocked("campaign_stage_prepare", "campaign scope가 prepare까지만 허용되어 grant command를 만들지 않습니다.");
  }
  if (grants.length > 1) {
    return blocked("multiple_grants", "같은 child에 grant가 둘 이상 있어 임의 선택하지 않습니다.");
  }
  if (grants.length === 1 && campaign.execution.allowedStage !== "launch") {
    return blocked("campaign_stage_grant", "campaign scope가 grant까지만 허용되어 launch command를 만들지 않습니다.");
  }
  const commandKind = grants.length === 0 ? "grant" : "launch";
  const command = commandKind === "grant"
    ? `pnpm lab:launch:grant -- --manifest=${child.manifestSha256} --approved-by=${shellQuote(input.approvedBy)}`
    : `pnpm lab:launch -- --grant=${grants[0]}`;
  return Object.freeze({
    status: "command_plan",
    campaignSha256: input.campaignSha256,
    childSequence: child.sequence,
    childManifestSha256: child.manifestSha256,
    targetCount: child.targetCount,
    runtimeGeneration: input.runtime.generation,
    runtimeObservedAt: input.runtime.databaseObservedAt,
    automaticExecution: false,
    userApprovalVerified: false,
    commandKind,
    command,
    note: "외부의 사용자 승인 증거를 CLI가 추정하지 않는 command-plan입니다. 출력된 명령은 자동 실행되지 않습니다.",
  });
}

export function selectMatchingCampaignResume(input: {
  readonly campaign: MatchingCampaignIndex;
  readonly receipts: readonly MatchingCampaignReceiptArtifact[];
}): MatchingCampaignResumeSelection {
  const campaign = validateCampaignIndexShape(input.campaign);
  const byManifest = new Map<string, { sha256: string; receipt: AnalysisLaunchReceipt }[]>();
  for (const artifact of input.receipts) {
    exactSha(artifact.sha256, "receiptSha256");
    const receipt = normalizeAnalysisLaunchReceipt(artifact.receipt);
    if (sha(encodeCanonical(receipt)) !== artifact.sha256) throw new Error("campaign receipt SHA가 다릅니다.");
    if (!campaign.children.some((child) => child.manifestSha256 === receipt.manifestSha256)) {
      throw new Error("campaign 범위 밖 receipt가 있습니다.");
    }
    const list = byManifest.get(receipt.manifestSha256) ?? [];
    list.push({ sha256: artifact.sha256, receipt });
    byManifest.set(receipt.manifestSha256, list);
  }
  const completed = new Set<string>();
  const individualResults = new Set<string>();
  let encounteredGap = false;
  for (const child of campaign.children) {
    const receipts = (byManifest.get(child.manifestSha256) ?? [])
      .sort((left, right) => left.receipt.finishedAt.localeCompare(right.receipt.finishedAt));
    if (receipts.length === 0) {
      encounteredGap = true;
      const laterReceiptExists = campaign.children.slice(child.sequence + 1)
        .some((later) => (byManifest.get(later.manifestSha256)?.length ?? 0) > 0);
      if (laterReceiptExists) throw new Error("campaign child receipt 순서가 순차 실행과 다릅니다.");
      return Object.freeze({
        status: "resume_child",
        childSequence: child.sequence,
        childManifestSha256: child.manifestSha256,
        resumeGrantIds: child.targetGrantIds,
        completedGrantIds: Object.freeze([...completed]),
        reason: "not_started",
      });
    }
    if (encounteredGap) throw new Error("campaign receipt가 미착수 child 뒤에 존재합니다.");
    const latestStatuses = new Map<string, AnalysisLaunchReceipt["targets"][number]["status"]>();
    for (const { receipt } of receipts) {
      assertReceiptTargets(child.targetGrantIds, receipt);
      for (const target of receipt.targets) {
        if (target.status !== "skipped") latestStatuses.set(target.grantId, target.status);
      }
    }
    const latest = receipts[receipts.length - 1]!.receipt;
    for (const grantId of child.targetGrantIds) {
      const status = latestStatuses.get(grantId);
      if (status === "publishable" || status === "held") completed.add(grantId);
      else individualResults.add(grantId);
    }
    if (classifyMatchingCampaignChildReceipt(latest) === "shared_stop") {
      // failed/held는 공고별 terminal 결과다. shared stop 전에 실제로 미착수된
      // skipped target만 기존 runner의 같은 child 재개 대상으로 남긴다.
      const resumeGrantIds = child.targetGrantIds.filter((grantId) => latestStatuses.get(grantId) === undefined);
      return Object.freeze({
        status: "resume_child",
        childSequence: child.sequence,
        childManifestSha256: child.manifestSha256,
        resumeGrantIds: Object.freeze(resumeGrantIds),
        completedGrantIds: Object.freeze([...completed]),
        reason: "shared_stop",
      });
    }
  }
  return Object.freeze({
    status: "complete",
    completedGrantIds: Object.freeze([...completed]),
    individualResultGrantIds: Object.freeze([...individualResults]),
  });
}

function assertReceiptTargets(targetGrantIds: readonly string[], receipt: AnalysisLaunchReceipt): void {
  if (receipt.targets.length !== targetGrantIds.length) throw new Error("campaign receipt target 수가 child와 다릅니다.");
  for (const [sequence, grantId] of targetGrantIds.entries()) {
    const target = receipt.targets[sequence];
    if (!target || target.sequence !== sequence || target.grantId !== grantId) {
      throw new Error("campaign receipt target 결속이 child와 다릅니다.");
    }
  }
}

function normalizeClassification(value: MatchingInventoryClassification): MatchingInventoryClassification {
  if ((value.schema !== MATCHING_INVENTORY_CLASSIFICATION_SCHEMA
    && value.schema !== LEGACY_MATCHING_INVENTORY_CLASSIFICATION_SCHEMA)
    || value.targetCount !== value.entries.length
    || value.targetCount !== value.targetGrantIds.length) {
    throw new Error("matching inventory classification 계약이 잘못됐습니다.");
  }
  exactInstant(value.observedAt, "observedAt");
  const regeneratedCounts = emptyCategoryCounts();
  for (const [index, item] of value.entries.entries()) {
    if (item.grantId !== value.targetGrantIds[index]) throw new Error("classification target 순서가 다릅니다.");
    exactUuid(item.grantId, "classification grantId");
    if ((item.current.inputSha256 === null) !== (item.current.attachmentManifestSha256 === null)) {
      throw new Error("classification current material 결속이 불완전합니다.");
    }
    if (item.current.inputSha256 === null) {
      if (value.schema === LEGACY_MATCHING_INVENTORY_CLASSIFICATION_SCHEMA || item.campaignEligible) {
        throw new Error("classification 실행 대상에 current material이 없습니다.");
      }
    } else {
      exactSha(item.current.inputSha256, "classification inputSha256");
      exactSha(item.current.attachmentManifestSha256!, "classification attachmentManifestSha256");
    }
    if (value.schema === MATCHING_INVENTORY_CLASSIFICATION_SCHEMA) {
      if (item.supplyStage === undefined || item.supplyEvidenceSha256 === undefined
        || (item.supplyStage !== null && item.supplyStage !== "inactive"
          && (!item.supplyEvidenceSha256 || !SHA.test(item.supplyEvidenceSha256)))
        || ((item.supplyStage === null || item.supplyStage === "inactive")
          && item.supplyEvidenceSha256 !== null)) {
        throw new Error("classification supply evidence 결속이 잘못됐습니다.");
      }
      if (item.campaignEligible && item.supplyStage !== null
        && item.supplyStage !== "await_approved_model_run") {
        throw new Error("classification 실행 대상의 supply 단계가 다릅니다.");
      }
    }
    regeneratedCounts[item.category] += 1;
  }
  if (!encodeCanonical(regeneratedCounts).equals(encodeCanonical(value.counts))) {
    throw new Error("classification counts가 entries와 다릅니다.");
  }
  return value;
}

function validateCampaignIndexShape(value: unknown): MatchingCampaignIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("matching campaign index 계약이 잘못됐습니다.");
  }
  const raw = value as Record<string, unknown>;
  const normalized = raw.schema === LEGACY_MATCHING_CAMPAIGN_INDEX_SCHEMA
    ? upgradeLegacyMatchingCampaignIndex(raw)
    : value as MatchingCampaignIndex;
  if (normalized.schema !== MATCHING_CAMPAIGN_INDEX_SCHEMA
    || normalized.execution.strategy !== "sequential_child_manifests"
    || normalized.execution.concurrency !== 2
    || validateMatchingCampaignChildSize(normalized.execution.childSize) !== normalized.execution.childSize
    || normalized.execution.liveAuthority !== "none"
    || normalized.execution.requiredAuthority !== "analysis-launch-grant-v1-per-child"
    || normalized.userScope.grantsStillRequired !== true
    || normalized.userScope.allowedStage !== normalized.execution.allowedStage
    || normalized.children.length === 0
    || normalized.snapshot.targetCount !== normalized.snapshot.targetGrantIds.length) {
    throw new Error("matching campaign index 계약이 잘못됐습니다.");
  }
  exactInstant(normalized.preparedAt, "preparedAt");
  exactInstant(normalized.snapshot.observedAt, "snapshot.observedAt");
  exactSha(normalized.snapshot.classificationSha256, "classificationSha256");
  if (normalized.userScope.childManifestSha256s.length !== normalized.children.length) {
    throw new Error("campaign user scope child 수가 다릅니다.");
  }
  for (const [sequence, child] of normalized.children.entries()) {
    if (child.sequence !== sequence
      || child.manifestSha256 !== normalized.userScope.childManifestSha256s[sequence]
      || child.targetCount !== child.targetGrantIds.length
      || child.targetGrantIds.length < 1
      || child.targetGrantIds.length > normalized.execution.childSize
      || child.material.analysisMode !== "matching_only") {
      throw new Error("campaign child index가 잘못됐습니다.");
    }
    exactSha(child.manifestSha256, "child.manifestSha256");
    exactSha(child.inventorySha256, "child.inventorySha256");
    exactSha(child.material.packageRuntimeSha256, "child.packageRuntimeSha256");
  }
  return normalized;
}

function upgradeLegacyMatchingCampaignIndex(value: Record<string, unknown>): MatchingCampaignIndex {
  const execution = value.execution as MatchingCampaignIndex["execution"] | undefined;
  const children = value.children as MatchingCampaignIndex["children"] | undefined;
  if (!execution || !Array.isArray(children)) {
    throw new Error("legacy matching campaign index 계약이 잘못됐습니다.");
  }
  return {
    ...(value as unknown as Omit<MatchingCampaignIndex, "schema" | "execution" | "children">),
    schema: MATCHING_CAMPAIGN_INDEX_SCHEMA,
    execution: {
      ...execution,
      childSize: MATCHING_CAMPAIGN_MAX_CHILD_TARGETS,
    },
    children: children.map((child) => ({
      ...child,
      targetCount: child.targetGrantIds.length,
    })),
  };
}

function validateMatchingCampaignChildSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MATCHING_CAMPAIGN_MAX_CHILD_TARGETS) {
    throw new Error("campaign child-size는 1~100 정수여야 합니다.");
  }
  return value;
}

function assertPausedMatchingCampaignRuntime(runtime: {
  readonly mode: string;
  readonly generation: number;
  readonly localOwnerId: string | null;
  readonly localLeaseExpiresAt: string | null;
  readonly databaseObservedAt: string;
  readonly activeDeepLeases: number;
  readonly activeApplicationLeases: number;
}): void {
  if (runtime.mode !== "paused"
    || runtime.localOwnerId !== null
    || runtime.localLeaseExpiresAt !== null
    || runtime.activeDeepLeases !== 0
    || runtime.activeApplicationLeases !== 0) {
    throw new Error("run-next runtime은 paused/owner 없음/active lease 0이어야 합니다.");
  }
  if (!Number.isSafeInteger(runtime.generation) || runtime.generation < 0
    || !Number.isFinite(Date.parse(runtime.databaseObservedAt))) {
    throw new Error("run-next runtime snapshot이 잘못됐습니다.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function exactUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new Error(`${label}가 UUID가 아닙니다.`);
  return value;
}

function exactSha(value: string, label: string): string {
  if (!SHA.test(value)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return value;
}

function exactInstant(value: string, label: string): string {
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label}가 canonical ISO 시각이 아닙니다.`);
  }
  return value;
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
