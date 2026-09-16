import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/lib/server/analysis-lab/lab-contract";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import {
  normalizeAnalysisFeatureReadiness,
  type AnalysisFeatureReadiness,
} from "../analysis-serving/analysisFeatureReadiness";
import type { AuthoringGuideAdoptionManifest } from "./authoring-guide-adoption";
import { DEEP_REPAIR_PREPARATION_POLICY } from "./deep-repair-preparation";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/;
const SERIES = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUNDTRIP_RUN_ID = /^roundtrip-[0-9TZ.\-]{10,40}-[a-f0-9]{6}$/;
const MAX_LAUNCH_TARGETS = 100;

export interface AnalysisLaunchManifestTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly stratum: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly inventoryInputSha256: string;
  readonly inventoryAttachmentManifestSha256: string;
  readonly changedSinceInventory: boolean;
  readonly reviewRepair?: {
    readonly sourceRunId: string;
    readonly reviewModel: string;
    readonly blockingCount: number;
    readonly taskInstruction: string;
  };
  readonly applicationRoundtripReuse?: AnalysisLaunchApplicationRoundtripReuseBinding;
}

interface AnalysisLaunchApplicationRoundtripReuseBindingCommon {
  readonly sourceSequence: number;
  readonly sourceLabRunId: string;
  readonly sourceLabRunArtifactPath: string;
  readonly sourceLabRunArtifactSha256: string;
  readonly sourceRoundtripRunId: string;
  readonly analysisArtifactSha256: string;
  readonly manifestArtifactSha256: string;
  readonly parsedMarkdown: readonly {
    readonly attachmentId: string;
    readonly sha256: string;
  }[];
  readonly independentReviewAggregatePath: string;
  readonly independentReviewAggregateSha256: string;
  readonly independentReviewManifestPath: string;
  readonly independentReviewManifestSha256: string;
  readonly sourceLaunchReceiptSha256: string;
}

/** 기존 독립 검수 primary repair에서 완결된 application 분석만 재사용한 역사 계약. */
export interface AnalysisLaunchReviewedApplicationRoundtripReuseBinding
  extends AnalysisLaunchApplicationRoundtripReuseBindingCommon {
  readonly schema: "analysis-launch-application-roundtrip-reuse-v1";
}

/** primary만 실패했고 application 분석은 조건부 사용 가능한 경우의 별도 provenance. */
export interface AnalysisLaunchFailedPrimaryApplicationRoundtripReuseBinding
  extends AnalysisLaunchApplicationRoundtripReuseBindingCommon {
  readonly schema: "analysis-launch-application-roundtrip-reuse-v2";
  readonly sourceDisposition: "failed_primary_valid_application";
  readonly applicationFieldRuntimeSha256: string;
}

export type AnalysisLaunchApplicationRoundtripReuseBinding =
  | AnalysisLaunchReviewedApplicationRoundtripReuseBinding
  | AnalysisLaunchFailedPrimaryApplicationRoundtripReuseBinding;

export interface AnalysisLaunchManifest {
  readonly schema: "analysis-launch-manifest-v1";
  readonly preparedAt: string;
  readonly source: {
    readonly kind: "formal_plan" | "current_inventory" | "authoring_guide_adoption" | "independent_review_repair";
    readonly seriesId: string;
    readonly planSha256: string;
    readonly planArtifactSha256: string;
    readonly adoptionManifestSha256: string | null;
    /**
     * 완료된 current-inventory launch를 같은 exact inventory와 현행 material 계약으로
     * 다시 봉인할 때만 존재한다. live grant가 아니라 읽기 전용 ancestry다.
     */
    readonly completedLaunch?: AnalysisLaunchCompletedCurrentInventoryBinding;
    readonly terminalRepair?: AnalysisLaunchTerminalRepairBinding;
    readonly sequenceFrom: number;
    readonly sequenceTo: number;
  };
  readonly execution: {
    readonly transport: "claude-cli";
    readonly model: string;
    readonly promptVersion: string;
    readonly validatorVersion: string;
    readonly packageRuntimeSha256: string;
    /** 관측용이다. 승인 유지 여부는 material contract로 판정하며 전체 git SHA로 판정하지 않는다. */
    readonly gitShaAtPreparation: string;
    readonly withApplicationRoundtrip: boolean;
    readonly roundtripModel: string | null;
    readonly applicationFieldAnalysisVersion: string | null;
    readonly concurrency: number;
    readonly existingRunPolicy: "skip_existing" | "rerun_exact_targets";
  };
  readonly targets: readonly AnalysisLaunchManifestTarget[];
}

export interface AnalysisLaunchCompletedCurrentInventoryBindingV1 {
  readonly schema: "analysis-launch-completed-current-inventory-v1";
  readonly inventorySha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceGrantSha256: string;
  readonly terminalReceiptSha256: string;
}

/**
 * 완료된 원 launch의 일부만 현행 계약으로 다시 봉인한다. 새 manifest sequence는 0부터
 * 다시 부여하고, 이 배열이 각 target을 원 manifest sequence에 exact 결속한다.
 */
export interface AnalysisLaunchCompletedCurrentInventoryBindingV2 {
  readonly schema: "analysis-launch-completed-current-inventory-v2";
  readonly inventorySha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceGrantSha256: string;
  readonly terminalReceiptSha256: string;
  readonly selectedOriginalSequences: readonly number[];
}

export type AnalysisLaunchCompletedCurrentInventoryBinding =
  | AnalysisLaunchCompletedCurrentInventoryBindingV1
  | AnalysisLaunchCompletedCurrentInventoryBindingV2;

export interface AnalysisLaunchTerminalRepairBinding {
  readonly schema: "analysis-launch-terminal-repair-v1";
  readonly sourceManifestSha256: string;
  readonly sourceGrantSha256: string;
  readonly receiptSha256s: readonly string[];
  readonly originalSequences: readonly number[];
}

export interface AnalysisLaunchGrant {
  readonly schema: "analysis-launch-grant-v1";
  readonly manifestSha256: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly scope: "launch-batch-live";
  readonly stopAfter: "manifest-terminal";
  readonly targetCount: number;
}

export interface AnalysisLaunchReceiptTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly status: "publishable" | "held" | "failed" | "skipped";
  readonly runArtifactPath: string | null;
  readonly runArtifactSha256: string | null;
  readonly applicationRoundtripStatus: string | null;
  readonly applicationDocumentCount: number | null;
  readonly fieldReadyDocumentCount: number | null;
  readonly recognizedFieldCount: number | null;
  /** 신규 receipt의 기능별 파생 판정. 구 receipt 부재는 unverified이며 ready로 추정하지 않는다. */
  readonly featureReadiness?: AnalysisFeatureReadiness;
  /** 구 receipt에는 없다. 부재는 verified가 아니라 unverified다. */
  readonly primaryMatchingProjection?: AnalysisLaunchMatchingProjectionBinding;
  readonly error: string | null;
}

export interface AnalysisLaunchMatchingProjectionBinding {
  readonly schema: "analysis-launch-primary-matching-projection-binding-v1";
  readonly verification: "verified" | "failed";
  readonly snapshotSha256: string;
  readonly sourceCriteriaSha256: string;
  readonly projectedCriteriaSha256: string;
  readonly reportSha256: string;
  readonly conversionContractVersion: string;
  readonly converterVersion: string;
  readonly normalizerContractVersion: string;
  readonly matcherRulesetVersion: string;
}

export interface AnalysisLaunchReceipt {
  readonly schema: "analysis-launch-receipt-v1";
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lifecycle: "finished";
  readonly stopReason: "completed" | "window-exhausted" | "aborted" | "systemic-failure";
  readonly systemicFailure: string | null;
  readonly summary: {
    readonly publishable: number;
    readonly held: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly targets: readonly AnalysisLaunchReceiptTarget[];
}

export interface AnalysisLaunchPlanTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly stratum: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
}

export interface AnalysisLaunchPlanInventory {
  readonly seriesId: string;
  readonly planSha256: string;
  readonly planArtifactSha256: string;
  readonly model: string;
  readonly targets: readonly AnalysisLaunchPlanTarget[];
}

export interface AnalysisLaunchPreparedTarget {
  readonly grantId: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
}

interface AnalysisLaunchManifestPreparationInput {
  readonly inventory: AnalysisLaunchPlanInventory;
  readonly sequenceFrom: number;
  readonly sequenceTo: number;
  readonly preparedTargets: readonly AnalysisLaunchPreparedTarget[];
  readonly provenance: {
    readonly gitSha: string;
    readonly packageRuntimeSha256: string;
    readonly validatorVersion: string;
  };
  readonly withApplicationRoundtrip: boolean;
  readonly roundtripModel?: string;
  readonly concurrency: number;
  readonly now: Date;
}

export function createAnalysisLaunchManifest(
  input: AnalysisLaunchManifestPreparationInput,
): AnalysisLaunchManifest {
  if (input.withApplicationRoundtrip !== true) {
    throw new Error("정식 launch는 RHWP 신청서 필드 분석을 포함해야 합니다.");
  }
  if (
    input.roundtripModel !== undefined
    && input.roundtripModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
  ) {
    throw new Error(`정식 launch 필드 분석 모델은 ${APPLICATION_ROUNDTRIP_ADOPTED_MODEL}이어야 합니다.`);
  }
  return createAnalysisLaunchManifestFromInventory({
    ...input,
    withApplicationRoundtrip: true,
    roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  }, {
    sourceKind: "formal_plan",
    adoptionManifestSha256: null,
    existingRunPolicy: "skip_existing",
  });
}

/** 현행 재고의 exact 목록. 역사 formal 표본 수/필수 층 계약은 변경하지 않는다. */
export function createCurrentInventoryAnalysisLaunchManifest(
  input: AnalysisLaunchManifestPreparationInput & {
    readonly completedLaunch?: AnalysisLaunchCompletedCurrentInventoryBinding;
    readonly terminalRepair?: AnalysisLaunchTerminalRepairBinding;
  },
): AnalysisLaunchManifest {
  if (input.inventory.planSha256 !== input.inventory.planArtifactSha256) {
    throw new Error("current inventory의 content address 결속이 다릅니다.");
  }
  const formal = createAnalysisLaunchManifest(input);
  return normalizeAnalysisLaunchManifest({
    ...formal,
    source: {
      ...formal.source,
      kind: "current_inventory",
      ...(input.completedLaunch ? { completedLaunch: input.completedLaunch } : {}),
      ...(input.terminalRepair ? { terminalRepair: input.terminalRepair } : {}),
    },
    execution: {
      ...formal.execution,
      existingRunPolicy: input.completedLaunch || input.terminalRepair ? "rerun_exact_targets" : "skip_existing",
    },
  });
}

export function createAuthoringGuideRerunAnalysisLaunchManifest(input: {
  readonly adoptionManifestSha256: string;
  readonly adoptionManifest: AuthoringGuideAdoptionManifest;
  readonly preparedTargets: readonly AnalysisLaunchPreparedTarget[];
  readonly provenance: AnalysisLaunchManifestPreparationInput["provenance"];
  readonly concurrency: number;
  readonly now: Date;
}): AnalysisLaunchManifest {
  const adoptionManifestSha256 = exactSha(
    input.adoptionManifestSha256,
    "adoptionManifestSha256",
  );
  if (
    input.adoptionManifest.schema !== "authoring-guide-adoption-manifest-v1"
    || input.adoptionManifest.execution.mode !== "offline_read_only"
    || input.adoptionManifest.execution.modelCallsMade !== 0
    || input.adoptionManifest.execution.databaseWritesMade !== 0
    || input.adoptionManifest.execution.promotionAuthorized !== false
  ) {
    throw new Error("작성 가이드 adoption manifest가 재분석 준비 계약과 다릅니다.");
  }
  const selected = input.adoptionManifest.items.filter((item) => (
    item.disposition === "rerun_required" && item.current.sourceSealed
  ));
  if (selected.length === 0) throw new Error("source-sealed 작성 가이드 재분석 대상이 없습니다.");
  const seriesId = `authoring-guide-rerun-${input.adoptionManifest.asOfKst.replaceAll("-", "")}`;
  const manifest = createAnalysisLaunchManifestFromInventory({
    inventory: {
      seriesId,
      planSha256: adoptionManifestSha256,
      planArtifactSha256: adoptionManifestSha256,
      model: DEEP_REPAIR_PREPARATION_POLICY.model,
      targets: selected.map((item, sequence) => ({
        sequence,
        grantId: item.grantId,
        stratum: `${item.source}/authoring-guide-rerun`,
        inputSha256: item.current.inputSha256,
        attachmentManifestSha256: item.current.attachmentManifestSha256,
      })),
    },
    sequenceFrom: 0,
    sequenceTo: selected.length - 1,
    preparedTargets: input.preparedTargets,
    provenance: input.provenance,
    withApplicationRoundtrip: false,
    concurrency: input.concurrency,
    now: input.now,
  }, {
    sourceKind: "authoring_guide_adoption",
    adoptionManifestSha256,
    existingRunPolicy: "rerun_exact_targets",
  });
  if (manifest.targets.some((target) => target.changedSinceInventory)) {
    throw new Error("작성 가이드 재분석 target input/attachment가 adoption manifest와 달라졌습니다.");
  }
  return manifest;
}

export function createIndependentReviewRepairAnalysisLaunchManifest(input: {
  readonly aggregateSha256: string;
  readonly targets: readonly {
    readonly originalSequence: number;
    readonly grantId: string;
    readonly source: string;
    readonly inputSha256: string;
    readonly attachmentManifestSha256: string;
    readonly reviewRepair?: {
      readonly sourceRunId: string;
      readonly reviewModel: string;
      readonly blockingCount: number;
      readonly taskInstruction: string;
    } | null;
    readonly applicationRoundtripReuse?: AnalysisLaunchApplicationRoundtripReuseBinding | null;
  }[];
  readonly preparedTargets: readonly AnalysisLaunchPreparedTarget[];
  readonly provenance: AnalysisLaunchManifestPreparationInput["provenance"];
  readonly concurrency: number;
  readonly now: Date;
}): AnalysisLaunchManifest {
  const aggregateSha256 = exactSha(input.aggregateSha256, "aggregateSha256");
  if (input.targets.length === 0) throw new Error("독립 검수 합의 결함 재분석 대상이 없습니다.");
  const originalSequences = input.targets.map((target) => target.originalSequence);
  if (
    originalSequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)
    || new Set(originalSequences).size !== originalSequences.length
    || originalSequences.some((sequence, index) => index > 0 && sequence <= originalSequences[index - 1]!)
  ) {
    throw new Error("독립 검수 합의 결함 원본 sequence는 중복 없이 오름차순이어야 합니다.");
  }
  if (input.targets.some((target) => (
    target.applicationRoundtripReuse
    && target.applicationRoundtripReuse.sourceSequence !== target.originalSequence
  ))) {
    throw new Error("Kordoc exact 재사용 source sequence가 독립 검수 원본 sequence와 다릅니다.");
  }
  const manifest = createAnalysisLaunchManifestFromInventory({
    inventory: {
      seriesId: `independent-review-repair-${aggregateSha256.slice(0, 16)}`,
      planSha256: aggregateSha256,
      planArtifactSha256: aggregateSha256,
      model: DEEP_REPAIR_PREPARATION_POLICY.model,
      targets: input.targets.map((target, sequence) => ({
        sequence,
        grantId: target.grantId,
        stratum: `${requireNonEmpty(target.source, "target.source")}/independent-review-repair/original-${target.originalSequence}`,
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256,
      })),
    },
    sequenceFrom: 0,
    sequenceTo: input.targets.length - 1,
    preparedTargets: input.preparedTargets,
    provenance: input.provenance,
    withApplicationRoundtrip: true,
    roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    concurrency: input.concurrency,
    now: input.now,
  }, {
    sourceKind: "independent_review_repair",
    adoptionManifestSha256: null,
    existingRunPolicy: "rerun_exact_targets",
  });
  if (manifest.targets.some((target) => target.changedSinceInventory)) {
    throw new Error("독립 검수 합의 결함 target input/attachment가 원본 launch와 달라졌습니다.");
  }
  return normalizeAnalysisLaunchManifest({
    ...manifest,
    targets: manifest.targets.map((target, index) => ({
      ...target,
      ...(input.targets[index]?.reviewRepair
        ? { reviewRepair: input.targets[index]!.reviewRepair }
        : {}),
      ...(input.targets[index]?.applicationRoundtripReuse
        ? { applicationRoundtripReuse: input.targets[index]!.applicationRoundtripReuse }
        : {}),
    })),
  });
}

function createAnalysisLaunchManifestFromInventory(
  input: AnalysisLaunchManifestPreparationInput,
  binding: {
    readonly sourceKind: AnalysisLaunchManifest["source"]["kind"];
    readonly adoptionManifestSha256: string | null;
    readonly existingRunPolicy: AnalysisLaunchManifest["execution"]["existingRunPolicy"];
  },
): AnalysisLaunchManifest {
  const inventory = normalizeInventory(input.inventory);
  if (
    !Number.isSafeInteger(input.sequenceFrom)
    || !Number.isSafeInteger(input.sequenceTo)
    || input.sequenceFrom < 0
    || input.sequenceTo < input.sequenceFrom
  ) {
    throw new Error("launch sequence 범위가 잘못됐습니다.");
  }
  const selected = inventory.targets.filter(
    (target) => target.sequence >= input.sequenceFrom && target.sequence <= input.sequenceTo,
  );
  if (
    selected.length === 0
    || selected.length > MAX_LAUNCH_TARGETS
    || selected[0]?.sequence !== input.sequenceFrom
    || selected.at(-1)?.sequence !== input.sequenceTo
  ) {
    throw new Error("launch sequence 범위가 plan의 연속 target과 일치하지 않습니다.");
  }
  const preparedByGrant = new Map(input.preparedTargets.map((target) => [target.grantId, target]));
  if (preparedByGrant.size !== selected.length) {
    throw new Error("launch prepared target 수 또는 grantId가 inventory와 다릅니다.");
  }
  const targets = selected.map((target): AnalysisLaunchManifestTarget => {
    const prepared = preparedByGrant.get(target.grantId);
    if (!prepared || prepared.grantId !== target.grantId) {
      throw new Error(`launch target 준비 결과가 없습니다: ${target.grantId}`);
    }
    const inputSha256 = exactSha(prepared.inputSha256, `${target.grantId}.inputSha256`);
    const attachmentManifestSha256 = exactSha(
      prepared.attachmentManifestSha256,
      `${target.grantId}.attachmentManifestSha256`,
    );
    return Object.freeze({
      sequence: target.sequence,
      grantId: target.grantId,
      stratum: target.stratum,
      inputSha256,
      attachmentManifestSha256,
      inventoryInputSha256: target.inputSha256,
      inventoryAttachmentManifestSha256: target.attachmentManifestSha256,
      changedSinceInventory:
        inputSha256 !== target.inputSha256
        || attachmentManifestSha256 !== target.attachmentManifestSha256,
    });
  });
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) {
    throw new Error("launch concurrency는 1~4 정수여야 합니다.");
  }
  const roundtripModel = input.withApplicationRoundtrip
    ? requireNonEmpty(input.roundtripModel ?? inventory.model, "roundtripModel")
    : null;
  const preparedAt = input.now.toISOString();
  if (!Number.isFinite(Date.parse(preparedAt))) throw new Error("launch preparedAt이 잘못됐습니다.");
  return normalizeAnalysisLaunchManifest({
    schema: "analysis-launch-manifest-v1",
    preparedAt,
    source: {
      kind: binding.sourceKind,
      seriesId: inventory.seriesId,
      planSha256: inventory.planSha256,
      planArtifactSha256: inventory.planArtifactSha256,
      adoptionManifestSha256: binding.adoptionManifestSha256,
      sequenceFrom: input.sequenceFrom,
      sequenceTo: input.sequenceTo,
    },
    execution: {
      transport: "claude-cli",
      model: inventory.model,
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      validatorVersion: exactString(input.provenance.validatorVersion, "validatorVersion"),
      packageRuntimeSha256: exactSha(
        input.provenance.packageRuntimeSha256,
        "packageRuntimeSha256",
      ),
      gitShaAtPreparation: exactGitSha(input.provenance.gitSha),
      withApplicationRoundtrip: input.withApplicationRoundtrip,
      roundtripModel,
      applicationFieldAnalysisVersion: input.withApplicationRoundtrip
        ? APPLICATION_ROUNDTRIP_VERSION
        : null,
      concurrency: input.concurrency,
      existingRunPolicy: binding.existingRunPolicy,
    },
    targets,
  });
}

export function createAnalysisLaunchGrant(input: {
  readonly manifestSha256: string;
  readonly targetCount: number;
  readonly approvedBy: string;
  readonly now: Date;
}): AnalysisLaunchGrant {
  return normalizeAnalysisLaunchGrant({
    schema: "analysis-launch-grant-v1",
    manifestSha256: exactSha(input.manifestSha256, "manifestSha256"),
    approvedBy: requireNonEmpty(input.approvedBy, "approvedBy"),
    approvedAt: input.now.toISOString(),
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount: input.targetCount,
  });
}

type AnalysisLaunchManifestNormalizationPurpose =
  | "live"
  | "completed-current-inventory-source"
  | "completed-receipt-offline-consumer";

export function normalizeAnalysisLaunchManifest(value: unknown): AnalysisLaunchManifest {
  return normalizeAnalysisLaunchManifestForPurpose(value, "live");
}

/**
 * current-inventory 재봉인의 읽기 전용 ancestry 검증 전용이다. 이 함수가 허용한 역사
 * material은 새 manifest의 실행 계약이나 grant/run admission에는 사용되지 않는다.
 */
export function normalizeCompletedCurrentInventorySourceManifest(
  value: unknown,
): AnalysisLaunchManifest {
  return normalizeAnalysisLaunchManifestForPurpose(value, "completed-current-inventory-source");
}

/**
 * terminal receipt가 가리키는 원 실행을 오프라인에서 재검증할 때만 사용한다.
 * 허용된 역사 tuple은 live grant/run admission으로 승격되지 않는다.
 */
export function normalizeCompletedAnalysisLaunchManifestForOfflineConsumption(
  value: unknown,
): AnalysisLaunchManifest {
  return normalizeAnalysisLaunchManifestForPurpose(value, "completed-receipt-offline-consumer");
}

function normalizeAnalysisLaunchManifestForPurpose(
  value: unknown,
  purpose: AnalysisLaunchManifestNormalizationPurpose,
): AnalysisLaunchManifest {
  const record = object(value, "manifest");
  if (record.schema !== "analysis-launch-manifest-v1") throw new Error("launch manifest schema가 다릅니다.");
  const source = object(record.source, "manifest.source");
  const execution = object(record.execution, "manifest.execution");
  if (!Array.isArray(record.targets) || record.targets.length < 1 || record.targets.length > MAX_LAUNCH_TARGETS) {
    throw new Error("launch manifest targets 수가 잘못됐습니다.");
  }
  const targets = record.targets.map((raw, index): AnalysisLaunchManifestTarget => {
    const target = object(raw, `manifest.targets[${index}]`);
    const sequence = integer(target.sequence, `targets[${index}].sequence`);
    if (sequence !== integer(source.sequenceFrom, "source.sequenceFrom") + index) {
      throw new Error("launch manifest sequence가 연속적이지 않습니다.");
    }
    const inventoryInputSha256 = exactSha(String(target.inventoryInputSha256), "inventoryInputSha256");
    const inventoryAttachmentManifestSha256 = exactSha(
      String(target.inventoryAttachmentManifestSha256),
      "inventoryAttachmentManifestSha256",
    );
    const inputSha256 = exactSha(String(target.inputSha256), "inputSha256");
    const attachmentManifestSha256 = exactSha(
      String(target.attachmentManifestSha256),
      "attachmentManifestSha256",
    );
    const changedSinceInventory = target.changedSinceInventory === true;
    if (
      changedSinceInventory !== (
        inputSha256 !== inventoryInputSha256
        || attachmentManifestSha256 !== inventoryAttachmentManifestSha256
      )
    ) {
      throw new Error("launch target changedSinceInventory가 SHA 비교와 다릅니다.");
    }
    const reviewRepair = target.reviewRepair === undefined
      ? undefined
      : normalizeLaunchReviewRepair(target.reviewRepair, `targets[${index}].reviewRepair`);
    const applicationRoundtripReuse = target.applicationRoundtripReuse === undefined
      ? undefined
      : normalizeAnalysisLaunchApplicationRoundtripReuseBinding(
          target.applicationRoundtripReuse,
          `targets[${index}].applicationRoundtripReuse`,
        );
    return Object.freeze({
      sequence,
      grantId: exactUuid(target.grantId, "grantId"),
      stratum: requireNonEmpty(target.stratum, "stratum"),
      inputSha256,
      attachmentManifestSha256,
      inventoryInputSha256,
      inventoryAttachmentManifestSha256,
      changedSinceInventory,
      ...(reviewRepair ? { reviewRepair } : {}),
      ...(applicationRoundtripReuse ? { applicationRoundtripReuse } : {}),
    });
  });
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length) {
    throw new Error("launch manifest grantId가 중복됐습니다.");
  }
  const sequenceFrom = integer(source.sequenceFrom, "source.sequenceFrom");
  const sequenceTo = integer(source.sequenceTo, "source.sequenceTo");
  if (sequenceFrom < 0 || sequenceTo !== sequenceFrom + targets.length - 1) {
    throw new Error("launch manifest source sequence 범위가 targets와 다릅니다.");
  }
  const withApplicationRoundtrip = execution.withApplicationRoundtrip === true;
  const roundtripModel = execution.roundtripModel === null
    ? null
    : requireNonEmpty(execution.roundtripModel, "roundtripModel");
  if (withApplicationRoundtrip !== (roundtripModel !== null)) {
    throw new Error("launch manifest 필드 분석/model binding이 다릅니다.");
  }
  const applicationFieldAnalysisVersion = execution.applicationFieldAnalysisVersion === undefined
    || execution.applicationFieldAnalysisVersion === null
    ? null
    : requireNonEmpty(execution.applicationFieldAnalysisVersion, "applicationFieldAnalysisVersion");
  if (!withApplicationRoundtrip && applicationFieldAnalysisVersion !== null) {
    throw new Error("필드 분석이 꺼진 launch에는 필드 분석 버전을 결속할 수 없습니다.");
  }
  if (execution.transport !== "claude-cli") throw new Error("launch transport는 claude-cli여야 합니다.");
  const sourceKind = normalizeAnalysisLaunchSourceKind(source.kind);
  if (sourceKind !== "independent_review_repair" && targets.some((target) => target.reviewRepair)) {
    throw new Error("독립 검수 repair 외 launch에는 reviewRepair 지시를 결속할 수 없습니다.");
  }
  const existingRunPolicy = normalizeAnalysisLaunchExistingRunPolicy(
    execution.existingRunPolicy,
  );
  const planSha256 = exactSha(String(source.planSha256), "planSha256");
  const planArtifactSha256 = exactSha(String(source.planArtifactSha256), "planArtifactSha256");
  const adoptionManifestSha256 = source.adoptionManifestSha256 === undefined
    || source.adoptionManifestSha256 === null
    ? null
    : exactSha(String(source.adoptionManifestSha256), "adoptionManifestSha256");
  const completedLaunch = source.completedLaunch === undefined
    ? undefined
    : normalizeCompletedCurrentInventoryBinding(source.completedLaunch);
  const terminalRepair = source.terminalRepair === undefined ? undefined
    : normalizeTerminalRepairBinding(source.terminalRepair);
  if (terminalRepair && (
    sourceKind !== "current_inventory"
    || (!completedLaunch && terminalRepair.originalSequences.length !== targets.length)
    || completedLaunch?.schema === "analysis-launch-completed-current-inventory-v1"
  )) {
    throw new Error("terminal repair source 범위가 잘못됐습니다.");
  }
  if (
    completedLaunch?.schema === "analysis-launch-completed-current-inventory-v2"
    && completedLaunch.selectedOriginalSequences.length !== targets.length
  ) {
    throw new Error("completed current inventory 선택 범위가 targets와 다릅니다.");
  }
  if (
    sourceKind !== "independent_review_repair"
      ? targets.some((target) => target.applicationRoundtripReuse)
      : targets.some((target) => (
          target.applicationRoundtripReuse
          && (
            (target.applicationRoundtripReuse.schema === "analysis-launch-application-roundtrip-reuse-v1"
              ? !target.reviewRepair
                || target.applicationRoundtripReuse.sourceLabRunId !== target.reviewRepair.sourceRunId
              : target.reviewRepair !== undefined)
            || target.applicationRoundtripReuse.independentReviewAggregateSha256 !== planSha256
          )
        ))
  ) {
    throw new Error("독립 검수 primary repair 외 launch에는 검증된 failed primary provenance 없이 Kordoc exact 재사용을 결속할 수 없습니다.");
  }
  const reusedRoundtripRunIds = targets.flatMap(
    (target) => target.applicationRoundtripReuse?.sourceRoundtripRunId ?? [],
  );
  if (new Set(reusedRoundtripRunIds).size !== reusedRoundtripRunIds.length) {
    throw new Error("launch Kordoc exact 재사용 runId가 중복됐습니다.");
  }
  const expectedCurrentInventoryRunPolicy = completedLaunch || terminalRepair
    ? "rerun_exact_targets"
    : "skip_existing";
  const expectedApplicationFieldAnalysisVersion = purpose === "completed-current-inventory-source"
    ? "kordoc-application-roundtrip-v14"
    : APPLICATION_ROUNDTRIP_VERSION;
  if (
    purpose === "completed-current-inventory-source"
    && (
      sourceKind !== "current_inventory"
      || completedLaunch !== undefined
      || existingRunPolicy !== "skip_existing"
      || execution.promptVersion !== "lab-deep-v26"
      || execution.validatorVersion !== "deep-analysis-validator-v19"
      || applicationFieldAnalysisVersion !== "kordoc-application-roundtrip-v14"
    )
  ) {
    throw new Error("재봉인 원본은 exact v14/lab-v26/validator-v19 current inventory launch여야 합니다.");
  }
  const liveSourcePolicyRejected = (
    ((sourceKind === "formal_plan" || sourceKind === "current_inventory")
      && (
        adoptionManifestSha256 !== null
        || (sourceKind === "formal_plan"
          ? existingRunPolicy !== "skip_existing" || completedLaunch !== undefined
          : existingRunPolicy !== expectedCurrentInventoryRunPolicy)
        || !withApplicationRoundtrip
        || roundtripModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
        || applicationFieldAnalysisVersion !== expectedApplicationFieldAnalysisVersion
        || (sourceKind === "current_inventory" && planSha256 !== planArtifactSha256)
        || (sourceKind === "current_inventory"
          && completedLaunch !== undefined
          && completedLaunch.inventorySha256 !== planArtifactSha256)
      ))
    || (sourceKind === "authoring_guide_adoption"
      && (
        adoptionManifestSha256 === null
        || adoptionManifestSha256 !== planSha256
        || adoptionManifestSha256 !== planArtifactSha256
        || existingRunPolicy !== "rerun_exact_targets"
        || withApplicationRoundtrip
        || applicationFieldAnalysisVersion !== null
      ))
    || (sourceKind === "independent_review_repair"
      && (
        adoptionManifestSha256 !== null
        || completedLaunch !== undefined
        || planSha256 !== planArtifactSha256
        || existingRunPolicy !== "rerun_exact_targets"
        || !withApplicationRoundtrip
        || roundtripModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
        || applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
      ))
    || (
      sourceKind !== "formal_plan"
      && sourceKind !== "current_inventory"
      && sourceKind !== "authoring_guide_adoption"
      && sourceKind !== "independent_review_repair"
    )
    || (sourceKind !== "current_inventory" && completedLaunch !== undefined)
    || (existingRunPolicy !== "skip_existing" && existingRunPolicy !== "rerun_exact_targets")
  );
  const supportedHistoricalOfflineContract = purpose === "completed-receipt-offline-consumer"
    && isSupportedCompletedReceiptOfflineContract({
      rawSourceKind: source.kind,
      rawAdoptionManifestSha256: source.adoptionManifestSha256,
      rawExistingRunPolicy: execution.existingRunPolicy,
      rawApplicationFieldAnalysisVersion: execution.applicationFieldAnalysisVersion,
      sourceKind,
      existingRunPolicy,
      adoptionManifestSha256,
      completedLaunch,
      terminalRepair,
      planSha256,
      planArtifactSha256,
      transport: execution.transport,
      model: execution.model,
      promptVersion: execution.promptVersion,
      validatorVersion: execution.validatorVersion,
      withApplicationRoundtrip,
      roundtripModel,
    });
  const supportedCurrentOfflineContract = purpose === "completed-receipt-offline-consumer"
    && !liveSourcePolicyRejected
    && execution.model === APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    && execution.promptVersion === ANALYSIS_LAB_PROMPT_VERSION
    && execution.validatorVersion === DEEP_ANALYSIS_VALIDATOR_VERSION
    && (withApplicationRoundtrip
      ? roundtripModel === APPLICATION_ROUNDTRIP_ADOPTED_MODEL
        && applicationFieldAnalysisVersion === APPLICATION_ROUNDTRIP_VERSION
      : roundtripModel === null && applicationFieldAnalysisVersion === null);
  if (
    purpose === "completed-receipt-offline-consumer"
      ? !supportedHistoricalOfflineContract && !supportedCurrentOfflineContract
      : liveSourcePolicyRejected
  ) {
    throw new Error("launch source/existing run 정책 결속이 잘못됐습니다.");
  }
  const preparedAt = exactIso(record.preparedAt, "preparedAt");
  const concurrency = integer(execution.concurrency, "concurrency");
  if (concurrency < 1 || concurrency > 4) throw new Error("launch concurrency는 1~4여야 합니다.");
  return Object.freeze({
    schema: "analysis-launch-manifest-v1",
    preparedAt,
    source: Object.freeze({
      kind: sourceKind,
      seriesId: exactSeries(source.seriesId),
      planSha256,
      planArtifactSha256,
      adoptionManifestSha256,
      ...(completedLaunch ? { completedLaunch } : {}),
      ...(terminalRepair ? { terminalRepair } : {}),
      sequenceFrom,
      sequenceTo,
    }),
    execution: Object.freeze({
      transport: "claude-cli",
      model: requireNonEmpty(execution.model, "model"),
      promptVersion: requireNonEmpty(execution.promptVersion, "promptVersion"),
      validatorVersion: requireNonEmpty(execution.validatorVersion, "validatorVersion"),
      packageRuntimeSha256: exactSha(String(execution.packageRuntimeSha256), "packageRuntimeSha256"),
      gitShaAtPreparation: exactGitSha(execution.gitShaAtPreparation),
      withApplicationRoundtrip,
      roundtripModel,
      applicationFieldAnalysisVersion,
      concurrency,
      existingRunPolicy,
    }),
    targets: Object.freeze(targets),
  });
}

const COMPLETED_RECEIPT_OFFLINE_HISTORICAL_CONTRACTS = new Set([
  // 2026-09-16 신규30/복구5 종료 계약. v20 필드 누락 수정의 live 권한으로 승계하지 않는다.
  "current_inventory|skip_existing|lab-deep-v28|deep-analysis-validator-v23|kordoc-application-roundtrip-v19",
  "current_inventory|rerun_exact_targets|lab-deep-v28|deep-analysis-validator-v23|kordoc-application-roundtrip-v19",
  // exact19 종료 receipt의 v17 계약은 오프라인 재검증에만 보존한다.
  "current_inventory|skip_existing|lab-deep-v28|deep-analysis-validator-v22|kordoc-application-roundtrip-v17",
  // 2026-09-15 terminal repair 6건의 종료 계약. 원 ancestry는 completed reader가 별도로 검증한다.
  "current_inventory|rerun_exact_targets|lab-deep-v28|deep-analysis-validator-v22|kordoc-application-roundtrip-v17",
  "current_inventory|skip_existing|lab-deep-v28|deep-analysis-validator-v21|kordoc-application-roundtrip-v15",
  "formal_plan|skip_existing|lab-deep-v21|deep-analysis-validator-v14|kordoc-application-roundtrip-v9",
  "current_inventory|skip_existing|lab-deep-v22|deep-analysis-validator-v15|kordoc-application-roundtrip-v9",
  "independent_review_repair|rerun_exact_targets|lab-deep-v21|deep-analysis-validator-v14|kordoc-application-roundtrip-v9",
  "<absent>|<absent>|lab-deep-v17|deep-analysis-validator-v10|<absent>",
  "formal_plan|skip_existing|lab-deep-v17|deep-analysis-validator-v10|kordoc-application-roundtrip-v9",
  "current_inventory|skip_existing|lab-deep-v22|deep-analysis-validator-v16|kordoc-application-roundtrip-v11",
  "independent_review_repair|rerun_exact_targets|lab-deep-v18|deep-analysis-validator-v11|kordoc-application-roundtrip-v9",
  "authoring_guide_adoption|rerun_exact_targets|lab-deep-v17|deep-analysis-validator-v10|<absent>",
]);

function normalizeTerminalRepairBinding(value: unknown): AnalysisLaunchTerminalRepairBinding {
  const binding = object(value, "terminalRepair");
  if (binding.schema !== "analysis-launch-terminal-repair-v1"
    || !Array.isArray(binding.receiptSha256s) || binding.receiptSha256s.length < 1
    || !Array.isArray(binding.originalSequences) || binding.originalSequences.length < 1) {
    throw new Error("terminal repair ancestry가 잘못됐습니다.");
  }
  const receiptSha256s = binding.receiptSha256s.map(v => exactSha(String(v), "receiptSha256"));
  const originalSequences = binding.originalSequences.map(v => integer(v, "originalSequence"));
  if (new Set(receiptSha256s).size !== receiptSha256s.length
    || originalSequences.some((v, i) => v < 0 || (i > 0 && v <= originalSequences[i - 1]!))) {
    throw new Error("terminal repair ancestry에 중복 또는 잘못된 sequence가 있습니다.");
  }
  return Object.freeze({ schema: "analysis-launch-terminal-repair-v1",
    sourceManifestSha256: exactSha(String(binding.sourceManifestSha256), "sourceManifestSha256"),
    sourceGrantSha256: exactSha(String(binding.sourceGrantSha256), "sourceGrantSha256"),
    receiptSha256s: Object.freeze(receiptSha256s), originalSequences: Object.freeze(originalSequences) });
}

/** 실측된 종료 manifest 계약만 보존한다. live grant/run admission에는 사용하지 않는다. */
function isSupportedCompletedReceiptOfflineContract(input: {
  readonly rawSourceKind: unknown;
  readonly rawAdoptionManifestSha256: unknown;
  readonly rawExistingRunPolicy: unknown;
  readonly rawApplicationFieldAnalysisVersion: unknown;
  readonly sourceKind: unknown;
  readonly existingRunPolicy: unknown;
  readonly adoptionManifestSha256: string | null;
  readonly completedLaunch: AnalysisLaunchCompletedCurrentInventoryBinding | undefined;
  readonly terminalRepair: AnalysisLaunchTerminalRepairBinding | undefined;
  readonly planSha256: string;
  readonly planArtifactSha256: string;
  readonly transport: unknown;
  readonly model: unknown;
  readonly promptVersion: unknown;
  readonly validatorVersion: unknown;
  readonly withApplicationRoundtrip: boolean;
  readonly roundtripModel: string | null;
}): boolean {
  if (
    input.transport !== "claude-cli"
    || input.model !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || input.completedLaunch !== undefined
  ) return false;
  if (
    input.terminalRepair !== undefined
    && (
      input.sourceKind !== "current_inventory"
      || input.existingRunPolicy !== "rerun_exact_targets"
    )
  ) return false;
  if (
    input.sourceKind === "current_inventory"
    && input.existingRunPolicy === "rerun_exact_targets"
    && input.terminalRepair === undefined
  ) return false;
  const authoringGuidePrimaryOnly = input.sourceKind === "authoring_guide_adoption"
    && input.adoptionManifestSha256 !== null
    && input.adoptionManifestSha256 === input.planSha256
    && input.planSha256 === input.planArtifactSha256
    && !input.withApplicationRoundtrip
    && input.roundtripModel === null;
  const applicationRoundtripLaunch = input.sourceKind !== "authoring_guide_adoption"
    && input.adoptionManifestSha256 === null
    && input.withApplicationRoundtrip
    && input.roundtripModel === APPLICATION_ROUNDTRIP_ADOPTED_MODEL;
  if (!authoringGuidePrimaryOnly && !applicationRoundtripLaunch) return false;
  if (
    (input.rawSourceKind === undefined && input.rawAdoptionManifestSha256 !== undefined)
    || (input.rawSourceKind !== undefined
      && input.rawSourceKind !== "authoring_guide_adoption"
      && input.rawAdoptionManifestSha256 !== null)
  ) return false;
  if (
    (input.sourceKind === "current_inventory" || input.sourceKind === "independent_review_repair")
    && input.planSha256 !== input.planArtifactSha256
  ) return false;
  const field = (value: unknown) => value === undefined ? "<absent>" : String(value);
  return COMPLETED_RECEIPT_OFFLINE_HISTORICAL_CONTRACTS.has([
    field(input.rawSourceKind),
    field(input.rawExistingRunPolicy),
    field(input.promptVersion),
    field(input.validatorVersion),
    field(input.rawApplicationFieldAnalysisVersion),
  ].join("|"));
}

function normalizeAnalysisLaunchSourceKind(
  value: unknown,
): AnalysisLaunchManifest["source"]["kind"] {
  if (value === undefined) return "formal_plan";
  if (
    value !== "formal_plan"
    && value !== "current_inventory"
    && value !== "authoring_guide_adoption"
    && value !== "independent_review_repair"
  ) {
    throw new Error("launch source/existing run 정책 결속이 잘못됐습니다.");
  }
  return value;
}

function normalizeAnalysisLaunchExistingRunPolicy(
  value: unknown,
): AnalysisLaunchManifest["execution"]["existingRunPolicy"] {
  if (value === undefined) return "skip_existing";
  if (value !== "skip_existing" && value !== "rerun_exact_targets") {
    throw new Error("launch source/existing run 정책 결속이 잘못됐습니다.");
  }
  return value;
}

function normalizeCompletedCurrentInventoryBinding(
  value: unknown,
): AnalysisLaunchCompletedCurrentInventoryBinding {
  const binding = object(value, "manifest.source.completedLaunch");
  if (
    binding.schema !== "analysis-launch-completed-current-inventory-v1"
    && binding.schema !== "analysis-launch-completed-current-inventory-v2"
  ) {
    throw new Error("completed current inventory launch schema가 다릅니다.");
  }
  const common = {
    inventorySha256: exactSha(String(binding.inventorySha256), "completedLaunch.inventorySha256"),
    sourceManifestSha256: exactSha(
      String(binding.sourceManifestSha256),
      "completedLaunch.sourceManifestSha256",
    ),
    sourceGrantSha256: exactSha(
      String(binding.sourceGrantSha256),
      "completedLaunch.sourceGrantSha256",
    ),
    terminalReceiptSha256: exactSha(
      String(binding.terminalReceiptSha256),
      "completedLaunch.terminalReceiptSha256",
    ),
  };
  if (binding.schema === "analysis-launch-completed-current-inventory-v1") {
    if (binding.selectedOriginalSequences !== undefined) {
      throw new Error("completed current inventory v1에는 선택 sequence를 결속할 수 없습니다.");
    }
    return Object.freeze({
      schema: "analysis-launch-completed-current-inventory-v1",
      ...common,
    });
  }
  if (!Array.isArray(binding.selectedOriginalSequences) || binding.selectedOriginalSequences.length < 1) {
    throw new Error("completed current inventory v2 선택 sequence가 없습니다.");
  }
  const selectedOriginalSequences = binding.selectedOriginalSequences.map(
    (value, index) => integer(value, `selectedOriginalSequences[${index}]`),
  );
  if (
    selectedOriginalSequences.some((sequence) => sequence < 0)
    || new Set(selectedOriginalSequences).size !== selectedOriginalSequences.length
  ) {
    throw new Error("completed current inventory v2 선택 sequence가 잘못됐거나 중복됐습니다.");
  }
  return Object.freeze({
    schema: "analysis-launch-completed-current-inventory-v2",
    ...common,
    selectedOriginalSequences: Object.freeze(selectedOriginalSequences),
  });
}

export function normalizeAnalysisLaunchGrant(value: unknown): AnalysisLaunchGrant {
  const record = object(value, "grant");
  if (
    record.schema !== "analysis-launch-grant-v1"
    || record.scope !== "launch-batch-live"
    || record.stopAfter !== "manifest-terminal"
  ) {
    throw new Error("launch grant 계약이 다릅니다.");
  }
  const targetCount = integer(record.targetCount, "targetCount");
  if (targetCount < 1 || targetCount > MAX_LAUNCH_TARGETS) throw new Error("launch grant targetCount가 잘못됐습니다.");
  return Object.freeze({
    schema: "analysis-launch-grant-v1",
    manifestSha256: exactSha(String(record.manifestSha256), "manifestSha256"),
    approvedBy: requireNonEmpty(record.approvedBy, "approvedBy"),
    approvedAt: exactIso(record.approvedAt, "approvedAt"),
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount,
  });
}

export function normalizeAnalysisLaunchReceipt(value: unknown): AnalysisLaunchReceipt {
  const record = object(value, "receipt");
  if (record.schema !== "analysis-launch-receipt-v1" || record.lifecycle !== "finished") {
    throw new Error("launch receipt 계약이 다릅니다.");
  }
  if (!Array.isArray(record.targets) || record.targets.length < 1 || record.targets.length > MAX_LAUNCH_TARGETS) {
    throw new Error("launch receipt targets 수가 잘못됐습니다.");
  }
  const targets = record.targets.map((raw, index): AnalysisLaunchReceiptTarget => {
    const target = object(raw, `receipt.targets[${index}]`);
    const status = target.status;
    if (status !== "publishable" && status !== "held" && status !== "failed" && status !== "skipped") {
      throw new Error(`receipt.targets[${index}].status가 잘못됐습니다.`);
    }
    const runArtifactPath = target.runArtifactPath === null
      ? null
      : requireNonEmpty(target.runArtifactPath, `receipt.targets[${index}].runArtifactPath`);
    const runArtifactSha256 = target.runArtifactSha256 === null
      ? null
      : exactSha(String(target.runArtifactSha256), `receipt.targets[${index}].runArtifactSha256`);
    if ((runArtifactPath === null) !== (runArtifactSha256 === null)) {
      throw new Error(`receipt.targets[${index}] run artifact 결속이 잘못됐습니다.`);
    }
    const applicationRoundtripStatus = target.applicationRoundtripStatus === null
      ? null
      : requireNonEmpty(
        target.applicationRoundtripStatus,
        `receipt.targets[${index}].applicationRoundtripStatus`,
      );
    const applicationDocumentCount = nullableNonNegativeInteger(
      target.applicationDocumentCount,
      `receipt.targets[${index}].applicationDocumentCount`,
    );
    const fieldReadyDocumentCount = nullableNonNegativeInteger(
      target.fieldReadyDocumentCount,
      `receipt.targets[${index}].fieldReadyDocumentCount`,
    );
    const recognizedFieldCount = nullableNonNegativeInteger(
      target.recognizedFieldCount,
      `receipt.targets[${index}].recognizedFieldCount`,
    );
    if (
      fieldReadyDocumentCount !== null
      && applicationDocumentCount !== null
      && fieldReadyDocumentCount > applicationDocumentCount
    ) {
      throw new Error(`receipt.targets[${index}] 필드 준비 문서 수가 신청 문서 수보다 큽니다.`);
    }
    const error = target.error === null
      ? null
      : requireNonEmpty(target.error, `receipt.targets[${index}].error`);
    const primaryMatchingProjection = target.primaryMatchingProjection === undefined
      ? undefined
      : normalizeAnalysisLaunchMatchingProjectionBinding(
          target.primaryMatchingProjection,
          `receipt.targets[${index}].primaryMatchingProjection`,
        );
    const featureReadiness = target.featureReadiness === undefined
      ? undefined
      : normalizeAnalysisFeatureReadiness(target.featureReadiness);
    if (primaryMatchingProjection && runArtifactPath === null) {
      throw new Error(`receipt.targets[${index}] matching projection에 run artifact가 없습니다.`);
    }
    if (
      featureReadiness?.matching.status === "ready"
      && status !== "publishable"
      && status !== "held"
    ) {
      throw new Error(`receipt.targets[${index}] 실패 결과가 matching ready를 주장합니다.`);
    }
    if (
      status === "skipped"
      && (
        runArtifactPath !== null
        || applicationRoundtripStatus !== null
        || applicationDocumentCount !== null
        || fieldReadyDocumentCount !== null
        || recognizedFieldCount !== null
        || featureReadiness !== undefined
        || error !== null
      )
    ) {
      throw new Error(`receipt.targets[${index}] skipped 결과가 산출물을 참조합니다.`);
    }
    return Object.freeze({
      sequence: integer(target.sequence, `receipt.targets[${index}].sequence`),
      grantId: exactUuid(target.grantId, `receipt.targets[${index}].grantId`),
      status,
      runArtifactPath,
      runArtifactSha256,
      applicationRoundtripStatus,
      applicationDocumentCount,
      fieldReadyDocumentCount,
      recognizedFieldCount,
      ...(featureReadiness ? { featureReadiness } : {}),
      ...(primaryMatchingProjection ? { primaryMatchingProjection } : {}),
      error,
    });
  });
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length) {
    throw new Error("launch receipt grantId가 중복됐습니다.");
  }
  const summary = object(record.summary, "receipt.summary");
  const normalizedSummary = Object.freeze({
    publishable: integer(summary.publishable, "receipt.summary.publishable"),
    held: integer(summary.held, "receipt.summary.held"),
    failed: integer(summary.failed, "receipt.summary.failed"),
    skipped: integer(summary.skipped, "receipt.summary.skipped"),
  });
  for (const [status, count] of Object.entries(normalizedSummary)) {
    if (count < 0 || targets.filter((target) => target.status === status).length !== count) {
      throw new Error(`launch receipt summary.${status}가 targets와 다릅니다.`);
    }
  }
  const stopReason = record.stopReason;
  if (
    stopReason !== "completed"
    && stopReason !== "window-exhausted"
    && stopReason !== "aborted"
    && stopReason !== "systemic-failure"
  ) {
    throw new Error("launch receipt stopReason이 잘못됐습니다.");
  }
  const startedAt = exactIso(record.startedAt, "receipt.startedAt");
  const finishedAt = exactIso(record.finishedAt, "receipt.finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error("launch receipt finishedAt이 startedAt보다 빠릅니다.");
  }
  return Object.freeze({
    schema: "analysis-launch-receipt-v1",
    grantSha256: exactSha(String(record.grantSha256), "receipt.grantSha256"),
    manifestSha256: exactSha(String(record.manifestSha256), "receipt.manifestSha256"),
    startedAt,
    finishedAt,
    lifecycle: "finished",
    stopReason,
    systemicFailure: record.systemicFailure === null
      ? null
      : requireNonEmpty(record.systemicFailure, "receipt.systemicFailure"),
    summary: normalizedSummary,
    targets: Object.freeze(targets),
  });
}

function normalizeAnalysisLaunchMatchingProjectionBinding(
  value: unknown,
  location: string,
): AnalysisLaunchMatchingProjectionBinding {
  const binding = object(value, location);
  if (binding.schema !== "analysis-launch-primary-matching-projection-binding-v1") {
    throw new Error(`${location}.schema가 잘못됐습니다.`);
  }
  if (binding.verification !== "verified" && binding.verification !== "failed") {
    throw new Error(`${location}.verification이 잘못됐습니다.`);
  }
  return Object.freeze({
    schema: "analysis-launch-primary-matching-projection-binding-v1",
    verification: binding.verification,
    snapshotSha256: exactSha(String(binding.snapshotSha256), `${location}.snapshotSha256`),
    sourceCriteriaSha256: exactSha(String(binding.sourceCriteriaSha256), `${location}.sourceCriteriaSha256`),
    projectedCriteriaSha256: exactSha(
      String(binding.projectedCriteriaSha256),
      `${location}.projectedCriteriaSha256`,
    ),
    reportSha256: exactSha(String(binding.reportSha256), `${location}.reportSha256`),
    conversionContractVersion: requireNonEmpty(
      binding.conversionContractVersion,
      `${location}.conversionContractVersion`,
    ),
    converterVersion: requireNonEmpty(binding.converterVersion, `${location}.converterVersion`),
    normalizerContractVersion: requireNonEmpty(
      binding.normalizerContractVersion,
      `${location}.normalizerContractVersion`,
    ),
    matcherRulesetVersion: requireNonEmpty(
      binding.matcherRulesetVersion,
      `${location}.matcherRulesetVersion`,
    ),
  });
}

export function assertAnalysisLaunchExecutionContract(input: {
  readonly manifest: AnalysisLaunchManifest;
  readonly current: {
    readonly packageRuntimeSha256: string;
    readonly validatorVersion: string;
    readonly gitSha: string;
  };
}): { readonly gitChangedSincePreparation: boolean } {
  if (
    input.current.packageRuntimeSha256 !== input.manifest.execution.packageRuntimeSha256
    || input.current.validatorVersion !== input.manifest.execution.validatorVersion
    || input.manifest.execution.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
    || input.manifest.execution.validatorVersion !== DEEP_ANALYSIS_VALIDATOR_VERSION
    || (
      input.manifest.source.kind !== "authoring_guide_adoption"
      && input.manifest.execution.applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
    )
  ) {
    throw new Error("launch material execution contract가 준비 시점과 달라졌습니다.");
  }
  return Object.freeze({
    gitChangedSincePreparation:
      input.current.gitSha !== input.manifest.execution.gitShaAtPreparation,
  });
}

export async function readCurrentSeriesPlanInventory(
  seriesId: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<AnalysisLaunchPlanInventory> {
  const normalizedSeries = exactSeries(seriesId);
  const markerPath = join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "experiments",
    "series",
    `${normalizedSeries}.json`,
  );
  const markerBytes = await readFile(markerPath);
  const marker = object(JSON.parse(markerBytes.toString("utf8")), "series marker");
  if (marker.seriesId !== normalizedSeries || marker.schema !== "deep-repair-series-proposal-v1") {
    throw new Error("series marker binding이 다릅니다.");
  }
  const planSha256 = exactSha(String(marker.planSha256), "planSha256");
  const planArtifactSha256 = exactSha(String(marker.planArtifactSha256), "planArtifactSha256");
  const planPath = join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "experiments",
    "plans",
    `${planSha256}.json`,
  );
  const planBytes = await readFile(planPath);
  if (sha256Bytes(planBytes) !== planArtifactSha256) throw new Error("series plan raw SHA가 marker와 다릅니다.");
  const plan = object(JSON.parse(planBytes.toString("utf8")), "plan");
  const manifest = object(plan.manifest, "plan.manifest");
  const policy = object(manifest.policy, "plan.manifest.policy");
  if (
    plan.schema !== "deep-repair-experiment-plan-v1"
    || plan.planSha256 !== planSha256
    || manifest.seriesId !== normalizedSeries
    || policy.transport !== "claude-cli"
    || policy.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
    || !Array.isArray(plan.sequence)
  ) {
    throw new Error("series plan 계약이 launch inventory와 호환되지 않습니다.");
  }
  return normalizeInventory({
    seriesId: normalizedSeries,
    planSha256,
    planArtifactSha256,
    model: requireNonEmpty(policy.model, "plan model"),
    targets: plan.sequence.map((raw, index) => {
      const target = object(raw, `plan.sequence[${index}]`);
      return {
        sequence: target.sequence,
        grantId: target.grantId,
        stratum: target.stratum,
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256,
      } as AnalysisLaunchPlanTarget;
    }),
  });
}

export function analysisLaunchArtifactPath(
  kind: "manifests" | "grants" | "receipts",
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "launch",
    kind,
    `${exactSha(sha256, `${kind} sha256`)}.json`,
  );
}

export async function writeAnalysisLaunchArtifact(
  kind: "manifests" | "grants" | "receipts",
  value: AnalysisLaunchManifest | AnalysisLaunchGrant | AnalysisLaunchReceipt,
  repositoryRoot = findMonorepoRoot(),
): Promise<{ readonly sha256: string; readonly path: string }> {
  const bytes = encodeCanonical(value);
  const sha256 = sha256Bytes(bytes);
  const path = analysisLaunchArtifactPath(kind, sha256, repositoryRoot);
  await writeImmutableBytesAtomic(path, bytes);
  return Object.freeze({ sha256, path });
}

export async function readAnalysisLaunchArtifact(
  kind: "manifests" | "grants" | "receipts",
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<unknown> {
  const bytes = await readFile(analysisLaunchArtifactPath(kind, sha256, repositoryRoot));
  if (sha256Bytes(bytes) !== sha256) throw new Error(`launch ${kind} artifact SHA가 ID와 다릅니다.`);
  const value = JSON.parse(bytes.toString("utf8"));
  if (Buffer.compare(bytes, encodeCanonical(value)) !== 0) {
    throw new Error(`launch ${kind} artifact가 canonical JSON이 아닙니다.`);
  }
  return value;
}

export function encodeCanonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function normalizeInventory(value: AnalysisLaunchPlanInventory): AnalysisLaunchPlanInventory {
  if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > MAX_LAUNCH_TARGETS) {
    throw new Error("launch inventory target 수가 잘못됐습니다.");
  }
  const targets = value.targets.map((target, index): AnalysisLaunchPlanTarget => {
    const sequence = integer(target.sequence, `inventory.targets[${index}].sequence`);
    if (sequence !== index) throw new Error("launch inventory sequence가 0부터 연속적이지 않습니다.");
    return Object.freeze({
      sequence,
      grantId: exactUuid(target.grantId, "grantId"),
      stratum: requireNonEmpty(target.stratum, "stratum"),
      inputSha256: exactSha(target.inputSha256, "inputSha256"),
      attachmentManifestSha256: exactSha(
        target.attachmentManifestSha256,
        "attachmentManifestSha256",
      ),
    });
  });
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length) {
    throw new Error("launch inventory grantId가 중복됐습니다.");
  }
  return Object.freeze({
    seriesId: exactSeries(value.seriesId),
    planSha256: exactSha(value.planSha256, "planSha256"),
    planArtifactSha256: exactSha(value.planArtifactSha256, "planArtifactSha256"),
    model: requireNonEmpty(value.model, "model"),
    targets: Object.freeze(targets),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON에 유한하지 않은 숫자가 있습니다.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON으로 직렬화할 수 없습니다: ${typeof value}`);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field}는 object여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function exactSha(value: string, field: string): string {
  if (!SHA256.test(value)) throw new Error(`${field}는 SHA-256이어야 합니다.`);
  return value;
}

function exactUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${field}는 UUID여야 합니다.`);
  return value;
}

function exactSeries(value: unknown): string {
  if (typeof value !== "string" || !SERIES.test(value)) throw new Error("seriesId 형식이 잘못됐습니다.");
  return value;
}

function exactGitSha(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error("gitShaAtPreparation 형식이 잘못됐습니다.");
  }
  return value;
}

function exactIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field}는 ISO timestamp여야 합니다.`);
  }
  return new Date(value).toISOString();
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field}는 정수여야 합니다.`);
  return value;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const normalized = integer(value, field);
  if (normalized < 0) throw new Error(`${field}는 0 이상이어야 합니다.`);
  return normalized;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}는 비어 있을 수 없습니다.`);
  return value;
}

function normalizeLaunchReviewRepair(
  value: unknown,
  field: string,
): NonNullable<AnalysisLaunchManifestTarget["reviewRepair"]> {
  const record = object(value, field);
  const blockingCount = integer(record.blockingCount, `${field}.blockingCount`);
  if (blockingCount < 1) throw new Error(`${field}.blockingCount는 1 이상이어야 합니다.`);
  return Object.freeze({
    sourceRunId: requireNonEmpty(record.sourceRunId, `${field}.sourceRunId`),
    reviewModel: requireNonEmpty(record.reviewModel, `${field}.reviewModel`),
    blockingCount,
    taskInstruction: requireNonEmpty(record.taskInstruction, `${field}.taskInstruction`),
  });
}

export function normalizeAnalysisLaunchApplicationRoundtripReuseBinding(
  value: unknown,
  field: string,
): AnalysisLaunchApplicationRoundtripReuseBinding {
  const record = object(value, field);
  if (
    record.schema !== "analysis-launch-application-roundtrip-reuse-v1"
    && record.schema !== "analysis-launch-application-roundtrip-reuse-v2"
  ) {
    throw new Error(`${field}.schema가 잘못됐습니다.`);
  }
  if (!Array.isArray(record.parsedMarkdown)) {
    throw new Error(`${field}.parsedMarkdown가 배열이 아닙니다.`);
  }
  const parsedMarkdown = record.parsedMarkdown.map((value, index) => {
    const entry = object(value, `${field}.parsedMarkdown[${index}]`);
    return Object.freeze({
      attachmentId: requireNonEmpty(entry.attachmentId, `${field}.parsedMarkdown[${index}].attachmentId`),
      sha256: exactSha(String(entry.sha256), `${field}.parsedMarkdown[${index}].sha256`),
    });
  });
  if (
    new Set(parsedMarkdown.map((entry) => entry.attachmentId)).size !== parsedMarkdown.length
    || parsedMarkdown.some((entry, index) => (
      index > 0 && entry.attachmentId <= parsedMarkdown[index - 1]!.attachmentId
    ))
  ) {
    throw new Error(`${field}.parsedMarkdown는 중복 없이 attachmentId 오름차순이어야 합니다.`);
  }
  const sourceSequence = integer(record.sourceSequence, `${field}.sourceSequence`);
  if (sourceSequence < 0) throw new Error(`${field}.sourceSequence는 0 이상이어야 합니다.`);
  const common = {
    sourceSequence,
    sourceLabRunId: requireNonEmpty(record.sourceLabRunId, `${field}.sourceLabRunId`),
    sourceLabRunArtifactPath: repositoryRelativePath(
      record.sourceLabRunArtifactPath,
      `${field}.sourceLabRunArtifactPath`,
    ),
    sourceLabRunArtifactSha256: exactSha(
      String(record.sourceLabRunArtifactSha256),
      `${field}.sourceLabRunArtifactSha256`,
    ),
    sourceRoundtripRunId: exactRoundtripRunId(
      record.sourceRoundtripRunId,
      `${field}.sourceRoundtripRunId`,
    ),
    analysisArtifactSha256: exactSha(
      String(record.analysisArtifactSha256),
      `${field}.analysisArtifactSha256`,
    ),
    manifestArtifactSha256: exactSha(
      String(record.manifestArtifactSha256),
      `${field}.manifestArtifactSha256`,
    ),
    parsedMarkdown: Object.freeze(parsedMarkdown),
    independentReviewAggregatePath: repositoryRelativePath(
      record.independentReviewAggregatePath,
      `${field}.independentReviewAggregatePath`,
    ),
    independentReviewAggregateSha256: exactSha(
      String(record.independentReviewAggregateSha256),
      `${field}.independentReviewAggregateSha256`,
    ),
    independentReviewManifestPath: repositoryRelativePath(
      record.independentReviewManifestPath,
      `${field}.independentReviewManifestPath`,
    ),
    independentReviewManifestSha256: exactSha(
      String(record.independentReviewManifestSha256),
      `${field}.independentReviewManifestSha256`,
    ),
    sourceLaunchReceiptSha256: exactSha(
      String(record.sourceLaunchReceiptSha256),
      `${field}.sourceLaunchReceiptSha256`,
    ),
  } as const;
  if (record.schema === "analysis-launch-application-roundtrip-reuse-v1") {
    return Object.freeze({
      schema: "analysis-launch-application-roundtrip-reuse-v1",
      ...common,
    });
  }
  if (record.sourceDisposition !== "failed_primary_valid_application") {
    throw new Error(`${field}.sourceDisposition이 failed primary 재사용 계약과 다릅니다.`);
  }
  return Object.freeze({
    schema: "analysis-launch-application-roundtrip-reuse-v2",
    ...common,
    sourceDisposition: "failed_primary_valid_application",
    applicationFieldRuntimeSha256: exactSha(
      String(record.applicationFieldRuntimeSha256),
      `${field}.applicationFieldRuntimeSha256`,
    ),
  });
}

function repositoryRelativePath(value: unknown, field: string): string {
  const path = requireNonEmpty(value, field);
  if (
    path.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${field}는 저장소 상대경로여야 합니다.`);
  }
  return path;
}

function exactRoundtripRunId(value: unknown, field: string): string {
  const runId = requireNonEmpty(value, field);
  if (!ROUNDTRIP_RUN_ID.test(runId)) throw new Error(`${field} 형식이 잘못됐습니다.`);
  return runId;
}

function exactString(value: string, field: string): string {
  return requireNonEmpty(value, field);
}
