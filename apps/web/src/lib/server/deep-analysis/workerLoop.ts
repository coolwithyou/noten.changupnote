import type { CunoteDbSession } from "@/lib/server/db/client";
import type * as schema from "@/lib/server/db/schema";
import { claimDeepAnalysisJob } from "./ledger";
import {
  deferDeepAnalysisJobsForBudget,
  deepAnalysisDailySpendUsd,
  failDeepAnalysisJob,
  releaseDeepAnalysisBudgetJobs,
  writeDeepAnalysisWorkerHeartbeat,
} from "./workerState";
import {
  classifyDeepAnalysisFailure,
  type DeepAnalysisWorkerPolicy,
} from "./workerPolicy";

type DeepAnalysisJob = typeof schema.grantDeepAnalysisJobs.$inferSelect;

export interface DeepAnalysisWorkerInvocationResult {
  claimed: number;
  succeeded: number;
  failed: number;
  budgetDeferred: number;
  releasedBudgetJobs: number;
}

/**
 * Cloud Run invocation의 공통 queue loop. 실제 공고 처리기는 Phase E validator/audit까지
 * 연결된 함수만 주입한다. queue/heartbeat는 외부 호출과 트랜잭션을 공유하지 않는다.
 */
export async function runDeepAnalysisWorkerInvocation(input: {
  db: CunoteDbSession;
  workerId: string;
  serviceRevision: string;
  policy: DeepAnalysisWorkerPolicy;
  processJob: (job: DeepAnalysisJob) => Promise<void>;
  invocationMetadata?: Record<string, unknown>;
  now?: () => Date;
}): Promise<DeepAnalysisWorkerInvocationResult> {
  const now = input.now ?? (() => new Date());
  const result: DeepAnalysisWorkerInvocationResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    budgetDeferred: 0,
    releasedBudgetJobs: await releaseDeepAnalysisBudgetJobs(input.db, now()),
  };
  await writeDeepAnalysisWorkerHeartbeat(input.db, {
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    modelPolicyVersion: input.policy.modelPolicyVersion,
    status: "idle",
    ...(input.invocationMetadata ? { metadata: input.invocationMetadata } : {}),
    now: now(),
  });

  for (let index = 0; index < input.policy.maxJobsPerInvocation; index += 1) {
    const spentUsd = await deepAnalysisDailySpendUsd(input.db, now());
    if (spentUsd >= input.policy.dailyCostCapUsd) {
      result.budgetDeferred += await deferDeepAnalysisJobsForBudget(input.db, now());
      break;
    }
    const job = await claimDeepAnalysisJob(input.db, {
      workerId: input.workerId,
      leaseSeconds: input.policy.leaseSeconds,
      now: now(),
    });
    if (!job) break;
    result.claimed += 1;
    await writeDeepAnalysisWorkerHeartbeat(input.db, {
      workerId: input.workerId,
      serviceRevision: input.serviceRevision,
      modelPolicyVersion: input.policy.modelPolicyVersion,
      status: "running",
      currentJobId: job.id,
      metadata: {
        ...input.invocationMetadata,
        attemptCount: job.attemptCount,
      },
      now: now(),
    });
    try {
      await input.processJob(job);
      result.succeeded += 1;
    } catch (error) {
      const failureClass = classifyDeepAnalysisFailure(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const status = await failDeepAnalysisJob(input.db, {
        job,
        failureClass,
        errorCode: error instanceof Error ? error.name : "DeepAnalysisWorkerError",
        errorMessage,
        now: now(),
      });
      result.failed += 1;
      if (status === "pending_budget") result.budgetDeferred += 1;
      await writeDeepAnalysisWorkerHeartbeat(input.db, {
        workerId: input.workerId,
        serviceRevision: input.serviceRevision,
        modelPolicyVersion: input.policy.modelPolicyVersion,
        status: "degraded",
        currentJobId: job.id,
        lastErrorCode: error instanceof Error ? error.name : "DeepAnalysisWorkerError",
        metadata: {
          ...input.invocationMetadata,
          jobStatus: status,
        },
        now: now(),
      });
    }
  }

  await writeDeepAnalysisWorkerHeartbeat(input.db, {
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    modelPolicyVersion: input.policy.modelPolicyVersion,
    status: "idle",
    metadata: {
      ...input.invocationMetadata,
      ...result,
    },
    now: now(),
  });
  return result;
}
