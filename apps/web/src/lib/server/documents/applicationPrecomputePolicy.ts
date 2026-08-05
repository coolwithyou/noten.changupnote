import { VERSION as KORDOC_VERSION } from "kordoc";
import { APPLICATION_ROUNDTRIP_VERSION } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { ROUNDTRIP_FIELD_CANDIDATE_LIMIT } from "@/lib/server/analysis-lab/application-roundtrip/field-planner";
import { buildApplicationPrecomputeAnalysisVersion } from "./applicationPrecomputeMaterialization";
import { APPLICATION_PRECOMPUTE_ENGINE } from "./applicationPrecomputeState";

export interface ApplicationPrecomputeWorkerPolicy {
  executionMode: "active" | "observe_only";
  claimScope: "unconfigured" | "bounded" | "all";
  claimGrantIds: string[];
  analysisVersion: string;
  model: string;
  timeoutMs: number;
  candidateConcurrency: number;
  leaseSeconds: number;
  maxJobsPerInvocation: number;
  maxConcurrentJobs: number;
  dailyCostCapUsd: number;
  jobCostReserveUsd: number;
}

export function resolveApplicationPrecomputeWorkerPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApplicationPrecomputeWorkerPolicy {
  const model = env.APPLICATION_PRECOMPUTE_MODEL?.trim() || "claude-sonnet-5";
  const claimGrantIds = uniqueUuids(env.APPLICATION_PRECOMPUTE_CLAIM_GRANT_IDS);
  const claimScope = resolveClaimScope(env.APPLICATION_PRECOMPUTE_CLAIM_SCOPE, claimGrantIds);
  return {
    executionMode: env.APPLICATION_PRECOMPUTE_WORKER_MODE?.trim() === "active"
      ? "active"
      : "observe_only",
    claimScope,
    claimGrantIds,
    analysisVersion: buildApplicationPrecomputeAnalysisVersion({
      contractVersion: APPLICATION_ROUNDTRIP_VERSION,
      engine: "kordoc",
      engineVersion: KORDOC_VERSION,
      transport: "api",
      requestedModel: model,
      candidateLimit: ROUNDTRIP_FIELD_CANDIDATE_LIMIT,
    }),
    model,
    timeoutMs: integerEnv(env.APPLICATION_PRECOMPUTE_TIMEOUT_MS, 180_000, 10_000, 900_000),
    candidateConcurrency: integerEnv(env.APPLICATION_PRECOMPUTE_CANDIDATE_CONCURRENCY, 1, 1, 2),
    leaseSeconds: integerEnv(env.APPLICATION_PRECOMPUTE_LEASE_SECONDS, 900, 30, 3_600),
    maxJobsPerInvocation: integerEnv(env.APPLICATION_PRECOMPUTE_MAX_JOBS, 2, 1, 25),
    maxConcurrentJobs: integerEnv(env.APPLICATION_PRECOMPUTE_MAX_CONCURRENT_JOBS, 1, 1, 2),
    dailyCostCapUsd: numberEnv(env.APPLICATION_PRECOMPUTE_DAILY_COST_CAP_USD, 2, 0.01, 1_000),
    jobCostReserveUsd: numberEnv(env.APPLICATION_PRECOMPUTE_JOB_COST_RESERVE_USD, 0.5, 0.01, 100),
  };
}

export function assertApplicationPrecomputePolicyCanExecute(
  policy: ApplicationPrecomputeWorkerPolicy,
): void {
  if (policy.executionMode === "active" && policy.claimScope === "unconfigured") {
    throw new Error(
      "Active application precompute requires APPLICATION_PRECOMPUTE_CLAIM_SCOPE=bounded or all",
    );
  }
}

export const APPLICATION_PRECOMPUTE_WORKER_ENGINE = APPLICATION_PRECOMPUTE_ENGINE;

function resolveClaimScope(
  raw: string | undefined,
  grantIds: readonly string[],
): ApplicationPrecomputeWorkerPolicy["claimScope"] {
  const value = raw?.trim();
  if (!value) return grantIds.length > 0 ? "bounded" : "unconfigured";
  if (value === "all") return "all";
  if (value === "bounded" && grantIds.length > 0) return "bounded";
  throw new Error("APPLICATION_PRECOMPUTE_CLAIM_SCOPE must be all or bounded with grant IDs");
}

function uniqueUuids(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (values.some((value) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value))) {
    throw new Error("APPLICATION_PRECOMPUTE_CLAIM_GRANT_IDS contains an invalid UUID");
  }
  return values;
}

function integerEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim() ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Application precompute integer policy must be between ${min} and ${max}`);
  }
  return value;
}

function numberEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Application precompute numeric policy must be between ${min} and ${max}`);
  }
  return value;
}
