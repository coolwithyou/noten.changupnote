import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/lib/server/analysis-lab/lab-contract";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import type { AuthoringGuideAdoptionManifest } from "./authoring-guide-adoption";
import { DEEP_REPAIR_PREPARATION_POLICY } from "./deep-repair-preparation";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/;
const SERIES = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
}

export interface AnalysisLaunchManifest {
  readonly schema: "analysis-launch-manifest-v1";
  readonly preparedAt: string;
  readonly source: {
    readonly kind: "formal_plan" | "authoring_guide_adoption" | "independent_review_repair";
    readonly seriesId: string;
    readonly planSha256: string;
    readonly planArtifactSha256: string;
    readonly adoptionManifestSha256: string | null;
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
  readonly error: string | null;
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

export function normalizeAnalysisLaunchManifest(value: unknown): AnalysisLaunchManifest {
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
  const sourceKind = source.kind === undefined ? "formal_plan" : source.kind;
  if (sourceKind !== "independent_review_repair" && targets.some((target) => target.reviewRepair)) {
    throw new Error("독립 검수 repair 외 launch에는 reviewRepair 지시를 결속할 수 없습니다.");
  }
  const existingRunPolicy = execution.existingRunPolicy === undefined
    ? "skip_existing"
    : execution.existingRunPolicy;
  const planSha256 = exactSha(String(source.planSha256), "planSha256");
  const planArtifactSha256 = exactSha(String(source.planArtifactSha256), "planArtifactSha256");
  const adoptionManifestSha256 = source.adoptionManifestSha256 === undefined
    || source.adoptionManifestSha256 === null
    ? null
    : exactSha(String(source.adoptionManifestSha256), "adoptionManifestSha256");
  if (
    (sourceKind === "formal_plan"
      && (
        adoptionManifestSha256 !== null
        || existingRunPolicy !== "skip_existing"
        || !withApplicationRoundtrip
        || roundtripModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
        || applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
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
        || planSha256 !== planArtifactSha256
        || existingRunPolicy !== "rerun_exact_targets"
        || !withApplicationRoundtrip
        || roundtripModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
        || applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
      ))
    || (
      sourceKind !== "formal_plan"
      && sourceKind !== "authoring_guide_adoption"
      && sourceKind !== "independent_review_repair"
    )
    || (existingRunPolicy !== "skip_existing" && existingRunPolicy !== "rerun_exact_targets")
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
    if (
      status === "skipped"
      && (
        runArtifactPath !== null
        || applicationRoundtripStatus !== null
        || applicationDocumentCount !== null
        || fieldReadyDocumentCount !== null
        || recognizedFieldCount !== null
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

function exactString(value: string, field: string): string {
  return requireNonEmpty(value, field);
}
