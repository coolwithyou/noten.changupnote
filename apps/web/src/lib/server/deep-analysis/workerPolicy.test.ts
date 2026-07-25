import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";
import {
  classifyDeepAnalysisFailure,
  resolveDeepAnalysisOperationalErrorCode,
  resolveDeepAnalysisWorkerPolicy,
  retryAvailableAt,
} from "./workerPolicy";
import { resolveFinalDeepAnalysisWorkerHeartbeat } from "./workerLoop";
import type { CunoteDbSession } from "@/lib/server/db/client";
import {
  deferDeepAnalysisJobsForBudget,
  isDeepAnalysisHeartbeatStale,
  repairGenericDeepAnalysisJobErrorCodes,
} from "./workerState";

const policy = resolveDeepAnalysisWorkerPolicy({});
assert.equal(policy.modelPolicyVersion, DEEP_ANALYSIS_MODEL_POLICY_VERSION);
assert.equal(policy.executionMode, "active");
assert.equal(policy.primaryModel, "claude-opus-4-8");
assert.equal(policy.auditModel, "claude-sonnet-5");
assert.equal(policy.dailyCostCapUsd, DEEP_ANALYSIS_DEFAULT_LIMITS.dailyCostCapUsd);
assert.equal(policy.maxConcurrentJobs, 1);
assert.equal(policy.maxEnqueuePerInvocation, DEEP_ANALYSIS_DEFAULT_LIMITS.maxEnqueuePerInvocation);

assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_PRIMARY_MODEL: "unreviewed-model" }),
  /not allowlisted/,
);
assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_MAX_JOBS: "0" }),
  /between 1 and 100/,
);
assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_MAX_ENQUEUE_JOBS: "101" }),
  /between 1 and 100/,
);
assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_MAX_CONCURRENT_JOBS: "0" }),
  /between 1 and 10/,
);
assert.equal(
  resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_WORKER_MODE: "observe_only" }).executionMode,
  "observe_only",
);
assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_WORKER_MODE: "paused" }),
  /active or observe_only/,
);

assert.equal(classifyDeepAnalysisFailure(new Error("Anthropic 529 overloaded")), "retryable");
assert.equal(classifyDeepAnalysisFailure(new Error("daily cost cap reached")), "budget");
assert.equal(classifyDeepAnalysisFailure(new Error("blocked_conversion: hwp")), "input_blocked");
assert.equal(classifyDeepAnalysisFailure(new Error("response contract invalid")), "non_retryable");
assert.equal(resolveDeepAnalysisOperationalErrorCode({
  error: new Error("generic wrapper"),
  failureClass: "non_retryable",
  runErrorCode: "independent_audit_disagreement",
}), "independent_audit_disagreement");
assert.equal(resolveDeepAnalysisOperationalErrorCode({
  error: new Error("Deep analysis input is not sealed: blocked_conversion"),
  failureClass: "input_blocked",
}), "input_not_sealed");
assert.equal(resolveDeepAnalysisOperationalErrorCode({
  error: new Error("Anthropic 529 overloaded"),
  failureClass: "retryable",
}), "provider_retryable");
assert.equal(resolveDeepAnalysisOperationalErrorCode({
  error: new Error("source revision changed"),
  failureClass: "input_blocked",
}), "source_revision_changed");
assert.deepEqual(resolveFinalDeepAnalysisWorkerHeartbeat({
  claimed: 1,
  succeeded: 0,
  failed: 1,
  budgetDeferred: 0,
  releasedBudgetJobs: 0,
  lastFailure: {
    jobId: "job-failed",
    errorCode: "independent_audit_disagreement",
    jobStatus: "dead_letter",
    failureClass: "non_retryable",
  },
}), {
  status: "degraded",
  lastErrorCode: "independent_audit_disagreement",
});
assert.deepEqual(resolveFinalDeepAnalysisWorkerHeartbeat({
  claimed: 0,
  succeeded: 0,
  failed: 0,
  budgetDeferred: 0,
  releasedBudgetJobs: 0,
  lastFailure: null,
}), {
  status: "idle",
  lastErrorCode: null,
});

const base = new Date("2026-07-25T00:00:00.000Z");
assert.equal(retryAvailableAt(1, base).toISOString(), "2026-07-25T00:00:30.000Z");
assert.equal(retryAvailableAt(5, base).toISOString(), "2026-07-25T00:08:00.000Z");
assert.equal(retryAvailableAt(20, base).toISOString(), "2026-07-25T01:00:00.000Z");

assert.equal(
  isDeepAnalysisHeartbeatStale(
    new Date("2026-07-25T00:00:00.000Z"),
    600,
    new Date("2026-07-25T00:10:01.000Z"),
  ),
  true,
);
assert.equal(
  isDeepAnalysisHeartbeatStale(
    new Date("2026-07-25T00:00:00.000Z"),
    600,
    new Date("2026-07-25T00:10:00.000Z"),
  ),
  false,
);

let budgetSqlCalls = 0;
const budgetDb = {
  execute: async () => {
    budgetSqlCalls += 1;
    return [{ id: "job-1" }, { id: "job-2" }];
  },
} as unknown as CunoteDbSession;
assert.equal(
  await deferDeepAnalysisJobsForBudget(budgetDb, new Date("2026-07-25T00:00:00.000Z")),
  2,
);
assert.equal(budgetSqlCalls, 1);

let repairSqlCalls = 0;
const repairDb = {
  execute: async () => {
    repairSqlCalls += 1;
    return [{ id: "job-1" }];
  },
} as unknown as CunoteDbSession;
assert.equal(await repairGenericDeepAnalysisJobErrorCodes(repairDb), 1);
assert.equal(repairSqlCalls, 1);

console.log("deep-analysis worker policy tests passed");
