import { CRITERION_DIMENSIONS } from "./enums.js";

type DeepAnalysisCriterionDimension = (typeof CRITERION_DIMENSIONS)[number];

export const DEEP_ANALYSIS_ACTIVE_POLICY_VERSION = "deep-analysis-active-kst-v1" as const;
export const DEEP_ANALYSIS_ACTIVE_TIME_ZONE = "Asia/Seoul" as const;
export const DEEP_ANALYSIS_PROMPT_VERSION = "deep-analysis-v2" as const;
export const DEEP_ANALYSIS_MODEL_POLICY_VERSION = "deep-analysis-model-policy-v3" as const;

/**
 * 운영 모델은 명시 allowlist만 허용한다. 환경변수로 임의 모델을 주입해 이미 검증한
 * prompt/tool 계약을 우회하지 못하게 한다.
 */
export const DEEP_ANALYSIS_PRIMARY_MODELS = ["claude-opus-4-8"] as const;
export const DEEP_ANALYSIS_AUDIT_MODELS = ["claude-sonnet-5", "claude-fable-5"] as const;

export const DEEP_ANALYSIS_DEFAULT_LIMITS = {
  leaseSeconds: 900,
  maxJobsPerInvocation: 5,
  maxEnqueuePerInvocation: 5,
  dailyCostCapUsd: 50,
  perNoticeCostCapUsd: 2,
  maxTotalInputChars: 800_000,
  heartbeatStaleSeconds: 600,
} as const;

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
export type DeepAnalysisPrimaryModel = (typeof DEEP_ANALYSIS_PRIMARY_MODELS)[number];
export type DeepAnalysisAuditModel = (typeof DEEP_ANALYSIS_AUDIT_MODELS)[number];

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

export type DeepAnalysisCriterionKind = "required" | "preferred" | "exclusion";
export type DeepAnalysisConfirmationReusable = "company_fact" | "per_notice";

export interface DeepAnalysisConfirmationOption {
  value: string;
  label: string;
  disqualifies: boolean;
}

export interface DeepAnalysisCriterionConfirmation {
  prompt: string;
  options: DeepAnalysisConfirmationOption[];
  answerType: "single" | "multi";
  reusable: DeepAnalysisConfirmationReusable;
  conditionKey: string | null;
}

export interface DeepAnalysisCriterion {
  dimension: DeepAnalysisCriterionDimension;
  kind: DeepAnalysisCriterionKind;
  operator: string;
  value: unknown;
  confidence: number;
  sourceSpan: string | null;
  spanVerified: boolean;
  spanOffsetRatio?: number | null;
  note: string | null;
  confirmation?: DeepAnalysisCriterionConfirmation | null;
}

export type DeepAnalysisAssessmentStatus =
  | "condition_found"
  | "inspected_no_condition"
  | "ambiguous"
  | "input_missing";

export interface DeepAnalysisAxisAssessment {
  dimension: DeepAnalysisCriterionDimension;
  status: DeepAnalysisAssessmentStatus;
  confidence: number;
  comment: string | null;
}

export interface DeepAnalysisProgramIntent {
  oneLiner: string;
  targetProfile: string;
  evaluationFocus: string[];
  benefitSummary: string;
  cautionNotes: string[];
}

export interface DeepAnalysisTaxonomyProposal {
  proposedDimension: string;
  rationale: string;
  exampleSpan: string;
}

export interface DeepAnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
}

export interface DeepAnalysisModelResult {
  model: string;
  analysisMarkdown: string;
  programIntent: DeepAnalysisProgramIntent | null;
  criteria: DeepAnalysisCriterion[];
  axisAssessments: DeepAnalysisAxisAssessment[];
  taxonomyProposals: DeepAnalysisTaxonomyProposal[];
  usage: DeepAnalysisUsage | null;
  costUsd: number | null;
  rawToolInput: Record<string, unknown>;
  rawResponseText: string;
  stopReason: string | null;
}

export function isAllowedDeepAnalysisPrimaryModel(
  value: string,
): value is DeepAnalysisPrimaryModel {
  return (DEEP_ANALYSIS_PRIMARY_MODELS as readonly string[]).includes(value);
}

export function isAllowedDeepAnalysisAuditModel(
  value: string,
): value is DeepAnalysisAuditModel {
  return (DEEP_ANALYSIS_AUDIT_MODELS as readonly string[]).includes(value);
}

export function assertDeepAnalysisModelPair(input: {
  primaryModel: string;
  auditModel: string;
}): asserts input is {
  primaryModel: DeepAnalysisPrimaryModel;
  auditModel: DeepAnalysisAuditModel;
} {
  if (input.primaryModel === input.auditModel) {
    throw new Error("Deep analysis primary and audit models must be different");
  }
  if (!isAllowedDeepAnalysisPrimaryModel(input.primaryModel)) {
    throw new Error(`Deep analysis primary model is not allowlisted: ${input.primaryModel}`);
  }
  if (!isAllowedDeepAnalysisAuditModel(input.auditModel)) {
    throw new Error(`Deep analysis audit model is not allowlisted: ${input.auditModel}`);
  }
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
