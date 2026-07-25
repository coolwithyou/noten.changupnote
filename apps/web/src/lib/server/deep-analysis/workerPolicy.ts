import { createHash } from "node:crypto";
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
  executionMode: "active" | "observe_only";
  claimScope: "unconfigured" | "bounded" | "all";
  claimGrantIds: string[];
  claimCohortSha256: string | null;
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
  const claimPolicy = resolveDeepAnalysisClaimPolicy(env);
  return {
    modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
    executionMode: workerExecutionMode(env.DEEP_ANALYSIS_WORKER_MODE),
    ...claimPolicy,
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

export function assertDeepAnalysisClaimScopeConfigured(
  policy: Pick<DeepAnalysisWorkerPolicy, "executionMode" | "claimScope">,
): void {
  if (policy.executionMode === "active" && policy.claimScope === "unconfigured") {
    throw new Error(
      "Active deep analysis requires DEEP_ANALYSIS_CLAIM_SCOPE=bounded or all",
    );
  }
}

export function deepAnalysisClaimCohortSha256(grantIds: readonly string[]): string {
  const canonical = JSON.stringify({
    schema: "deep-analysis-claim-cohort-v1",
    grantIds: [...new Set(grantIds)].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function resolveDeepAnalysisClaimPolicy(
  env: Readonly<Record<string, string | undefined>>,
): Pick<
  DeepAnalysisWorkerPolicy,
  "claimScope" | "claimGrantIds" | "claimCohortSha256"
> {
  const rawScope = env.DEEP_ANALYSIS_CLAIM_SCOPE?.trim();
  if (!rawScope) {
    return {
      claimScope: "unconfigured",
      claimGrantIds: [],
      claimCohortSha256: null,
    };
  }
  if (rawScope === "all") {
    if (
      env.DEEP_ANALYSIS_CLAIM_GRANT_IDS?.trim()
      || env.DEEP_ANALYSIS_CLAIM_COHORT_SHA256?.trim()
    ) {
      throw new Error(
        "DEEP_ANALYSIS_CLAIM_SCOPE=all cannot include bounded cohort IDs or hash",
      );
    }
    return {
      claimScope: "all",
      claimGrantIds: [],
      claimCohortSha256: null,
    };
  }
  if (rawScope !== "bounded") {
    throw new Error("DEEP_ANALYSIS_CLAIM_SCOPE must be bounded or all");
  }
  const grantIds = [...new Set(
    (env.DEEP_ANALYSIS_CLAIM_GRANT_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )].sort();
  if (grantIds.length < 1 || grantIds.length > 100) {
    throw new Error(
      "DEEP_ANALYSIS_CLAIM_GRANT_IDS must contain between 1 and 100 unique UUIDs",
    );
  }
  const invalidGrantId = grantIds.find((value) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  if (invalidGrantId) {
    throw new Error(`DEEP_ANALYSIS_CLAIM_GRANT_IDS contains an invalid UUID: ${invalidGrantId}`);
  }
  const actualSha256 = deepAnalysisClaimCohortSha256(grantIds);
  const expectedSha256 = env.DEEP_ANALYSIS_CLAIM_COHORT_SHA256?.trim().toLowerCase();
  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(
      "DEEP_ANALYSIS_CLAIM_COHORT_SHA256 must be a lowercase SHA-256 for bounded scope",
    );
  }
  if (expectedSha256 !== actualSha256) {
    throw new Error(
      `DEEP_ANALYSIS_CLAIM_COHORT_SHA256 mismatch: expected ${actualSha256}`,
    );
  }
  return {
    claimScope: "bounded",
    claimGrantIds: grantIds,
    claimCohortSha256: actualSha256,
  };
}

function workerExecutionMode(raw: string | undefined): "active" | "observe_only" {
  const value = raw?.trim() || "active";
  if (value !== "active" && value !== "observe_only") {
    throw new Error("DEEP_ANALYSIS_WORKER_MODE must be active or observe_only");
  }
  return value;
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
