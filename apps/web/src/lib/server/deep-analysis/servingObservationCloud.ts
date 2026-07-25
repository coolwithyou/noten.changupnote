export interface DeepAnalysisServingSchedulerConfig {
  state: string | null;
  schedule: string | null;
  timeZone: string | null;
  retryCount: number;
  maxRetryDuration: string | null;
  targetUri: string | null;
  oauthServiceAccount: string | null;
}

export interface DeepAnalysisServingSchedulerLog {
  type: "started" | "finished";
  timestamp: Date;
  scheduledTime: Date | null;
  httpStatus: number | null;
}

export interface DeepAnalysisServingCloudRunExecution {
  name: string;
  startTime: Date;
  completionTime: Date | null;
  succeededCount: number;
  failedCount: number;
  completed: boolean;
}

export interface DeepAnalysisServingCloudFailure {
  code:
    | "gcloud_account_mismatch"
    | "gcloud_project_mismatch"
    | "scheduler_config_mismatch"
    | "scheduler_start_missing"
    | "scheduler_start_duplicate"
    | "scheduler_finish_missing"
    | "scheduler_finish_duplicate"
    | "scheduler_http_failed"
    | "cloud_run_execution_missing"
    | "cloud_run_execution_duplicate"
    | "cloud_run_execution_failed"
    | "cloud_run_execution_slow"
    | "cloud_run_receipt_execution_mismatch";
  detail: string;
  slot?: string;
  executionId?: string;
}

export interface DeepAnalysisServingCloudEvaluation {
  schema: "deep-analysis-serving-cloud-observation-v1";
  verdict: "PASS" | "FAIL";
  account: string;
  project: string;
  expectedSlots: number;
  evaluatedSlots: number;
  schedulerStarts: number;
  schedulerFinishes: number;
  successfulExecutions: number;
  receiptMatchedExecutions: number;
  matchedExecutionIds: string[];
  failures: DeepAnalysisServingCloudFailure[];
}

export function evaluateDeepAnalysisServingCloudObservation(input: {
  start: Date;
  end: Date;
  now?: Date;
  cadenceMs?: number;
  maximumStartDelayMs?: number;
  maximumCompletionDelayMs?: number;
  account: string;
  expectedAccount: string;
  project: string;
  expectedProject: string;
  scheduler: DeepAnalysisServingSchedulerConfig;
  expectedScheduler: DeepAnalysisServingSchedulerConfig;
  schedulerLogs: DeepAnalysisServingSchedulerLog[];
  executions: DeepAnalysisServingCloudRunExecution[];
  receiptExecutionIds: string[];
}): DeepAnalysisServingCloudEvaluation {
  const now = input.now ?? new Date();
  const cadenceMs = input.cadenceMs ?? 30 * 60 * 1_000;
  const maximumStartDelayMs = input.maximumStartDelayMs ?? 5 * 60 * 1_000;
  const maximumCompletionDelayMs = input.maximumCompletionDelayMs ?? 10 * 60 * 1_000;
  const failures: DeepAnalysisServingCloudFailure[] = [];
  const durationMs = input.end.getTime() - input.start.getTime();
  const slots = durationMs > 0 && durationMs % cadenceMs === 0
    ? Array.from(
      { length: durationMs / cadenceMs },
      (_, index) => new Date(input.start.getTime() + (index * cadenceMs)),
    )
    : [];

  if (input.account !== input.expectedAccount) {
    failures.push({
      code: "gcloud_account_mismatch",
      detail: `account=${input.account} expected=${input.expectedAccount}`,
    });
  }
  if (input.project !== input.expectedProject) {
    failures.push({
      code: "gcloud_project_mismatch",
      detail: `project=${input.project} expected=${input.expectedProject}`,
    });
  }
  for (const [key, expected] of Object.entries(input.expectedScheduler)) {
    const actual = input.scheduler[key as keyof DeepAnalysisServingSchedulerConfig];
    if (actual !== expected) {
      failures.push({
        code: "scheduler_config_mismatch",
        detail: `${key}=${String(actual)} expected=${String(expected)}`,
      });
    }
  }

  let evaluatedSlots = 0;
  let schedulerStarts = 0;
  let schedulerFinishes = 0;
  let successfulExecutions = 0;
  let receiptMatchedExecutions = 0;
  const matchedExecutionIds: string[] = [];
  const receiptExecutionIds = new Set(input.receiptExecutionIds);

  for (const slot of slots) {
    if (slot.getTime() > now.getTime()) continue;
    evaluatedSlots += 1;
    const startDeadline = slot.getTime() + maximumStartDelayMs;
    const completionDeadline = slot.getTime() + maximumCompletionDelayMs;
    const schedulerStartCandidates = input.schedulerLogs.filter((entry) =>
      entry.type === "started"
      && entry.scheduledTime !== null
      && entry.scheduledTime.getTime() >= slot.getTime()
      && entry.scheduledTime.getTime() < startDeadline);
    if (schedulerStartCandidates.length === 0) {
      if (now.getTime() >= startDeadline) {
        failures.push({
          code: "scheduler_start_missing",
          detail: "no Cloud Scheduler AttemptStarted entry for slot",
          slot: slot.toISOString(),
        });
      }
    } else if (schedulerStartCandidates.length > 1) {
      failures.push({
        code: "scheduler_start_duplicate",
        detail: `found ${schedulerStartCandidates.length} AttemptStarted entries`,
        slot: slot.toISOString(),
      });
    } else {
      schedulerStarts += 1;
    }

    const schedulerFinishCandidates = input.schedulerLogs.filter((entry) =>
      entry.type === "finished"
      && entry.timestamp.getTime() >= slot.getTime()
      && entry.timestamp.getTime() < startDeadline);
    if (schedulerFinishCandidates.length === 0) {
      if (now.getTime() >= startDeadline) {
        failures.push({
          code: "scheduler_finish_missing",
          detail: "no Cloud Scheduler AttemptFinished entry for slot",
          slot: slot.toISOString(),
        });
      }
    } else if (schedulerFinishCandidates.length > 1) {
      failures.push({
        code: "scheduler_finish_duplicate",
        detail: `found ${schedulerFinishCandidates.length} AttemptFinished entries`,
        slot: slot.toISOString(),
      });
    } else {
      schedulerFinishes += 1;
      if (schedulerFinishCandidates[0]!.httpStatus !== 200) {
        failures.push({
          code: "scheduler_http_failed",
          detail: `scheduler HTTP status=${String(schedulerFinishCandidates[0]!.httpStatus)}`,
          slot: slot.toISOString(),
        });
      }
    }

    const executionCandidates = input.executions.filter((execution) =>
      execution.startTime.getTime() >= slot.getTime()
      && execution.startTime.getTime() < startDeadline);
    if (executionCandidates.length === 0) {
      if (now.getTime() >= startDeadline) {
        failures.push({
          code: "cloud_run_execution_missing",
          detail: "no Cloud Run Job execution started for slot",
          slot: slot.toISOString(),
        });
      }
      continue;
    }
    if (executionCandidates.length > 1) {
      failures.push({
        code: "cloud_run_execution_duplicate",
        detail: `found ${executionCandidates.length} Cloud Run executions`,
        slot: slot.toISOString(),
      });
      continue;
    }

    const execution = executionCandidates[0]!;
    matchedExecutionIds.push(execution.name);
    if (
      execution.completed
      && execution.succeededCount === 1
      && execution.failedCount === 0
    ) {
      successfulExecutions += 1;
    } else if (now.getTime() >= completionDeadline) {
      failures.push({
        code: "cloud_run_execution_failed",
        detail: `completed=${execution.completed} succeeded=${execution.succeededCount} failed=${execution.failedCount}`,
        slot: slot.toISOString(),
        executionId: execution.name,
      });
    }
    if (
      execution.completionTime
      && execution.completionTime.getTime() >= completionDeadline
    ) {
      failures.push({
        code: "cloud_run_execution_slow",
        detail: `completion=${execution.completionTime.toISOString()}`,
        slot: slot.toISOString(),
        executionId: execution.name,
      });
    }
    if (receiptExecutionIds.has(execution.name)) {
      receiptMatchedExecutions += 1;
    } else if (now.getTime() >= completionDeadline) {
      failures.push({
        code: "cloud_run_receipt_execution_mismatch",
        detail: "Cloud Run execution ID is absent from DB/R2 scheduled receipts",
        slot: slot.toISOString(),
        executionId: execution.name,
      });
    }
  }

  return {
    schema: "deep-analysis-serving-cloud-observation-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    account: input.account,
    project: input.project,
    expectedSlots: slots.length,
    evaluatedSlots,
    schedulerStarts,
    schedulerFinishes,
    successfulExecutions,
    receiptMatchedExecutions,
    matchedExecutionIds: matchedExecutionIds.sort(),
    failures,
  };
}
