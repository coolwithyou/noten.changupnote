import { CRITERION_DIMENSIONS } from "./enums.js";

export const DEEP_ANALYSIS_ACTIVE_POLICY_VERSION = "deep-analysis-active-kst-v1" as const;
export const DEEP_ANALYSIS_ACTIVE_TIME_ZONE = "Asia/Seoul" as const;

export const DEEP_ANALYSIS_STAGE_KEYS = [
  "source_fresh",
  "attachment_inventory_complete",
  "attachment_archive_complete",
  "attachment_text_complete",
  "input_coverage_verified",
  "input_sealed",
  "model_call_passed",
  "response_contract_valid",
  "axis_coverage_complete",
  "evidence_grounded",
  "independent_audit_passed",
  "analysis_complete",
  "publication_complete",
  "serving_complete",
  "analysis_fresh",
] as const;

export const DEEP_ANALYSIS_STAGE_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "stale",
  "not_applicable",
] as const;

export const DEEP_ANALYSIS_AXIS_STATUSES = [
  "condition_found",
  "inspected_no_condition",
  "ambiguous",
  "input_missing",
  "unassessed",
] as const;

export const DEEP_ANALYSIS_ATTACHMENT_DISPOSITIONS = [
  "included",
  "duplicate",
  "waived_non_text",
  "waived_non_material",
  "blocked_conversion",
  "blocked_fetch",
  "blocked_cap",
] as const;

export type DeepAnalysisStageKey = (typeof DEEP_ANALYSIS_STAGE_KEYS)[number];
export type DeepAnalysisStageStatus = (typeof DEEP_ANALYSIS_STAGE_STATUSES)[number];
export type DeepAnalysisAxisStatus = (typeof DEEP_ANALYSIS_AXIS_STATUSES)[number];
export type DeepAnalysisAttachmentDisposition =
  (typeof DEEP_ANALYSIS_ATTACHMENT_DISPOSITIONS)[number];

export interface DeepAnalysisActiveGrantInput {
  status: string;
  applyStart: Date | string | null;
  applyEnd: Date | string | null;
}

export interface DeepAnalysisCompletionFlags {
  analysisComplete: boolean;
  publicationComplete: boolean;
  servingComplete: boolean;
  fresh: boolean;
  firstBlockingStage: DeepAnalysisStageKey | null;
}

export interface DeepAnalysisStageSnapshot {
  stage: DeepAnalysisStageKey;
  status: DeepAnalysisStageStatus;
}

/**
 * 활성 딥분석 모집단의 단일 제품 계약.
 *
 * DB 쿼리는 같은 policy version과 KST 날짜 경계를 사용해야 한다. applyEnd 미상이나
 * 시작 전 공고는 별도 예외/예정 큐이며 유료 딥분석 활성 분모에 넣지 않는다.
 */
export function isGrantActiveForDeepAnalysis(
  grant: DeepAnalysisActiveGrantInput,
  asOf: Date = new Date(),
): boolean {
  if (grant.status !== "open") return false;
  const start = dateKey(grant.applyStart);
  const end = dateKey(grant.applyEnd);
  if (!end) return false;
  const today = dateKey(asOf);
  if (!today) return false;
  if (start && start > today) return false;
  return end >= today;
}

export function deriveDeepAnalysisCompletion(
  stages: readonly DeepAnalysisStageSnapshot[],
): DeepAnalysisCompletionFlags {
  const latest = new Map<DeepAnalysisStageKey, DeepAnalysisStageStatus>();
  for (const stage of stages) latest.set(stage.stage, stage.status);

  const firstBlockingStage = DEEP_ANALYSIS_STAGE_KEYS.find((stage) => {
    const status = latest.get(stage);
    return status !== "passed" && status !== "not_applicable";
  }) ?? null;

  return {
    analysisComplete: latest.get("analysis_complete") === "passed",
    publicationComplete: latest.get("publication_complete") === "passed",
    servingComplete: latest.get("serving_complete") === "passed",
    fresh: latest.get("analysis_fresh") === "passed",
    firstBlockingStage,
  };
}

export function hasExactDeepAnalysisAxisCoverage(
  axes: readonly { dimension: string }[],
): boolean {
  if (axes.length !== CRITERION_DIMENSIONS.length) return false;
  const dimensions = new Set(axes.map((axis) => axis.dimension));
  return dimensions.size === CRITERION_DIMENSIONS.length
    && CRITERION_DIMENSIONS.every((dimension) => dimensions.has(dimension));
}

function dateKey(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEEP_ANALYSIS_ACTIVE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
