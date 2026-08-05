import type { CunoteDb } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  ApplicationPrecomputeLeaseLostError,
  applicationPrecomputeDailySpendUsd,
  claimApplicationPrecomputeJob,
  completeApplicationPrecomputeJob,
  failApplicationPrecomputeJob,
  renewApplicationPrecomputeLease,
  sweepApplicationPrecomputeLeases,
  type ApplicationPrecomputeJob,
  writeApplicationPrecomputeHeartbeat,
} from "./applicationPrecomputeQueue";
import {
  ApplicationPrecomputeProcessingError,
  processApplicationPrecomputeJob,
} from "./applicationPrecomputeProcessor";
import {
  assertApplicationPrecomputePolicyCanExecute,
  type ApplicationPrecomputeWorkerPolicy,
} from "./applicationPrecomputePolicy";

export interface ApplicationPrecomputeWorkerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  budgetStopped: boolean;
  lastErrorCode: string | null;
}

export interface ApplicationPrecomputeWorkerDependencies {
  dailySpend: typeof applicationPrecomputeDailySpendUsd;
  claim: typeof claimApplicationPrecomputeJob;
  complete: typeof completeApplicationPrecomputeJob;
  fail: typeof failApplicationPrecomputeJob;
  heartbeat: typeof writeApplicationPrecomputeHeartbeat;
  process: typeof processApplicationPrecomputeJob;
  sweep: typeof sweepApplicationPrecomputeLeases;
  withLeaseRenewal: typeof runWithApplicationPrecomputeLeaseRenewal;
}

const DEFAULT_DEPENDENCIES: ApplicationPrecomputeWorkerDependencies = {
  dailySpend: applicationPrecomputeDailySpendUsd,
  claim: claimApplicationPrecomputeJob,
  complete: completeApplicationPrecomputeJob,
  fail: failApplicationPrecomputeJob,
  heartbeat: writeApplicationPrecomputeHeartbeat,
  process: processApplicationPrecomputeJob,
  sweep: sweepApplicationPrecomputeLeases,
  withLeaseRenewal: runWithApplicationPrecomputeLeaseRenewal,
};

/** 전용 surface queue의 bounded invocation. 외부 모델 호출은 lease transaction 밖에서 수행한다. */
export async function runApplicationPrecomputeWorkerInvocation(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  apiKey: string;
  workerId: string;
  serviceRevision: string;
  policy: ApplicationPrecomputeWorkerPolicy;
  dependencies?: Partial<ApplicationPrecomputeWorkerDependencies>;
}): Promise<ApplicationPrecomputeWorkerResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  assertApplicationPrecomputePolicyCanExecute(input.policy);
  if (input.policy.executionMode !== "active") {
    throw new Error("Application precompute invocation requires active execution mode");
  }
  const result: ApplicationPrecomputeWorkerResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    budgetStopped: false,
    lastErrorCode: null,
  };
  await dependencies.heartbeat({
    db: input.db,
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    analysisVersion: input.policy.analysisVersion,
    status: "idle",
    metadata: invocationMetadata(input.policy, result),
  });
  for (let index = 0; index < input.policy.maxJobsPerInvocation; index += 1) {
    await dependencies.sweep({
      db: input.db,
      analysisVersion: input.policy.analysisVersion,
    });
    const job = await dependencies.claim({
      db: input.db,
      workerId: input.workerId,
      analysisVersion: input.policy.analysisVersion,
      leaseSeconds: input.policy.leaseSeconds,
      maxConcurrentJobs: input.policy.maxConcurrentJobs,
      dailyCostCapUsd: input.policy.dailyCostCapUsd,
      jobCostReserveUsd: input.policy.jobCostReserveUsd,
      ...(input.policy.claimScope === "bounded"
        ? { claimGrantIds: input.policy.claimGrantIds }
        : {}),
    });
    if (!job) {
      const spentUsd = await dependencies.dailySpend(input.db);
      result.budgetStopped = !canStartApplicationPrecomputeJob({
        spentUsd,
        dailyCostCapUsd: input.policy.dailyCostCapUsd,
        jobCostReserveUsd: input.policy.jobCostReserveUsd,
      });
      break;
    }
    result.claimed += 1;
    await dependencies.heartbeat({
      db: input.db,
      workerId: input.workerId,
      serviceRevision: input.serviceRevision,
      analysisVersion: input.policy.analysisVersion,
      status: "running",
      currentJobId: job.id,
      metadata: invocationMetadata(input.policy, result),
    });
    try {
      const processed = await dependencies.withLeaseRenewal({
        db: input.db,
        job,
        leaseSeconds: input.policy.leaseSeconds,
        run: () => dependencies.process({
          db: input.db,
          storage: input.storage,
          apiKey: input.apiKey,
          job,
          policy: input.policy,
        }),
      });
      await dependencies.complete({
        db: input.db,
        job,
        resultStatus: processed.resultStatus,
        artifactId: processed.artifactId,
        resultSummary: processed.summary,
        requestCount: processed.requestCount,
        inputTokens: processed.inputTokens,
        outputTokens: processed.outputTokens,
        costUsd: processed.costUsd,
      });
      result.succeeded += 1;
    } catch (error) {
      if (error instanceof ApplicationPrecomputeLeaseLostError) {
        result.failed += 1;
        result.lastErrorCode = "lease_lost";
        continue;
      }
      const typed = error instanceof ApplicationPrecomputeProcessingError ? error : null;
      const errorCode = typed?.code ?? (error instanceof Error ? error.name : "application_precompute_failed");
      try {
        await dependencies.fail({
          db: input.db,
          job,
          errorCode,
          errorMessage: error instanceof Error ? error.message : String(error),
          retryable: typed?.retryable ?? true,
          blocked: typed?.blocked ?? false,
        });
      } catch (failError) {
        if (!(failError instanceof ApplicationPrecomputeLeaseLostError)) throw failError;
        result.lastErrorCode = "lease_lost";
      }
      result.failed += 1;
      result.lastErrorCode ??= errorCode;
    }
  }
  await dependencies.heartbeat({
    db: input.db,
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    analysisVersion: input.policy.analysisVersion,
    status: result.failed > 0 ? "degraded" : "idle",
    lastErrorCode: result.lastErrorCode,
    metadata: invocationMetadata(input.policy, result),
  });
  return result;
}

/** 모델 호출 중 짧은 DB 갱신만 반복하고, 소유권을 잃으면 결과 publish를 중단한다. */
export async function runWithApplicationPrecomputeLeaseRenewal<T>(input: {
  db: CunoteDb;
  job: ApplicationPrecomputeJob;
  leaseSeconds: number;
  run: () => Promise<T>;
  renewalIntervalMs?: number;
}): Promise<T> {
  await renewApplicationPrecomputeLease(input);
  const intervalMs = input.renewalIntervalMs
    ?? Math.max(1_000, Math.floor(input.leaseSeconds * 1_000 / 3));
  let renewalFailure: unknown = null;
  let renewalChain = Promise.resolve();
  const timer = setInterval(() => {
    if (renewalFailure) return;
    renewalChain = renewalChain
      .then(() => renewApplicationPrecomputeLease(input))
      .catch((error) => {
        renewalFailure = error;
      });
  }, intervalMs);
  timer.unref();
  try {
    const value = await input.run();
    await renewalChain;
    if (renewalFailure) throw renewalFailure;
    await renewApplicationPrecomputeLease(input);
    return value;
  } finally {
    clearInterval(timer);
    await renewalChain;
  }
}

function invocationMetadata(
  policy: ApplicationPrecomputeWorkerPolicy,
  result: ApplicationPrecomputeWorkerResult,
): Record<string, unknown> {
  return {
    executionMode: policy.executionMode,
    claimScope: policy.claimScope,
    claimCohortCount: policy.claimGrantIds.length,
    model: policy.model,
    transport: "api",
    dailyCostCapUsd: policy.dailyCostCapUsd,
    jobCostReserveUsd: policy.jobCostReserveUsd,
    ...result,
  };
}

/** attempt 원장 비용에 다음 한 건의 보수 reserve까지 더해 claim 가능 여부를 판정한다. */
export function canStartApplicationPrecomputeJob(input: {
  spentUsd: number;
  dailyCostCapUsd: number;
  jobCostReserveUsd: number;
}): boolean {
  return input.spentUsd < input.dailyCostCapUsd
    && input.spentUsd + input.jobCostReserveUsd <= input.dailyCostCapUsd;
}
