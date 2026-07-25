import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";
import {
  classifyDeepAnalysisFailure,
  resolveDeepAnalysisWorkerPolicy,
  retryAvailableAt,
} from "./workerPolicy";
import type { CunoteDbSession } from "@/lib/server/db/client";
import {
  deferDeepAnalysisJobsForBudget,
  isDeepAnalysisHeartbeatStale,
} from "./workerState";

const policy = resolveDeepAnalysisWorkerPolicy({});
assert.equal(policy.modelPolicyVersion, DEEP_ANALYSIS_MODEL_POLICY_VERSION);
assert.equal(policy.primaryModel, "claude-opus-4-8");
assert.equal(policy.auditModel, "claude-sonnet-5");
assert.equal(policy.dailyCostCapUsd, DEEP_ANALYSIS_DEFAULT_LIMITS.dailyCostCapUsd);

assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_PRIMARY_MODEL: "unreviewed-model" }),
  /not allowlisted/,
);
assert.throws(
  () => resolveDeepAnalysisWorkerPolicy({ DEEP_ANALYSIS_MAX_JOBS: "0" }),
  /between 1 and 100/,
);

assert.equal(classifyDeepAnalysisFailure(new Error("Anthropic 529 overloaded")), "retryable");
assert.equal(classifyDeepAnalysisFailure(new Error("daily cost cap reached")), "budget");
assert.equal(classifyDeepAnalysisFailure(new Error("blocked_conversion: hwp")), "input_blocked");
assert.equal(classifyDeepAnalysisFailure(new Error("response contract invalid")), "non_retryable");

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

console.log("deep-analysis worker policy tests passed");
