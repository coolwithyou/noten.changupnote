import { CRITERION_DIMENSIONS } from "./enums.js";

type DeepAnalysisCriterionDimension = (typeof CRITERION_DIMENSIONS)[number];

export const DEEP_ANALYSIS_ACTIVE_POLICY_VERSION = "deep-analysis-active-kst-v2" as const;
export const DEEP_ANALYSIS_ACTIVE_TIME_ZONE = "Asia/Seoul" as const;
export const DEEP_ANALYSIS_PROMPT_VERSION = "deep-analysis-v7" as const;
export const DEEP_ANALYSIS_MODEL_POLICY_VERSION = "deep-analysis-model-policy-v11" as const;
export const DEEP_ANALYSIS_SERVING_VERIFIER_VERSION =
  "deep-analysis-serving-verifier-v1" as const;
export const DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS = 45 * 60;
export const DEEP_ANALYSIS_INPUT_PREPARATION_STALE_SECONDS = 15 * 60;
export const DEEP_ANALYSIS_AGGREGATE_SPLIT_DEFAULT_MAX_COST_USD = 12;
export const GRANT_SERVING_STATES = ["visible", "staged", "suppressed"] as const;

/**
 * 운영 모델은 명시 allowlist만 허용한다. 환경변수로 임의 모델을 주입해 이미 검증한
 * prompt/tool 계약을 우회하지 못하게 한다.
 */
export const DEEP_ANALYSIS_PRIMARY_MODELS = ["claude-opus-4-8"] as const;
export const DEEP_ANALYSIS_AUDIT_MODELS = ["claude-sonnet-5", "claude-fable-5"] as const;

export const DEEP_ANALYSIS_DEFAULT_LIMITS = {
  // Cloud Run Job timeout(30분)보다 길게 유지해 장기 모델 호출 중 lease 재획득을 막는다.
  leaseSeconds: 2_100,
  maxJobsPerInvocation: 5,
  maxConcurrentJobs: 1,
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

/** 통합공고 child가 기존 promotion release에 들어가기 전에 모두 통과해야 하는 S0~S11. */
export const AGGREGATE_SPLIT_RELEASE_STAGE_KEYS = DEEP_ANALYSIS_STAGE_KEYS.slice(
  0,
  12,
) as readonly DeepAnalysisStageKey[];

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
export type GrantServingState = (typeof GRANT_SERVING_STATES)[number];

export interface DeepAnalysisActiveGrantInput {
  status: string;
  servingState: GrantServingState;
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

export interface AggregateSplitPublicationBlocker {
  code: string;
  stage: DeepAnalysisStageKey | null;
  message: string;
}

export interface AggregateSplitReleaseChildObservation {
  childId: string;
  childStatus: string;
  sourceRevisionSha256: string;
  inputSha256: string | null;
  stagedGrantAt: Date | string | null;
  servingState: GrantServingState | null;
  expectedJobId: string | null;
  job: {
    id: string;
    grantId: string;
    sourceRevisionSha256: string;
    modelPolicyVersion: string;
    status: string;
  } | null;
  latestRun: {
    id: string;
    jobId: string;
    grantId: string;
    sourceRevisionSha256: string;
    inputSha256: string;
    modelPolicyVersion: string;
    status: string;
  } | null;
  stageStatuses: Partial<Record<DeepAnalysisStageKey, string>>;
  latestAudit: {
    inputSha256: string;
    verdict: string;
  } | null;
  promotionItemStatus?: string | null;
  publicationReceiptStatus?: string | null;
  servingReceiptStatus?: string | null;
  freshnessReceiptStatus?: string | null;
}

export interface AggregateSplitReleaseCaseObservation {
  status: string;
  materializationStatus: string;
  promotionStatus: string;
  parentServingState: GrantServingState | null;
  programCount: number | null;
  preparedChildCount: number;
  stagedChildCount: number;
  enqueuedChildCount: number;
  children: AggregateSplitReleaseChildObservation[];
}

export interface AggregateSplitReleaseGateResult {
  ready: boolean;
  firstBlocker: AggregateSplitPublicationBlocker | null;
  children: Array<{
    childId: string;
    runId: string | null;
    ready: boolean;
    firstBlocker: AggregateSplitPublicationBlocker | null;
  }>;
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
  if (grant.servingState !== "visible") return false;
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

/**
 * 통합공고 child의 release 진입 조건. 호출자가 고른 일부 run이 아니라 case의 전체 child
 * 집합을 입력받아야 하며, 하나라도 막히면 ready=false다.
 */
export function evaluateAggregateSplitReleaseGate(
  observation: AggregateSplitReleaseCaseObservation,
): AggregateSplitReleaseGateResult {
  const caseBlocker = deriveAggregateSplitReleaseCaseBlocker(observation);
  const children = observation.children.map((child) => {
    const firstBlocker = deriveAggregateSplitReleaseChildBlocker(child);
    return {
      childId: child.childId,
      runId: child.latestRun?.id ?? null,
      ready: firstBlocker === null,
      firstBlocker,
    };
  });
  const firstBlocker = caseBlocker
    ?? children.find((child) => child.firstBlocker !== null)?.firstBlocker
    ?? null;
  return {
    ready: firstBlocker === null,
    firstBlocker,
    children,
  };
}

export function deriveAggregateSplitReleaseCaseBlocker(
  observation: AggregateSplitReleaseCaseObservation,
): AggregateSplitPublicationBlocker | null {
  if (
    observation.status !== "completed"
    || observation.materializationStatus !== "prepared"
  ) {
    return blocker(
      "aggregate_split_case_not_prepared",
      null,
      "통합공고 분리 case와 child 입력 준비가 완료되지 않았습니다.",
    );
  }
  if (observation.promotionStatus !== "enqueued") {
    return blocker(
      "aggregate_split_children_not_enqueued",
      null,
      "모든 staged child가 기존 깊은 분석 queue에 enqueue되지 않았습니다.",
    );
  }
  if (observation.parentServingState !== "visible") {
    return blocker(
      "aggregate_split_parent_not_visible",
      null,
      "S12 발행 동안 parent 공고는 visible 상태여야 합니다.",
    );
  }
  const expected = observation.programCount;
  if (
    expected === null
    || expected <= 1
    || observation.children.length !== expected
    || observation.preparedChildCount !== expected
    || observation.stagedChildCount !== expected
    || observation.enqueuedChildCount !== expected
  ) {
    return blocker(
      "aggregate_split_child_count_mismatch",
      null,
      "manifest, prepared, staged, enqueued child 수가 정확히 일치하지 않습니다.",
    );
  }
  return null;
}

export function deriveAggregateSplitReleaseChildBlocker(
  child: AggregateSplitReleaseChildObservation,
): AggregateSplitPublicationBlocker | null {
  if (child.childStatus !== "prepared" || child.stagedGrantAt === null) {
    return blocker(
      "aggregate_split_child_not_staged",
      null,
      "봉인된 child가 staged grant로 생성되지 않았습니다.",
    );
  }
  if (child.servingState !== "staged") {
    return blocker(
      "aggregate_split_child_serving_state_invalid",
      null,
      `release 진입 전 child serving state가 staged가 아닙니다: ${child.servingState ?? "missing"}`,
    );
  }
  if (!child.expectedJobId || !child.job) {
    return blocker(
      "aggregate_split_child_job_missing",
      null,
      "child에 연결된 깊은 분석 job이 없습니다.",
    );
  }
  if (child.job.id !== child.expectedJobId || child.job.grantId !== child.childId) {
    return blocker(
      "aggregate_split_child_job_identity_mismatch",
      null,
      "child 원장의 job ID와 실제 job의 grant identity가 다릅니다.",
    );
  }
  if (child.job.sourceRevisionSha256 !== child.sourceRevisionSha256) {
    return blocker(
      "aggregate_split_child_job_revision_mismatch",
      "source_fresh",
      "job source revision이 봉인된 child revision과 다릅니다.",
    );
  }
  if (child.job.modelPolicyVersion !== DEEP_ANALYSIS_MODEL_POLICY_VERSION) {
    return blocker(
      "aggregate_split_child_job_policy_mismatch",
      "model_call_passed",
      "job이 현재 최상급 모델 policy를 사용하지 않습니다.",
    );
  }
  if (child.job.status !== "succeeded") {
    return blocker(
      "aggregate_split_child_job_not_succeeded",
      null,
      `깊은 분석 job이 succeeded가 아닙니다: ${child.job.status}`,
    );
  }
  const run = child.latestRun;
  if (!run) {
    return blocker(
      "aggregate_split_child_run_missing",
      null,
      "child job의 최신 deep analysis run이 없습니다.",
    );
  }
  if (
    run.jobId !== child.job.id
    || run.grantId !== child.childId
  ) {
    return blocker(
      "aggregate_split_child_run_identity_mismatch",
      null,
      "최신 run이 child와 정확한 job identity에 묶여 있지 않습니다.",
    );
  }
  if (run.sourceRevisionSha256 !== child.sourceRevisionSha256) {
    return blocker(
      "aggregate_split_child_run_revision_mismatch",
      "source_fresh",
      "최신 run source revision이 봉인된 child revision과 다릅니다.",
    );
  }
  if (!child.inputSha256 || run.inputSha256 !== child.inputSha256) {
    return blocker(
      "aggregate_split_child_run_input_mismatch",
      "input_sealed",
      "최신 run input hash가 봉인된 child input과 다릅니다.",
    );
  }
  if (run.modelPolicyVersion !== DEEP_ANALYSIS_MODEL_POLICY_VERSION) {
    return blocker(
      "aggregate_split_child_run_policy_mismatch",
      "model_call_passed",
      "최신 run이 현재 최상급 모델 policy를 사용하지 않습니다.",
    );
  }
  if (run.status !== "passed") {
    return blocker(
      "aggregate_split_child_run_not_passed",
      null,
      `최신 run이 passed가 아닙니다: ${run.status}`,
    );
  }
  for (const stage of AGGREGATE_SPLIT_RELEASE_STAGE_KEYS) {
    const status = child.stageStatuses[stage] ?? null;
    if (status !== "passed") {
      return blocker(
        "aggregate_split_child_stage_not_passed",
        stage,
        `${stage} 최신 receipt가 passed가 아닙니다: ${status ?? "missing"}`,
      );
    }
  }
  if (!child.latestAudit) {
    return blocker(
      "aggregate_split_child_audit_missing",
      "independent_audit_passed",
      "최신 독립 AI audit가 없습니다.",
    );
  }
  if (child.latestAudit.inputSha256 !== run.inputSha256) {
    return blocker(
      "aggregate_split_child_audit_input_mismatch",
      "independent_audit_passed",
      "독립 AI audit input hash가 최신 run input과 다릅니다.",
    );
  }
  if (child.latestAudit.verdict !== "concur") {
    return blocker(
      "aggregate_split_child_audit_not_concur",
      "independent_audit_passed",
      `독립 AI audit가 concur가 아닙니다: ${child.latestAudit.verdict}`,
    );
  }
  return null;
}

/** Ops가 release 진입 조건 다음의 기존 promotion item과 S12까지 같은 순서로 표시한다. */
export function deriveAggregateSplitPublicationBlocker(
  child: AggregateSplitReleaseChildObservation,
): AggregateSplitPublicationBlocker | null {
  // S12 이후 E-3B-3B가 visible로 전환한 상태도 Ops에서는 완료로 읽는다. release 진입
  // gate 자체는 위 함수에서 여전히 staged만 허용한다.
  const releaseBlocker = deriveAggregateSplitReleaseChildBlocker(
    child.servingState === "visible"
      ? { ...child, servingState: "staged" }
      : child,
  );
  if (releaseBlocker) return releaseBlocker;
  if (child.promotionItemStatus !== "applied") {
    return blocker(
      "aggregate_split_child_promotion_not_applied",
      "publication_complete",
      `promotion release item이 applied가 아닙니다: ${child.promotionItemStatus ?? "missing"}`,
    );
  }
  if (child.publicationReceiptStatus !== "passed") {
    return blocker(
      "aggregate_split_child_publication_not_passed",
      "publication_complete",
      `S12 publication receipt가 passed가 아닙니다: ${
        child.publicationReceiptStatus ?? "missing"
      }`,
    );
  }
  return null;
}

/** S12 다음 원자 노출 전환과 S13/S14까지 Ops에서 같은 순서로 표시한다. */
export function deriveAggregateSplitExposureBlocker(
  child: AggregateSplitReleaseChildObservation,
): AggregateSplitPublicationBlocker | null {
  const publicationBlocker = deriveAggregateSplitPublicationBlocker(child);
  if (publicationBlocker) return publicationBlocker;
  if (child.servingState !== "visible") {
    return blocker(
      "aggregate_split_child_not_visible",
      "serving_complete",
      `노출 전환 전이거나 원복된 child입니다: ${child.servingState ?? "missing"}`,
    );
  }
  if (child.servingReceiptStatus !== "passed") {
    return blocker(
      "aggregate_split_child_serving_not_passed",
      "serving_complete",
      `S13 serving receipt가 passed가 아닙니다: ${
        child.servingReceiptStatus ?? "missing"
      }`,
    );
  }
  if (child.freshnessReceiptStatus !== "passed") {
    return blocker(
      "aggregate_split_child_freshness_not_passed",
      "analysis_fresh",
      `S14 freshness receipt가 passed가 아닙니다: ${
        child.freshnessReceiptStatus ?? "missing"
      }`,
    );
  }
  return null;
}

export function hasExactDeepAnalysisAxisCoverage(
  axes: readonly { dimension: string }[],
): boolean {
  if (axes.length !== CRITERION_DIMENSIONS.length) return false;
  const dimensions = new Set(axes.map((axis) => axis.dimension));
  return dimensions.size === CRITERION_DIMENSIONS.length
    && CRITERION_DIMENSIONS.every((dimension) => dimensions.has(dimension));
}

function blocker(
  code: string,
  stage: DeepAnalysisStageKey | null,
  message: string,
): AggregateSplitPublicationBlocker {
  return { code, stage, message };
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
