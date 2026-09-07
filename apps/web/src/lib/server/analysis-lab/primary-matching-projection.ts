import type { GrantCriterion } from "@cunote/contracts";
import {
  LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION,
} from "@cunote/core/bizinfo/llm-criteria";
import { RULESET_VERSION } from "@cunote/core/matching/match";
import {
  inspectMatchingConversionReport,
  MATCHING_CONVERSION_CONTRACT_VERSION,
} from "@/lib/server/analysis-serving/matchingConversionContract";
import { sha256Canonical } from "@/lib/server/analysis-serving/promotionReleaseContract";
import {
  PRIMARY_MATCHING_PROJECTION_SNAPSHOT_SCHEMA,
  type LabCriterion,
  type LabPrimaryMatchingProjectionSnapshot,
} from "./lab-contract";
import {
  ANALYSIS_LAB_SHADOW_PARSER_VERSION,
  convertSelectedLabCriteria,
  type LabMatchingProjectionSource,
} from "./shadow-convert";
import type { AnalysisLaunchMatchingProjectionBinding } from "./launch-batch-artifacts";

export interface PrimaryMatchingProjectionSource extends LabMatchingProjectionSource {
  source: string;
  inputSha256: string;
  attachmentManifestSha256?: string;
}

export type PrimaryMatchingProjectionInspection =
  | { status: "verified"; issues: [] }
  | { status: "unverified" | "failed" | "mismatch"; issues: string[] };

/** orchestration seam: 진단 전체 예외를 primary 결과와 분리해 failed snapshot 값으로 캡처한다. */
export function capturePrimaryMatchingProjectionSnapshot(input: {
  source: PrimaryMatchingProjectionSource;
  primaryExtractionAvailable: boolean;
}, dependencies?: {
  build?: typeof buildPrimaryMatchingProjectionSnapshot;
}): LabPrimaryMatchingProjectionSnapshot {
  try {
    return (dependencies?.build ?? buildPrimaryMatchingProjectionSnapshot)(input);
  } catch (error) {
    return failedSnapshot(input, error);
  }
}

/**
 * primary Promise가 해소된 즉시 호출하는 순수 진단. 변환 실패도 snapshot 값으로 남기며
 * primary outcome/error나 launch target status에는 영향을 주지 않는다.
 */
export function buildPrimaryMatchingProjectionSnapshot(input: {
  source: PrimaryMatchingProjectionSource;
  primaryExtractionAvailable: boolean;
}, dependencies?: {
  convert?: typeof convertSelectedLabCriteria;
}): LabPrimaryMatchingProjectionSnapshot {
  let conversion: ReturnType<typeof convertSelectedLabCriteria>;
  try {
    conversion = convertAllPrimaryCriteria(
      input.source,
      dependencies?.convert ?? convertSelectedLabCriteria,
    );
  } catch (error) {
    conversion = failedConversion(input.source, error);
  }
  const integrity = inspectMatchingConversionReport(conversion.report, conversion.criteria);
  const issues = [
    ...integrity.issues,
    ...(!input.primaryExtractionAvailable ? ["primary_extraction_unavailable"] : []),
    ...(conversion.report.error ? ["conversion_report_error"] : []),
    ...integrity.blockingCriterionIndexes.map((index) => `blocking_criterion:${index}`),
  ];
  return {
    schema: PRIMARY_MATCHING_PROJECTION_SNAPSHOT_SCHEMA,
    verification: issues.length === 0 ? "verified" : "failed",
    source: {
      runId: input.source.runId,
      grantId: input.source.grantId,
      source: input.source.source,
      sourceId: input.source.sourceId,
      inputSha256: input.source.inputSha256,
      attachmentManifestSha256: input.source.attachmentManifestSha256 ?? null,
      criteriaSha256: sha256Canonical(input.source.criteria),
      primaryExtractionAvailable: input.primaryExtractionAvailable,
    },
    runtime: currentPrimaryMatchingProjectionRuntime(),
    projectedCriteria: conversion.criteria,
    projectedCriteriaSha256: sha256Canonical(conversion.criteria),
    report: conversion.report,
    reportSha256: sha256Canonical(conversion.report),
    issues: [...new Set(issues)].sort(),
  };
}

/** 역사 부재는 명시 unverified, 신규 손상/현재 runtime drift는 PASS가 아닌 별도 상태다. */
export function inspectPrimaryMatchingProjectionSnapshot(
  source: PrimaryMatchingProjectionSource,
  snapshot: LabPrimaryMatchingProjectionSnapshot | null | undefined,
): PrimaryMatchingProjectionInspection {
  if (!snapshot) {
    return { status: "unverified", issues: ["matching_projection_snapshot_missing"] };
  }
  if (snapshot.schema !== PRIMARY_MATCHING_PROJECTION_SNAPSHOT_SCHEMA) {
    return { status: "mismatch", issues: ["matching_projection_snapshot_schema_mismatch"] };
  }
  const issues: string[] = [];
  const currentRuntime = currentPrimaryMatchingProjectionRuntime();
  if (
    snapshot.source.runId !== source.runId
    || snapshot.source.grantId !== source.grantId
    || snapshot.source.source !== source.source
    || snapshot.source.sourceId !== source.sourceId
    || snapshot.source.inputSha256 !== source.inputSha256
    || snapshot.source.attachmentManifestSha256 !== (source.attachmentManifestSha256 ?? null)
    || snapshot.source.criteriaSha256 !== sha256Canonical(source.criteria)
  ) issues.push("matching_projection_source_binding_mismatch");
  if (sha256Canonical(snapshot.projectedCriteria) !== snapshot.projectedCriteriaSha256) {
    issues.push("matching_projection_output_hash_mismatch");
  }
  if (sha256Canonical(snapshot.report) !== snapshot.reportSha256) {
    issues.push("matching_projection_report_hash_mismatch");
  }
  if (sha256Canonical(snapshot.runtime) !== sha256Canonical(currentRuntime)) {
    issues.push("matching_projection_runtime_binding_mismatch");
  }
  if (
    snapshot.report.grantId !== source.grantId
    || snapshot.report.runId !== source.runId
    || snapshot.report.contractVersion !== MATCHING_CONVERSION_CONTRACT_VERSION
  ) issues.push("matching_projection_report_source_mismatch");

  const integrity = inspectMatchingConversionReport(snapshot.report, snapshot.projectedCriteria);
  issues.push(...integrity.issues);
  const sourceIndexes = snapshot.report.items?.map((item) => item.criterionIndex).sort((a, b) => a - b) ?? [];
  if (
    snapshot.report.inputRows !== source.criteria.length
    || sourceIndexes.length !== source.criteria.length
    || sourceIndexes.some((index, position) => index !== position)
  ) issues.push("matching_projection_source_accounting_mismatch");
  if (snapshot.report.error) issues.push("conversion_report_error");
  issues.push(...integrity.blockingCriterionIndexes.map((index) => `blocking_criterion:${index}`));

  if (snapshot.verification !== "verified" || !snapshot.source.primaryExtractionAvailable) {
    return {
      status: "failed",
      issues: [...new Set([...snapshot.issues, ...issues, "matching_projection_not_verified"])].sort(),
    };
  }
  const current = buildPrimaryMatchingProjectionSnapshot({
    source,
    primaryExtractionAvailable: true,
  });
  if (
    current.verification !== "verified"
    || current.projectedCriteriaSha256 !== snapshot.projectedCriteriaSha256
    || current.reportSha256 !== snapshot.reportSha256
  ) issues.push("matching_projection_current_reprojection_mismatch");
  const distinctIssues = [...new Set(issues)].sort();
  return distinctIssues.length === 0
    ? { status: "verified", issues: [] }
    : { status: "mismatch", issues: distinctIssues };
}

export function primaryMatchingProjectionSnapshotSha256(
  snapshot: LabPrimaryMatchingProjectionSnapshot,
): string {
  return sha256Canonical(snapshot);
}

export function buildAnalysisLaunchMatchingProjectionBinding(
  snapshot: LabPrimaryMatchingProjectionSnapshot,
): AnalysisLaunchMatchingProjectionBinding {
  return {
    schema: "analysis-launch-primary-matching-projection-binding-v1",
    verification: snapshot.verification,
    snapshotSha256: primaryMatchingProjectionSnapshotSha256(snapshot),
    sourceCriteriaSha256: snapshot.source.criteriaSha256,
    projectedCriteriaSha256: snapshot.projectedCriteriaSha256,
    reportSha256: snapshot.reportSha256,
    conversionContractVersion: snapshot.runtime.conversionContractVersion,
    converterVersion: snapshot.runtime.converterVersion,
    normalizerContractVersion: snapshot.runtime.normalizerContractVersion,
    matcherRulesetVersion: snapshot.runtime.matcherRulesetVersion,
  };
}

function convertAllPrimaryCriteria(
  source: LabMatchingProjectionSource,
  convert: typeof convertSelectedLabCriteria,
): {
  criteria: GrantCriterion[];
  report: ReturnType<typeof convertSelectedLabCriteria>["report"];
} {
  return convert(source, {
    selections: source.criteria.map((_, criterionIndex) => ({
      criterionIndex,
      // primary 직후에는 사람/독립 검수 전이다. matcher hard-fail을 확정하지 않는다.
      needsReview: true,
    })),
  });
}

function failedConversion(
  source: LabMatchingProjectionSource,
  error: unknown,
): ReturnType<typeof convertSelectedLabCriteria> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    criteria: [],
    report: {
      contractVersion: MATCHING_CONVERSION_CONTRACT_VERSION,
      grantId: source.grantId,
      runId: source.runId,
      verdicts: { correct: 0, needs_edit: 0, wrong: 0, unsure: source.criteria.length },
      missedConditions: 0,
      inputRows: source.criteria.length,
      converted: 0,
      downgraded: 0,
      dropped: source.criteria.length,
      error: `primary_matching_projection_exception:${message.slice(0, 500)}`,
      items: source.criteria.map((criterion, criterionIndex) => ({
        selectionPosition: criterionIndex,
        criterionIndex,
        needsReview: true,
        status: "failed",
        reason: "primary_matching_projection_exception",
        scopeReason: null,
        outputPosition: null,
        outputCriterionId: null,
        relatedCriterionIndexes: [],
        source: {
          dimension: criterion.dimension,
          kind: criterion.kind,
          operator: criterion.operator,
        },
        projected: null,
      })),
    },
  };
}

function failedSnapshot(
  input: {
    source: PrimaryMatchingProjectionSource;
    primaryExtractionAvailable: boolean;
  },
  error: unknown,
): LabPrimaryMatchingProjectionSnapshot {
  const conversion = failedConversion(input.source, error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    schema: PRIMARY_MATCHING_PROJECTION_SNAPSHOT_SCHEMA,
    verification: "failed",
    source: {
      runId: input.source.runId,
      grantId: input.source.grantId,
      source: input.source.source,
      sourceId: input.source.sourceId,
      inputSha256: input.source.inputSha256,
      attachmentManifestSha256: input.source.attachmentManifestSha256 ?? null,
      // 전체 진단 예외에서는 원천 hash를 verified처럼 만들지 않는다.
      criteriaSha256: "0".repeat(64),
      primaryExtractionAvailable: input.primaryExtractionAvailable,
    },
    runtime: currentPrimaryMatchingProjectionRuntime(),
    projectedCriteria: [],
    projectedCriteriaSha256: sha256Canonical([]),
    report: conversion.report,
    reportSha256: sha256Canonical(conversion.report),
    issues: [`matching_projection_diagnostic_exception:${message.slice(0, 500)}`],
  };
}

function currentPrimaryMatchingProjectionRuntime(): LabPrimaryMatchingProjectionSnapshot["runtime"] {
  return {
    conversionContractVersion: MATCHING_CONVERSION_CONTRACT_VERSION,
    converterVersion: ANALYSIS_LAB_SHADOW_PARSER_VERSION,
    normalizerContractVersion: LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION,
    matcherRulesetVersion: RULESET_VERSION,
  };
}

export function primaryProjectionSource(input: {
  runId: string;
  grantId: string;
  source: string;
  sourceId: string;
  inputSha256: string;
  attachmentManifestSha256?: string;
  criteria: LabCriterion[];
}): PrimaryMatchingProjectionSource {
  return input;
}
