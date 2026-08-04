import type { CunoteDb } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  applicationPrecomputeDailySpendUsd,
  claimApplicationPrecomputeJob,
  completeApplicationPrecomputeJob,
  failApplicationPrecomputeJob,
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

/** 전용 surface queue의 bounded invocation. 외부 모델 호출은 lease transaction 밖에서 수행한다. */
export async function runApplicationPrecomputeWorkerInvocation(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  apiKey: string;
  workerId: string;
  serviceRevision: string;
  policy: ApplicationPrecomputeWorkerPolicy;
}): Promise<ApplicationPrecomputeWorkerResult> {
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
  await writeApplicationPrecomputeHeartbeat({
    db: input.db,
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    analysisVersion: input.policy.analysisVersion,
    status: "idle",
    metadata: invocationMetadata(input.policy, result),
  });
  for (let index = 0; index < input.policy.maxJobsPerInvocation; index += 1) {
    if (await applicationPrecomputeDailySpendUsd(input.db) >= input.policy.dailyCostCapUsd) {
      result.budgetStopped = true;
      break;
    }
    const job = await claimApplicationPrecomputeJob({
      db: input.db,
      workerId: input.workerId,
      analysisVersion: input.policy.analysisVersion,
      leaseSeconds: input.policy.leaseSeconds,
      maxConcurrentJobs: input.policy.maxConcurrentJobs,
      ...(input.policy.claimScope === "bounded"
        ? { claimGrantIds: input.policy.claimGrantIds }
        : {}),
    });
    if (!job) break;
    result.claimed += 1;
    await writeApplicationPrecomputeHeartbeat({
      db: input.db,
      workerId: input.workerId,
      serviceRevision: input.serviceRevision,
      analysisVersion: input.policy.analysisVersion,
      status: "running",
      currentJobId: job.id,
      metadata: invocationMetadata(input.policy, result),
    });
    try {
      const processed = await processApplicationPrecomputeJob({
        db: input.db,
        storage: input.storage,
        apiKey: input.apiKey,
        job,
        policy: input.policy,
      });
      await completeApplicationPrecomputeJob({
        db: input.db,
        jobId: job.id,
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
      const typed = error instanceof ApplicationPrecomputeProcessingError ? error : null;
      const errorCode = typed?.code ?? (error instanceof Error ? error.name : "application_precompute_failed");
      await failApplicationPrecomputeJob({
        db: input.db,
        job,
        errorCode,
        errorMessage: error instanceof Error ? error.message : String(error),
        retryable: typed?.retryable ?? true,
        blocked: typed?.blocked ?? false,
      });
      result.failed += 1;
      result.lastErrorCode = errorCode;
    }
  }
  await writeApplicationPrecomputeHeartbeat({
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
    ...result,
  };
}
