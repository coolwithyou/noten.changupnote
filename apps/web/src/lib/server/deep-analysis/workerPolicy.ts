import {
  DEEP_ANALYSIS_AUDIT_MODELS,
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  DEEP_ANALYSIS_PRIMARY_MODELS,
  assertDeepAnalysisModelPair,
  type DeepAnalysisAuditModel,
  type DeepAnalysisPrimaryModel,
} from "@cunote/contracts";

export interface DeepAnalysisWorkerPolicy {
  modelPolicyVersion: typeof DEEP_ANALYSIS_MODEL_POLICY_VERSION;
  primaryModel: DeepAnalysisPrimaryModel;
  auditModel: DeepAnalysisAuditModel;
  leaseSeconds: number;
  maxJobsPerInvocation: number;
  maxConcurrentJobs: number;
  maxEnqueuePerInvocation: number;
  dailyCostCapUsd: number;
  perNoticeCostCapUsd: number;
  maxTotalInputChars: number;
  heartbeatStaleSeconds: number;
}

export function resolveDeepAnalysisWorkerPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeepAnalysisWorkerPolicy {
  const pair = {
    primaryModel: env.DEEP_ANALYSIS_PRIMARY_MODEL?.trim() || DEEP_ANALYSIS_PRIMARY_MODELS[0],
    auditModel: env.DEEP_ANALYSIS_AUDIT_MODEL?.trim() || DEEP_ANALYSIS_AUDIT_MODELS[0],
  };
  assertDeepAnalysisModelPair(pair);
  return {
    modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
    ...pair,
    leaseSeconds: integerEnv(
      env.DEEP_ANALYSIS_LEASE_SECONDS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.leaseSeconds,
      30,
      3_600,
      "DEEP_ANALYSIS_LEASE_SECONDS",
    ),
    maxJobsPerInvocation: integerEnv(
      env.DEEP_ANALYSIS_MAX_JOBS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.maxJobsPerInvocation,
      1,
      100,
      "DEEP_ANALYSIS_MAX_JOBS",
    ),
    maxConcurrentJobs: integerEnv(
      env.DEEP_ANALYSIS_MAX_CONCURRENT_JOBS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.maxConcurrentJobs,
      1,
      10,
      "DEEP_ANALYSIS_MAX_CONCURRENT_JOBS",
    ),
    maxEnqueuePerInvocation: integerEnv(
      env.DEEP_ANALYSIS_MAX_ENQUEUE_JOBS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.maxEnqueuePerInvocation,
      1,
      100,
      "DEEP_ANALYSIS_MAX_ENQUEUE_JOBS",
    ),
    dailyCostCapUsd: numberEnv(
      env.DEEP_ANALYSIS_DAILY_COST_CAP_USD,
      DEEP_ANALYSIS_DEFAULT_LIMITS.dailyCostCapUsd,
      0.01,
      100_000,
      "DEEP_ANALYSIS_DAILY_COST_CAP_USD",
    ),
    perNoticeCostCapUsd: numberEnv(
      env.DEEP_ANALYSIS_PER_NOTICE_COST_CAP_USD,
      DEEP_ANALYSIS_DEFAULT_LIMITS.perNoticeCostCapUsd,
      0.01,
      1_000,
      "DEEP_ANALYSIS_PER_NOTICE_COST_CAP_USD",
    ),
    maxTotalInputChars: integerEnv(
      env.DEEP_ANALYSIS_MAX_TOTAL_INPUT_CHARS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
      60_000,
      5_000_000,
      "DEEP_ANALYSIS_MAX_TOTAL_INPUT_CHARS",
    ),
    heartbeatStaleSeconds: integerEnv(
      env.DEEP_ANALYSIS_HEARTBEAT_STALE_SECONDS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.heartbeatStaleSeconds,
      60,
      3_600,
      "DEEP_ANALYSIS_HEARTBEAT_STALE_SECONDS",
    ),
  };
}

export type DeepAnalysisFailureClass =
  | "retryable"
  | "non_retryable"
  | "budget"
  | "input_blocked";

export function classifyDeepAnalysisFailure(error: unknown): DeepAnalysisFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:429|500|502|503|504|529)\b|timeout|timed out|ECONNRESET|EAI_AGAIN/i.test(message)) {
    return "retryable";
  }
  if (/daily cost cap|per-notice cost cap|pending_budget/i.test(message)) return "budget";
  if (/input (?:is )?not sealed|blocked_(?:fetch|conversion|cap)|unresolved attachment/i.test(message)) {
    return "input_blocked";
  }
  return "non_retryable";
}

export function resolveDeepAnalysisOperationalErrorCode(input: {
  error: unknown;
  failureClass: DeepAnalysisFailureClass;
  runErrorCode?: string | null;
}): string {
  const runErrorCode = input.runErrorCode?.trim();
  if (runErrorCode) return runErrorCode.slice(0, 120);
  const message = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  if (/source revision changed/i.test(message)) return "source_revision_changed";
  if (/input (?:is )?not sealed|blocked_(?:fetch|conversion|cap)|unresolved attachment/i.test(message)) {
    return "input_not_sealed";
  }
  if (input.failureClass === "budget") return "pending_budget";
  if (input.failureClass === "retryable") return "provider_retryable";
  return "worker_unhandled_failure";
}

export function retryAvailableAt(attemptCount: number, now: Date = new Date()): Date {
  const boundedAttempt = Math.min(Math.max(attemptCount, 1), 10);
  const delaySeconds = Math.min(3_600, 30 * 2 ** (boundedAttempt - 1));
  return new Date(now.getTime() + delaySeconds * 1_000);
}

function integerEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return value;
}
