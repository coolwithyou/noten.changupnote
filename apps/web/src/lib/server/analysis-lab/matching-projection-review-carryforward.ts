import type { GrantCriterion } from "@cunote/contracts";
import {
  ANALYSIS_LAUNCH_MATCHING_PROJECTION_REVIEW_CARRYFORWARD_SCHEMA,
  canonicalJson,
  type AnalysisLaunchMatchingProjectionReviewCarryforward,
} from "../analysis-serving/promotionReleaseContract";
import type {
  LabPrimaryMatchingProjectionSnapshot,
  LabRun,
} from "./lab-contract";
import type { AnalysisLaunchMatchingProjectionBinding } from "./launch-batch-artifacts";
import {
  buildAnalysisLaunchMatchingProjectionBinding,
  buildPrimaryMatchingProjectionSnapshot,
  inspectPrimaryMatchingProjectionSnapshot,
  primaryMatchingProjectionSnapshotSha256,
  primaryProjectionSource,
} from "./primary-matching-projection";

const HISTORICAL_NORMALIZER = "grant-llm-criteria-normalization-v2";
const CURRENT_NORMALIZER = "grant-llm-criteria-normalization-v3";
const ALLOWED_HISTORICAL_ISSUES = new Set([
  "matching_projection_runtime_binding_mismatch",
  "matching_projection_current_reprojection_mismatch",
]);

export interface ReviewedProjectionFinding {
  readonly kind: "criterion" | "axis";
  readonly key: number | string;
}

export interface ReviewedMatchingProjectionResolution {
  snapshot: LabPrimaryMatchingProjectionSnapshot;
  binding: AnalysisLaunchMatchingProjectionBinding;
  carryforward: AnalysisLaunchMatchingProjectionReviewCarryforward | null;
}

/**
 * 독립 검수된 역사 projection과 현행 runtime 사이의 유일한 허용 승계 경계.
 * 일반적인 재투영 변경은 거부하고, v2가 비워 버린 text_only value의 무손실 복원만 허용한다.
 */
export function resolveReviewedMatchingProjectionForPromotion(input: {
  run: LabRun;
  target: {
    grantId: string;
    primaryMatchingProjection?: AnalysisLaunchMatchingProjectionBinding;
  };
  reviewedPacketBinding: AnalysisLaunchMatchingProjectionBinding & {
    provenance: "run_snapshot" | "derived_current";
  };
  reviewFindings: readonly ReviewedProjectionFinding[];
}): ReviewedMatchingProjectionResolution {
  const source = primaryProjectionSource({
    runId: input.run.runId,
    grantId: input.run.grantId,
    source: input.run.source,
    sourceId: input.run.sourceId,
    inputSha256: input.run.inputSha256,
    ...(input.run.attachmentManifestSha256
      ? { attachmentManifestSha256: input.run.attachmentManifestSha256 }
      : {}),
    criteria: input.run.criteria,
  });
  const historical = input.run.primaryMatchingProjection;
  if (!historical) {
    const current = buildPrimaryMatchingProjectionSnapshot({
      source,
      primaryExtractionAvailable: true,
    });
    assertCurrentSnapshotVerified(source, current, input.run.grantId);
    const binding = buildAnalysisLaunchMatchingProjectionBinding(current);
    assertOptionalReceiptBinding(input.target.primaryMatchingProjection, binding, input.run.grantId);
    assertPacketBinding(
      input.reviewedPacketBinding,
      { ...binding, provenance: "derived_current" },
      input.run.grantId,
    );
    return { snapshot: current, binding, carryforward: null };
  }

  const historicalBinding = buildAnalysisLaunchMatchingProjectionBinding(historical);
  assertOptionalReceiptBinding(input.target.primaryMatchingProjection, historicalBinding, input.run.grantId);
  assertPacketBinding(
    input.reviewedPacketBinding,
    { ...historicalBinding, provenance: "run_snapshot" },
    input.run.grantId,
  );
  const historicalInspection = inspectPrimaryMatchingProjectionSnapshot(source, historical);
  if (historicalInspection.status === "verified") {
    return { snapshot: historical, binding: historicalBinding, carryforward: null };
  }
  if (
    historicalInspection.status !== "mismatch"
    || historicalInspection.issues.length === 0
    || historicalInspection.issues.some((issue) => !ALLOWED_HISTORICAL_ISSUES.has(issue))
  ) {
    throw new Error(
      `검수된 역사 matching projection을 승계할 수 없습니다: ${input.run.grantId}`
      + ` (${historicalInspection.issues.join("+")})`,
    );
  }

  const current = buildPrimaryMatchingProjectionSnapshot({
    source,
    primaryExtractionAvailable: true,
  });
  assertCurrentSnapshotVerified(source, current, input.run.grantId);
  assertAllowedRuntimeTransition(historical, current, input.run.grantId);
  if (canonicalJson(historical.report) !== canonicalJson(current.report)) {
    throw new Error(`matching projection 변환 보고서가 달라 승계할 수 없습니다: ${input.run.grantId}`);
  }
  if (historical.projectedCriteria.length !== current.projectedCriteria.length) {
    throw new Error(`matching projection criterion 수가 달라 승계할 수 없습니다: ${input.run.grantId}`);
  }

  const outputToCriterion = new Map<number, number>();
  for (const item of current.report.items ?? []) {
    if (item.outputPosition === null) continue;
    if (outputToCriterion.has(item.outputPosition)) {
      throw new Error(`matching projection output 결속이 중복됐습니다: ${input.run.grantId}`);
    }
    outputToCriterion.set(item.outputPosition, item.criterionIndex);
  }
  const changedCriterionIndexes: number[] = [];
  for (let position = 0; position < current.projectedCriteria.length; position += 1) {
    const before = historical.projectedCriteria[position];
    const after = current.projectedCriteria[position];
    if (!before || !after) {
      throw new Error(`matching projection criterion 위치가 비었습니다: ${input.run.grantId}`);
    }
    if (canonicalJson(before) === canonicalJson(after)) continue;
    const criterionIndex = outputToCriterion.get(position);
    const sourceCriterion = criterionIndex === undefined
      ? undefined
      : input.run.criteria[criterionIndex];
    if (
      criterionIndex === undefined
      || !sourceCriterion
      || sourceCriterion.operator !== "text_only"
      || !hasTextOnlyNote(sourceCriterion.value)
      || after.operator !== "text_only"
      || canonicalJson(withoutValue(before)) !== canonicalJson(withoutValue(after))
      || !isStructurallyEmpty(before.value)
      || canonicalJson(after.value) !== canonicalJson(sourceCriterion.value)
      || input.reviewFindings.some(
        (finding) => finding.kind === "criterion" && finding.key === criterionIndex,
      )
    ) {
      throw new Error(
        `검수 범위를 벗어난 matching projection 변경입니다: ${input.run.grantId}:${position}`,
      );
    }
    changedCriterionIndexes.push(criterionIndex);
  }
  changedCriterionIndexes.sort((left, right) => left - right);
  if (new Set(changedCriterionIndexes).size !== changedCriterionIndexes.length) {
    throw new Error(`matching projection criterion 승계가 중복됐습니다: ${input.run.grantId}`);
  }

  const binding = buildAnalysisLaunchMatchingProjectionBinding(current);
  const carryforward: AnalysisLaunchMatchingProjectionReviewCarryforward = {
    schema: ANALYSIS_LAUNCH_MATCHING_PROJECTION_REVIEW_CARRYFORWARD_SCHEMA,
    policyVersion: "lossless-text-only-note-v1",
    mode: changedCriterionIndexes.length === 0
      ? "runtime_only"
      : "lossless_text_only_restore",
    historicalSnapshotSha256: primaryMatchingProjectionSnapshotSha256(historical),
    currentSnapshotSha256: binding.snapshotSha256,
    changedCriterionIndexes,
  };
  if (carryforward.historicalSnapshotSha256 === carryforward.currentSnapshotSha256) {
    throw new Error(`matching projection 승계 snapshot이 구분되지 않습니다: ${input.run.grantId}`);
  }
  return { snapshot: current, binding, carryforward };
}

function assertCurrentSnapshotVerified(
  source: Parameters<typeof inspectPrimaryMatchingProjectionSnapshot>[0],
  snapshot: LabPrimaryMatchingProjectionSnapshot,
  grantId: string,
): void {
  const inspection = inspectPrimaryMatchingProjectionSnapshot(source, snapshot);
  if (inspection.status !== "verified") {
    throw new Error(
      `현행 matching projection을 검증할 수 없습니다: ${grantId} (${inspection.issues.join("+")})`,
    );
  }
}

function assertAllowedRuntimeTransition(
  historical: LabPrimaryMatchingProjectionSnapshot,
  current: LabPrimaryMatchingProjectionSnapshot,
  grantId: string,
): void {
  const { normalizerContractVersion: historicalNormalizer, ...historicalStable } = historical.runtime;
  const { normalizerContractVersion: currentNormalizer, ...currentStable } = current.runtime;
  if (
    historicalNormalizer !== HISTORICAL_NORMALIZER
    || currentNormalizer !== CURRENT_NORMALIZER
    || canonicalJson(historicalStable) !== canonicalJson(currentStable)
  ) {
    throw new Error(`허용되지 않은 matching projection runtime 전환입니다: ${grantId}`);
  }
}

function assertOptionalReceiptBinding(
  receipt: AnalysisLaunchMatchingProjectionBinding | undefined,
  expected: AnalysisLaunchMatchingProjectionBinding,
  grantId: string,
): void {
  if (receipt && canonicalJson(receipt) !== canonicalJson(expected)) {
    throw new Error(`matching projection이 launch receipt 결속과 다릅니다: ${grantId}`);
  }
}

function assertPacketBinding(
  actual: AnalysisLaunchMatchingProjectionBinding & {
    provenance: "run_snapshot" | "derived_current";
  },
  expected: AnalysisLaunchMatchingProjectionBinding & {
    provenance: "run_snapshot" | "derived_current";
  },
  grantId: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`independent review packet matching projection 결속이 다릅니다: ${grantId}`);
  }
}

function withoutValue(criterion: GrantCriterion): Omit<GrantCriterion, "value"> {
  const { value: _value, ...rest } = criterion;
  return rest;
}

function hasTextOnlyNote(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const note = (value as Record<string, unknown>).note;
  return typeof note === "string" && note.trim().length > 0;
}

function isStructurallyEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.every(isStructurallyEmpty);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isStructurallyEmpty);
  }
  return false;
}
