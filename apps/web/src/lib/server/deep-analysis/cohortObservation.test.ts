import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_COHORT_REQUIRED_STAGES,
  evaluateDeepAnalysisCohortObservation,
  type DeepAnalysisCohortObservationItem,
} from "./cohortObservation";

const revision = "a".repeat(64);
const inputSha256 = "b".repeat(64);

function item(
  override: Partial<DeepAnalysisCohortObservationItem> = {},
): DeepAnalysisCohortObservationItem {
  return {
    grantId: "11111111-1111-4111-8111-111111111111",
    source: "bizinfo",
    sourceId: "PBLN_TEST",
    active: true,
    hasHwp: true,
    jobId: "22222222-2222-4222-8222-222222222222",
    jobStatus: "pending",
    jobSourceRevisionSha256: revision,
    runId: null,
    runStatus: null,
    runSourceRevisionSha256: null,
    runInputSha256: null,
    runStartedAt: null,
    runCompletedAt: null,
    stageStatuses: {},
    axisCount: 0,
    auditVerdict: null,
    currentInputSealed: true,
    currentSourceRevisionSha256: revision,
    currentInputSha256: inputSha256,
    currentInputBlockerCodes: [],
    currentInputVerificationError: null,
    costUsdSinceActivation: 0,
    ...override,
  };
}

const common = {
  activatedAt: new Date("2026-07-26T03:05:00.000Z"),
  now: new Date("2026-07-26T03:06:00.000Z"),
  claimCohortSha256: "c".repeat(64),
  expectedCount: 1,
  outOfCohortRunCount: 0,
};

const pending = evaluateDeepAnalysisCohortObservation({
  ...common,
  items: [item()],
});
assert.equal(pending.verdict, "IN_PROGRESS");
assert.equal(pending.pendingCount, 1);
assert.deepEqual(pending.failures, []);

const inconsistentPassedRun = evaluateDeepAnalysisCohortObservation({
  ...common,
  items: [item({
    jobStatus: "succeeded",
    runId: "33333333-3333-4333-8333-333333333333",
    runStatus: "passed",
    runSourceRevisionSha256: revision,
    runInputSha256: inputSha256,
  })],
});
assert.equal(inconsistentPassedRun.verdict, "FAIL");
assert(inconsistentPassedRun.failures.includes(
  "passed_run_without_analysis_complete:11111111-1111-4111-8111-111111111111",
));
assert(inconsistentPassedRun.failures.includes(
  "succeeded_job_without_analysis_complete:11111111-1111-4111-8111-111111111111",
));

const passedStatuses = Object.fromEntries(
  DEEP_ANALYSIS_COHORT_REQUIRED_STAGES.map((stage) => [stage, "passed"]),
);
const passed = evaluateDeepAnalysisCohortObservation({
  ...common,
  items: [item({
    jobStatus: "succeeded",
    runId: "33333333-3333-4333-8333-333333333333",
    runStatus: "passed",
    runSourceRevisionSha256: revision,
    runInputSha256: inputSha256,
    runStartedAt: new Date("2026-07-26T03:05:00.000Z"),
    runCompletedAt: new Date("2026-07-26T03:05:45.000Z"),
    stageStatuses: passedStatuses,
    axisCount: 22,
    auditVerdict: "concur",
    costUsdSinceActivation: 0.75,
  })],
});
assert.equal(passed.verdict, "PASS");
assert.equal(passed.analysisCompleteCount, 1);
assert.equal(passed.analysisLatencySeconds.p95, 45);

const passedBeforeActivation = evaluateDeepAnalysisCohortObservation({
  ...common,
  items: [item({
    jobStatus: "succeeded",
    runId: "33333333-3333-4333-8333-333333333333",
    runStatus: "passed",
    runSourceRevisionSha256: revision,
    runInputSha256: inputSha256,
    runStartedAt: new Date("2026-07-26T03:04:59.000Z"),
    runCompletedAt: new Date("2026-07-26T03:05:44.000Z"),
    stageStatuses: passedStatuses,
    axisCount: 22,
    auditVerdict: "concur",
    costUsdSinceActivation: 0,
  })],
});
assert.equal(passedBeforeActivation.verdict, "FAIL");
assert.equal(passedBeforeActivation.analysisCompleteCount, 0);
assert(passedBeforeActivation.failures.includes(
  "run_before_activation:11111111-1111-4111-8111-111111111111",
));

const failed = evaluateDeepAnalysisCohortObservation({
  ...common,
  outOfCohortRunCount: 1,
  items: [item({
    jobStatus: "dead_letter",
    runId: "33333333-3333-4333-8333-333333333333",
    runStatus: "failed",
    runSourceRevisionSha256: "d".repeat(64),
    runInputSha256: "e".repeat(64),
    runStartedAt: new Date("2026-07-26T03:05:00.000Z"),
    runCompletedAt: new Date("2026-07-26T03:05:30.000Z"),
    stageStatuses: { analysis_complete: "passed" },
    axisCount: 21,
    auditVerdict: "disagree",
    currentInputSealed: false,
    currentInputBlockerCodes: ["blocked_conversion"],
    costUsdSinceActivation: 2.01,
  })],
});
assert.equal(failed.verdict, "FAIL");
assert(failed.failures.includes("out_of_cohort_run:1"));
assert(failed.failures.includes(
  "terminal_job:11111111-1111-4111-8111-111111111111:dead_letter",
));
assert(failed.failures.includes(
  "audit_disagree:11111111-1111-4111-8111-111111111111",
));
assert(failed.failures.includes(
  "axis_count:11111111-1111-4111-8111-111111111111:21",
));
assert(failed.failures.includes(
  "per_grant_cost_cap:11111111-1111-4111-8111-111111111111",
));

console.log("deep-analysis cohort observation tests passed");
