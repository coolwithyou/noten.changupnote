import type { CunoteDb } from "@/lib/server/db/client";
import {
  createR2ObjectStorageFromEnv,
  type R2ObjectStorage,
} from "@/lib/server/storage/r2ObjectStorage";
import {
  assertApplicationPrecomputePolicyCanExecute,
  resolveApplicationPrecomputeWorkerPolicy,
  type ApplicationPrecomputeWorkerPolicy,
} from "./applicationPrecomputePolicy";
import { writeApplicationPrecomputeHeartbeat } from "./applicationPrecomputeQueue";
import {
  runApplicationPrecomputeWorkerInvocation,
  type ApplicationPrecomputeWorkerDependencies,
  type ApplicationPrecomputeWorkerResult,
} from "./applicationPrecomputeWorker";

export interface ApplicationPrecomputeWorkerCycleResult
  extends ApplicationPrecomputeWorkerResult {
  enabled: boolean;
  executionMode: ApplicationPrecomputeWorkerPolicy["executionMode"] | "disabled";
  analysisVersion: string | null;
}

/**
 * 기존 Cloud Run execution 안에서 전용 Kordoc queue를 한 번만 처리한다.
 * 명시적 execute flag가 없으면 heartbeat를 포함한 어떤 DB mutation도 만들지 않는다.
 */
export async function runApplicationPrecomputeWorkerCycle(input: {
  db: CunoteDb;
  workerId: string;
  serviceRevision: string;
  env?: Readonly<Record<string, string | undefined>>;
  execute?: boolean;
  storage?: R2ObjectStorage | null;
  dependencies?: Partial<ApplicationPrecomputeWorkerDependencies>;
  heartbeat?: typeof writeApplicationPrecomputeHeartbeat;
}): Promise<ApplicationPrecomputeWorkerCycleResult> {
  const env = input.env ?? process.env;
  const execute = input.execute ?? env.APPLICATION_PRECOMPUTE_EXECUTE?.trim() === "1";
  if (!execute) {
    return {
      enabled: false,
      executionMode: "disabled",
      analysisVersion: null,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      budgetStopped: false,
      lastErrorCode: null,
    };
  }

  const policy = resolveApplicationPrecomputeWorkerPolicy(env);
  const result: ApplicationPrecomputeWorkerResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    budgetStopped: false,
    lastErrorCode: null,
  };
  if (policy.executionMode === "observe_only") {
    const heartbeat = input.heartbeat ?? writeApplicationPrecomputeHeartbeat;
    await heartbeat({
      db: input.db,
      workerId: input.workerId,
      serviceRevision: input.serviceRevision,
      analysisVersion: policy.analysisVersion,
      status: "idle",
      metadata: {
        executionMode: policy.executionMode,
        claimScope: policy.claimScope,
        claimCohortCount: policy.claimGrantIds.length,
        model: policy.model,
        transport: "api",
        enqueueSkipped: true,
        analysisSkipped: true,
        budgetMutationSkipped: true,
        ...result,
      },
    });
    return {
      enabled: true,
      executionMode: policy.executionMode,
      analysisVersion: policy.analysisVersion,
      ...result,
    };
  }

  assertApplicationPrecomputePolicyCanExecute(policy);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const storage = input.storage ?? createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 storage environment is incomplete");
  const invocation = await runApplicationPrecomputeWorkerInvocation({
    db: input.db,
    storage,
    apiKey,
    workerId: input.workerId,
    serviceRevision: input.serviceRevision,
    policy,
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
  return {
    enabled: true,
    executionMode: policy.executionMode,
    analysisVersion: policy.analysisVersion,
    ...invocation,
  };
}
