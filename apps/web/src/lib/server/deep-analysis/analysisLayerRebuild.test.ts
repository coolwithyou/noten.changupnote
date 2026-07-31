import assert from "node:assert/strict";
import {
  assertDeepAnalysisLayerRebuildConfirmation,
  assertDeepAnalysisLayerRebuildPreconditions,
  createDeepAnalysisLayerRebuildPlan,
  type DeepAnalysisLayerCounts,
} from "./analysisLayerRebuild";

const before: DeepAnalysisLayerCounts = {
  grants: 100,
  attachmentArchives: 30,
  jobs: 10,
  workerHeartbeats: 2,
  runs: 8,
  stageReceipts: 80,
  axisResults: 44,
  audits: 4,
  exceptionEvents: 3,
  promotionReleases: 5,
  promotionItems: 6,
  criteria: 90,
  confirmationQuestions: 2,
  companyConfirmations: 0,
  matchState: 20,
  landingObservations: 1,
  leasedJobs: 0,
};

const input = {
  generatedAt: "2026-07-31T00:00:00.000Z",
  gitCommit: "a".repeat(40),
  gitTree: "b".repeat(40),
  keepRuns: [{
    id: "run-db-1",
    jobId: "job-1",
    runId: "run-public-1",
    grantId: "grant-1",
    title: "현재 공고",
    completedAt: "2026-07-30T00:00:00.000Z",
    costUsd: 0.5,
    latestAuditVerdict: "concur",
    automationRoute: "auto_promotable",
  }],
  before,
  deleteCounts: {
    jobs: 9,
    workerHeartbeats: 2,
    runs: 7,
    stageReceipts: 70,
    axisResults: 22,
    audits: 3,
    exceptionEvents: 3,
    promotionReleases: 5,
    promotionItems: 6,
    criteria: 90,
    confirmationQuestions: 2,
    companyConfirmations: 0,
    matchState: 20,
    landingObservations: 1,
  },
  preserve: {
    grants: 100,
    attachmentArchives: 30,
    jobs: 1,
    runs: 1,
    stageReceipts: 10,
    axisResults: 22,
    audits: 1,
    exceptionEvents: 0,
  },
};

const plan = createDeepAnalysisLayerRebuildPlan(input);
const reordered = createDeepAnalysisLayerRebuildPlan({
  ...input,
  keepRuns: [...input.keepRuns].reverse(),
});

assert.equal(plan.stateSha256, reordered.stateSha256);
assert.doesNotThrow(() =>
  assertDeepAnalysisLayerRebuildConfirmation(
    plan,
    plan.stateSha256.slice(0, 12),
  ));
assert.throws(
  () => assertDeepAnalysisLayerRebuildConfirmation(plan, "short"),
  /앞 12자/,
);
assert.doesNotThrow(() => assertDeepAnalysisLayerRebuildPreconditions(plan));
assert.throws(
  () => assertDeepAnalysisLayerRebuildPreconditions({
    ...plan,
    before: { ...plan.before, leasedJobs: 1 },
  }),
  /leased/,
);
assert.throws(
  () => assertDeepAnalysisLayerRebuildPreconditions({
    ...plan,
    keepRuns: [],
  }),
  /0건/,
);

console.log("analysis layer rebuild tests: ok");
