import assert from "node:assert/strict";
import {
  evaluateDeepAnalysisServingCloudObservation,
  type DeepAnalysisServingCloudRunExecution,
  type DeepAnalysisServingSchedulerConfig,
  type DeepAnalysisServingSchedulerLog,
} from "./servingObservationCloud";

const start = new Date("2026-07-25T03:05:00.000Z");
const end = new Date("2026-07-25T04:05:00.000Z");
const scheduler: DeepAnalysisServingSchedulerConfig = {
  state: "ENABLED",
  schedule: "5,35 * * * *",
  timeZone: "Asia/Seoul",
  retryCount: 0,
  maxRetryDuration: "0s",
  targetUri: "https://run.example.invalid/jobs/monitor:run",
  oauthServiceAccount: "monitor@example.invalid",
};
const schedulerLogs: DeepAnalysisServingSchedulerLog[] = [
  ...buildSchedulerLogs(start),
  ...buildSchedulerLogs(new Date(start.getTime() + (30 * 60 * 1_000))),
];
const executions: DeepAnalysisServingCloudRunExecution[] = [
  buildExecution("execution-slot-1", start),
  buildExecution("execution-slot-2", new Date(start.getTime() + (30 * 60 * 1_000))),
];

const passed = evaluateDeepAnalysisServingCloudObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  account: "sw@noten.im",
  expectedAccount: "sw@noten.im",
  project: "changupnote-com",
  expectedProject: "changupnote-com",
  scheduler,
  expectedScheduler: scheduler,
  schedulerLogs,
  executions,
  receiptExecutionIds: executions.map((execution) => execution.name),
});
assert.equal(passed.verdict, "PASS");
assert.equal(passed.expectedSlots, 2);
assert.equal(passed.evaluatedSlots, 2);
assert.equal(passed.schedulerStarts, 2);
assert.equal(passed.schedulerFinishes, 2);
assert.equal(passed.successfulExecutions, 2);
assert.equal(passed.receiptMatchedExecutions, 2);
assert.deepEqual(passed.failures, []);

const progress = evaluateDeepAnalysisServingCloudObservation({
  start,
  end,
  now: new Date(start.getTime() + 60_000),
  account: "sw@noten.im",
  expectedAccount: "sw@noten.im",
  project: "changupnote-com",
  expectedProject: "changupnote-com",
  scheduler,
  expectedScheduler: scheduler,
  schedulerLogs: schedulerLogs.slice(0, 2),
  executions: executions.slice(0, 1),
  receiptExecutionIds: ["execution-slot-1"],
});
assert.equal(progress.verdict, "PASS");
assert.equal(progress.evaluatedSlots, 1);
assert.equal(progress.successfulExecutions, 1);

const missingSecondSlot = evaluateDeepAnalysisServingCloudObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  account: "sw@noten.im",
  expectedAccount: "sw@noten.im",
  project: "changupnote-com",
  expectedProject: "changupnote-com",
  scheduler,
  expectedScheduler: scheduler,
  schedulerLogs: schedulerLogs.slice(0, 2),
  executions: executions.slice(0, 1),
  receiptExecutionIds: ["execution-slot-1"],
});
assert.equal(missingSecondSlot.verdict, "FAIL");
assert.equal(
  missingSecondSlot.failures.some((failure) => failure.code === "scheduler_start_missing"),
  true,
);
assert.equal(
  missingSecondSlot.failures.some((failure) => failure.code === "cloud_run_execution_missing"),
  true,
);

const wrongAccountAndMissingReceipt = evaluateDeepAnalysisServingCloudObservation({
  start,
  end,
  now: new Date(end.getTime() + 1_000),
  account: "sw@ba-ton.kr",
  expectedAccount: "sw@noten.im",
  project: "changupnote-com",
  expectedProject: "changupnote-com",
  scheduler,
  expectedScheduler: scheduler,
  schedulerLogs,
  executions,
  receiptExecutionIds: ["execution-slot-1"],
});
assert.equal(wrongAccountAndMissingReceipt.verdict, "FAIL");
assert.equal(
  wrongAccountAndMissingReceipt.failures.some((failure) =>
    failure.code === "gcloud_account_mismatch"),
  true,
);
assert.equal(
  wrongAccountAndMissingReceipt.failures.some((failure) =>
    failure.code === "cloud_run_receipt_execution_mismatch"),
  true,
);

console.log("deep-analysis serving cloud observation tests passed");

function buildSchedulerLogs(slot: Date): DeepAnalysisServingSchedulerLog[] {
  return [
    {
      type: "started",
      timestamp: new Date(slot.getTime() + 9_000),
      scheduledTime: new Date(slot.getTime() + 4_000),
      httpStatus: null,
    },
    {
      type: "finished",
      timestamp: new Date(slot.getTime() + 8_000),
      scheduledTime: null,
      httpStatus: 200,
    },
  ];
}

function buildExecution(
  name: string,
  slot: Date,
): DeepAnalysisServingCloudRunExecution {
  return {
    name,
    startTime: new Date(slot.getTime() + 7_000),
    completionTime: new Date(slot.getTime() + 25_000),
    succeededCount: 1,
    failedCount: 0,
    completed: true,
  };
}
