import type { GrantCriterion } from "@cunote/contracts";
import type { NonMatchingCriterionReason } from "@cunote/core/criteria/matching-scope";

export const MATCHING_CONVERSION_CONTRACT_VERSION =
  "analysis-lab-shadow-conversion-v3" as const;

export type MatchingConversionItemStatus =
  | "converted"
  | "downgraded"
  | "scope_rejected"
  | "dropped"
  | "failed"
  | "held_duplicate";

export interface MatchingConversionItemReport {
  selectionPosition: number;
  criterionIndex: number;
  needsReview: boolean;
  status: MatchingConversionItemStatus;
  reason: string | null;
  scopeReason: NonMatchingCriterionReason | null;
  outputPosition: number | null;
  outputCriterionId: string | null;
  relatedCriterionIndexes: number[];
  source: {
    dimension: string;
    kind: string;
    operator: string;
  } | null;
  projected: {
    dimension: string;
    kind: string;
    operator: string;
  } | null;
}

export interface MatchingConversionReport {
  /** 구 release artifact에는 없을 수 있다. 신규 producer는 항상 v3를 기록한다. */
  contractVersion?: typeof MATCHING_CONVERSION_CONTRACT_VERSION;
  grantId: string;
  runId: string;
  verdicts: { correct: number; needs_edit: number; wrong: number; unsure: number };
  missedConditions: number;
  inputRows: number;
  converted: number;
  downgraded: number;
  dropped: number;
  error: string | null;
  /** 구 release artifact에는 없을 수 있다. 신규 producer는 selection 전량을 기록한다. */
  items?: MatchingConversionItemReport[];
}

export interface MatchingConversionIntegrity {
  completeItemAccounting: boolean;
  scopeRejectedCriterionIndexes: number[];
  blockingCriterionIndexes: number[];
  issues: string[];
}

/** 신규 v3 report의 selection→terminal outcome→실제 output 결속을 검증한다. */
export function inspectMatchingConversionReport(
  report: MatchingConversionReport,
  criteria: readonly GrantCriterion[],
): MatchingConversionIntegrity {
  const items = report.items;
  if (report.contractVersion !== MATCHING_CONVERSION_CONTRACT_VERSION) {
    return failedInspection(report.contractVersion === undefined
      ? "legacy_conversion_report_without_item_accounting"
      : "unsupported_conversion_contract_version");
  }
  if (!items) return failedInspection("conversion_item_accounting_missing");

  const issues: string[] = [];
  const allowedStatuses = new Set<MatchingConversionItemStatus>([
    "converted",
    "downgraded",
    "scope_rejected",
    "dropped",
    "failed",
    "held_duplicate",
  ]);
  if (items.some((item) => !allowedStatuses.has(item.status))) issues.push("unknown_item_status");
  const published = items.filter((item) => (
    item.status === "converted" || item.status === "downgraded"
  ));
  const dropped = items.length - published.length;
  const downgraded = items.filter((item) => item.status === "downgraded").length;
  const positions = published.map((item) => item.outputPosition).sort(compareNullableNumbers);
  const selectionPositions = items.map((item) => item.selectionPosition).sort((a, b) => a - b);

  if (report.inputRows !== items.length) issues.push("input_rows_item_count_mismatch");
  if (report.converted !== criteria.length || published.length !== criteria.length) {
    issues.push("converted_output_count_mismatch");
  }
  if (report.dropped !== dropped) issues.push("dropped_item_count_mismatch");
  if (report.downgraded !== downgraded) issues.push("downgraded_item_count_mismatch");
  if (positions.some((position, index) => position !== index)) {
    issues.push("output_positions_not_contiguous");
  }
  if (selectionPositions.some((position, index) => position !== index)) {
    issues.push("selection_positions_not_contiguous");
  }
  if (new Set(items.map((item) => item.criterionIndex)).size !== items.length) {
    issues.push("criterion_index_not_unique");
  }
  if (items.some((item) => !Number.isInteger(item.criterionIndex) || item.criterionIndex < 0)) {
    issues.push("criterion_index_invalid");
  }
  if (items.some((item) => (
    (item.status === "converted" || item.status === "downgraded")
      ? item.outputPosition === null
        || item.projected === null
        || item.source === null
        || item.outputCriterionId === null
      : item.outputPosition !== null || item.outputCriterionId !== null || item.projected !== null
  ))) {
    issues.push("item_terminal_output_binding_mismatch");
  }
  if (items.some((item) => item.status !== "failed" && item.source === null)) {
    issues.push("item_source_missing");
  }
  if (items.some((item) => (
    item.status === "converted" ? item.reason !== null
      : item.status === "scope_rejected"
        ? item.reason === null || item.scopeReason === null || item.reason !== item.scopeReason
        : item.reason === null
  ))) {
    issues.push("item_reason_binding_mismatch");
  }
  for (const item of published) {
    const criterion = item.outputPosition === null ? undefined : criteria[item.outputPosition];
    if (!criterion) continue;
    if (
      item.outputCriterionId !== (criterion.id ?? null)
      || !item.outputCriterionId?.endsWith(`:llm-${item.criterionIndex + 1}`)
      || item.projected?.dimension !== criterion.dimension
      || item.projected?.kind !== criterion.kind
      || item.projected?.operator !== criterion.operator
      || item.source?.kind !== criterion.kind
    ) {
      issues.push(`output_item_binding_mismatch:${item.criterionIndex}`);
    }
  }

  return {
    completeItemAccounting: issues.length === 0,
    scopeRejectedCriterionIndexes: items
      .filter((item) => item.status === "scope_rejected")
      .map((item) => item.criterionIndex)
      .sort((a, b) => a - b),
    blockingCriterionIndexes: items
      .filter((item) => (
        item.status === "dropped"
        || item.status === "failed"
        || item.status === "held_duplicate"
      ))
      .map((item) => item.criterionIndex)
      .sort((a, b) => a - b),
    issues,
  };
}

/** 진짜 역사 무버전 report만 기존 집계 계약으로 읽고, 신규/알 수 없는 버전은 fail-closed한다. */
export function matchingConversionIsPromotionSafe(input: {
  report: MatchingConversionReport;
  criteria: readonly GrantCriterion[];
  scopeRejectedCriterionIndexes: readonly number[] | undefined;
}): boolean {
  const isLegacyReport = input.report.contractVersion === undefined && input.report.items === undefined;
  if (isLegacyReport) {
    return input.report.error === null
      && input.report.dropped === (input.scopeRejectedCriterionIndexes?.length ?? -1);
  }
  const inspection = inspectMatchingConversionReport(input.report, input.criteria);
  if (!inspection.completeItemAccounting) return false;
  const declaredScope = [...(input.scopeRejectedCriterionIndexes ?? [])].sort((a, b) => a - b);
  return input.report.error === null
    && inspection.blockingCriterionIndexes.length === 0
    && arraysEqual(inspection.scopeRejectedCriterionIndexes, declaredScope);
}

function failedInspection(issue: string): MatchingConversionIntegrity {
  return {
    completeItemAccounting: false,
    scopeRejectedCriterionIndexes: [],
    blockingCriterionIndexes: [],
    issues: [issue],
  };
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  return (left ?? -1) - (right ?? -1);
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
