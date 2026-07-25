import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  DEEP_ANALYSIS_PROMPT_VERSION,
  type DeepAnalysisAuditModel,
  type DeepAnalysisPrimaryModel,
} from "@cunote/contracts";
import { DEEP_ANALYSIS_SINGLE_PROMPT_CHARS } from "./analyzer";
import { DEEP_ANALYSIS_AUDIT_PROMPT_VERSION } from "./audit";
import { DEEP_ANALYSIS_AUDIT_ADJUDICATION_VERSION } from "./auditAdjudication";
import type {
  DeepAnalysisQualityCohortEntry,
  DeepAnalysisQualityPublicManifest,
  DeepAnalysisQualitySecretManifest,
} from "./qualityCohort";
import { DEEP_ANALYSIS_REPAIR_VERSION } from "./repair";
import { sha256Hex, stableJson } from "./sourceRevision";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "./validator";

export const DEEP_ANALYSIS_QUALITY_PREFLIGHT_VERSION =
  "deep-analysis-quality-preflight-v1" as const;

export type DeepAnalysisQualityPreflightBlockerCode =
  | "frozen_grant_missing"
  | "frozen_identity_mismatch"
  | "frozen_canonical_id_mismatch"
  | "frozen_raw_payload_changed"
  | "frozen_attachment_summary_changed"
  | "frozen_selector_revision_changed"
  | "production_input_not_sealed"
  | "preflight_error";

export interface DeepAnalysisQualityPreflightObservation {
  source: DeepAnalysisQualityCohortEntry["source"];
  sourceId: string;
  canonicalId: string;
  opaqueCommitmentSha256: string;
  split: DeepAnalysisQualityCohortEntry["split"];
  frozenSnapshotMatched: boolean;
  observedSelectorRevisionSha256: string | null;
  productionSourceRevisionSha256: string | null;
  attachmentManifestSha256: string | null;
  inputSha256: string | null;
  currentInputSealed: boolean;
  totalChars: number;
  evidenceChars: number;
  attachmentCount: number;
  includedAttachmentCount: number;
  chunkCount: number;
  dispositionCounts: Record<string, number>;
  blockerCodes: DeepAnalysisQualityPreflightBlockerCode[];
  productionBlockerCodes: string[];
}

export function planDeepAnalysisQualityLogicalCalls(input: {
  readyForExecution: boolean;
  evidenceChars: number;
  chunkCount: number;
}) {
  if (!input.readyForExecution) {
    return {
      basePassesPerAnalysis: 0,
      mandatoryLogicalModelCalls: 0,
      maxLogicalModelCalls: 0,
      maxHttpAttemptsWithOneRetryPerCall: 0,
    };
  }
  if (input.evidenceChars < 1 || input.chunkCount < 1) {
    throw new Error("Ready quality preflight input must contain evidence chunks.");
  }
  const basePassesPerAnalysis = (
    input.evidenceChars <= DEEP_ANALYSIS_SINGLE_PROMPT_CHARS
    || input.chunkCount <= 1
  ) ? 1 : input.chunkCount + 1;
  const mandatoryLogicalModelCalls = basePassesPerAnalysis * 2;
  // primary/audit repair 각 2회와 disagreement adjudication 1회까지 보수 계산한다.
  const maxLogicalModelCalls = mandatoryLogicalModelCalls + 5;
  return {
    basePassesPerAnalysis,
    mandatoryLogicalModelCalls,
    maxLogicalModelCalls,
    maxHttpAttemptsWithOneRetryPerCall: maxLogicalModelCalls * 2,
  };
}

export function buildDeepAnalysisQualityPreflightReceipt(input: {
  generatedAt: string;
  frozenPublicManifest: DeepAnalysisQualityPublicManifest;
  frozenSecretManifest: DeepAnalysisQualitySecretManifest;
  primaryModel: DeepAnalysisPrimaryModel;
  auditModel: DeepAnalysisAuditModel;
  maxTotalInputChars?: number;
  perNoticeCostCapUsd?: number;
  dailyCostCapUsd?: number;
  observations: DeepAnalysisQualityPreflightObservation[];
}) {
  if (Number.isNaN(Date.parse(input.generatedAt))) {
    throw new Error("Deep analysis quality preflight generatedAt must be ISO-8601.");
  }
  const frozenByCommitment = new Map(
    input.frozenSecretManifest.selected.map((entry) => [
      entry.opaqueCommitmentSha256,
      entry,
    ]),
  );
  if (frozenByCommitment.size !== 80 || input.observations.length !== 80) {
    throw new Error("Deep analysis quality preflight requires exactly 80 frozen items.");
  }
  const seen = new Set<string>();
  const items = input.observations.map((observation) => {
    const frozen = frozenByCommitment.get(observation.opaqueCommitmentSha256);
    if (!frozen || seen.has(observation.opaqueCommitmentSha256)) {
      throw new Error("Deep analysis quality preflight item set is invalid.");
    }
    seen.add(observation.opaqueCommitmentSha256);
    if (
      observation.source !== frozen.source
      || observation.sourceId !== frozen.sourceId
      || observation.canonicalId !== frozen.canonicalId
      || observation.split !== frozen.split
    ) {
      throw new Error("Deep analysis quality preflight frozen identity mismatch.");
    }
    const blockerCodes = unique(observation.blockerCodes);
    const productionBlockerCodes = unique(observation.productionBlockerCodes);
    const readyForExecution = observation.frozenSnapshotMatched
      && observation.currentInputSealed
      && blockerCodes.length === 0
      && productionBlockerCodes.length === 0
      && observation.productionSourceRevisionSha256 !== null
      && observation.attachmentManifestSha256 !== null
      && observation.inputSha256 !== null;
    return {
      source: observation.source,
      split: observation.split,
      opaqueCommitmentSha256: observation.opaqueCommitmentSha256,
      frozenSnapshotMatched: observation.frozenSnapshotMatched,
      currentInputSealed: observation.currentInputSealed,
      readyForExecution,
      blockerCodes,
      productionBlockerCodes,
      totalChars: observation.totalChars,
      evidenceChars: observation.evidenceChars,
      attachmentCount: observation.attachmentCount,
      includedAttachmentCount: observation.includedAttachmentCount,
      chunkCount: observation.chunkCount,
      productionBindingSha256: sha256Canonical({
        schema: "deep-analysis-quality-production-binding-v1",
        opaqueCommitmentSha256: observation.opaqueCommitmentSha256,
        frozenSelectorRevisionSha256: frozen.sourceRevisionSha256,
        observedSelectorRevisionSha256: observation.observedSelectorRevisionSha256,
        productionSourceRevisionSha256: observation.productionSourceRevisionSha256,
        attachmentManifestSha256: observation.attachmentManifestSha256,
        inputSha256: observation.inputSha256,
      }),
      callPlan: planDeepAnalysisQualityLogicalCalls({
        readyForExecution,
        evidenceChars: observation.evidenceChars,
        chunkCount: observation.chunkCount,
      }),
    };
  }).sort((left, right) =>
    left.opaqueCommitmentSha256.localeCompare(right.opaqueCommitmentSha256));
  const summary = summarize(items, input.observations);
  const perNoticeCostCapUsd = input.perNoticeCostCapUsd
    ?? DEEP_ANALYSIS_DEFAULT_LIMITS.perNoticeCostCapUsd;
  const payload = {
    recordType: "deep_analysis_quality_preflight" as const,
    schemaVersion: 1 as const,
    preflightVersion: DEEP_ANALYSIS_QUALITY_PREFLIGHT_VERSION,
    generatedAt: input.generatedAt,
    frozenPublicManifestSha256: input.frozenPublicManifest.manifestSha256,
    frozenSecretManifestSha256: input.frozenSecretManifest.manifestSha256,
    selectionCommitmentSha256: input.frozenPublicManifest.selectionCommitmentSha256,
    policy: {
      modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
      primaryModel: input.primaryModel,
      auditModel: input.auditModel,
      primaryPromptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
      auditPromptVersion: DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      repairVersion: DEEP_ANALYSIS_REPAIR_VERSION,
      auditAdjudicationVersion: DEEP_ANALYSIS_AUDIT_ADJUDICATION_VERSION,
      singlePromptChars: DEEP_ANALYSIS_SINGLE_PROMPT_CHARS,
      maxTotalInputChars: input.maxTotalInputChars
        ?? DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
      perNoticeCostCapUsd,
      dailyCostCapUsd: input.dailyCostCapUsd
        ?? DEEP_ANALYSIS_DEFAULT_LIMITS.dailyCostCapUsd,
      cohortPerNoticeCapUpperBoundUsd: perNoticeCostCapUsd * 80,
    },
    summary,
    items,
    inputReadinessVerdict: summary.readyForExecutionCount === 80
      ? "PASS" as const
      : "BLOCKED" as const,
    qualityVerdict: "NOT_RUN" as const,
    executionAuthorized: false as const,
    externalLlmCalls: 0 as const,
    databaseWriteMode: false as const,
    objectStorageWriteMode: false as const,
  };
  return { ...payload, manifestSha256: sha256Canonical(payload) };
}

export type DeepAnalysisQualityPreflightReceipt =
  ReturnType<typeof buildDeepAnalysisQualityPreflightReceipt>;

export function verifyDeepAnalysisQualityPreflightReceipt(input: {
  frozenPublicManifest: DeepAnalysisQualityPublicManifest;
  frozenSecretManifest: DeepAnalysisQualitySecretManifest;
  receipt: DeepAnalysisQualityPreflightReceipt;
}): void {
  const { receipt } = input;
  const { manifestSha256: _hash, ...payload } = receipt;
  if (
    receipt.recordType !== "deep_analysis_quality_preflight"
    || receipt.schemaVersion !== 1
    || receipt.preflightVersion !== DEEP_ANALYSIS_QUALITY_PREFLIGHT_VERSION
    || receipt.manifestSha256 !== sha256Canonical(payload)
  ) {
    throw new Error("Deep analysis quality preflight receipt envelope/hash is invalid.");
  }
  if (
    receipt.frozenPublicManifestSha256 !== input.frozenPublicManifest.manifestSha256
    || receipt.frozenSecretManifestSha256 !== input.frozenSecretManifest.manifestSha256
    || receipt.selectionCommitmentSha256
      !== input.frozenPublicManifest.selectionCommitmentSha256
  ) {
    throw new Error("Deep analysis quality preflight is not bound to the frozen cohort.");
  }
  const expectedCommitments = new Set(
    input.frozenSecretManifest.selected.map((entry) => entry.opaqueCommitmentSha256),
  );
  const actualCommitments = new Set(
    receipt.items.map((entry) => entry.opaqueCommitmentSha256),
  );
  if (
    receipt.items.length !== 80
    || actualCommitments.size !== 80
    || [...expectedCommitments].some((value) => !actualCommitments.has(value))
  ) {
    throw new Error("Deep analysis quality preflight item set differs from the frozen cohort.");
  }
  for (const item of receipt.items) {
    const expectedPlan = planDeepAnalysisQualityLogicalCalls({
      readyForExecution: item.readyForExecution,
      evidenceChars: item.evidenceChars,
      chunkCount: item.chunkCount,
    });
    if (stableJson(item.callPlan) !== stableJson(expectedPlan)) {
      throw new Error("Deep analysis quality preflight call plan is invalid.");
    }
  }
  const readyCount = receipt.items.filter((item) => item.readyForExecution).length;
  if (
    receipt.items.filter((item) => item.split === "validation").length !== 48
    || receipt.items.filter((item) => item.split === "sealed").length !== 32
    || receipt.summary.readyForExecutionCount !== readyCount
    || receipt.summary.blockedCount !== 80 - readyCount
    || receipt.inputReadinessVerdict !== (readyCount === 80 ? "PASS" : "BLOCKED")
  ) {
    throw new Error("Deep analysis quality preflight summary/verdict is invalid.");
  }
  if (
    receipt.qualityVerdict !== "NOT_RUN"
    || receipt.executionAuthorized
    || receipt.externalLlmCalls !== 0
    || receipt.databaseWriteMode
    || receipt.objectStorageWriteMode
  ) {
    throw new Error("Deep analysis quality preflight must remain read-only and non-executing.");
  }
}

function summarize(
  items: ReturnType<typeof planItemArray>,
  observations: DeepAnalysisQualityPreflightObservation[],
) {
  const validationCount = items.filter((item) => item.split === "validation").length;
  const sealedCount = items.filter((item) => item.split === "sealed").length;
  if (validationCount !== 48 || sealedCount !== 32) {
    throw new Error("Deep analysis quality preflight split must remain 48/32.");
  }
  const sum = (read: (item: (typeof items)[number]) => number) =>
    items.reduce((total, item) => total + read(item), 0);
  const readyForExecutionCount = items.filter((item) => item.readyForExecution).length;
  return {
    selectedCount: 80 as const,
    validationCount: 48 as const,
    sealedCount: 32 as const,
    frozenSnapshotMatchCount: items.filter((item) => item.frozenSnapshotMatched).length,
    currentInputSealedCount: items.filter((item) => item.currentInputSealed).length,
    readyForExecutionCount,
    blockedCount: 80 - readyForExecutionCount,
    blockerCounts: countValues(items.flatMap((item) => item.blockerCodes)),
    productionBlockerCounts: countValues(
      items.flatMap((item) => item.productionBlockerCodes),
    ),
    dispositionCounts: sumRecords(observations.map((item) => item.dispositionCounts)),
    totalChars: sum((item) => item.totalChars),
    totalEvidenceChars: sum((item) => item.evidenceChars),
    totalAttachments: sum((item) => item.attachmentCount),
    includedAttachments: sum((item) => item.includedAttachmentCount),
    totalChunks: sum((item) => item.chunkCount),
    mandatoryLogicalModelCalls: sum((item) => item.callPlan.mandatoryLogicalModelCalls),
    maxLogicalModelCalls: sum((item) => item.callPlan.maxLogicalModelCalls),
    maxHttpAttemptsWithOneRetryPerCall: sum(
      (item) => item.callPlan.maxHttpAttemptsWithOneRetryPerCall,
    ),
  };
}

// summarize의 item 타입을 build 함수의 redacted projection과 동기화하기 위한 타입 전용 helper.
function planItemArray() {
  return [] as Array<{
    split: DeepAnalysisQualityCohortEntry["split"];
    frozenSnapshotMatched: boolean;
    currentInputSealed: boolean;
    readyForExecution: boolean;
    blockerCodes: DeepAnalysisQualityPreflightBlockerCode[];
    productionBlockerCodes: string[];
    totalChars: number;
    evidenceChars: number;
    attachmentCount: number;
    includedAttachmentCount: number;
    chunkCount: number;
    callPlan: ReturnType<typeof planDeepAnalysisQualityLogicalCalls>;
  }>;
}

function countValues(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function sumRecords(records: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value;
    }
  }
  return result;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function sha256Canonical(value: unknown): string {
  return sha256Hex(stableJson(value));
}
