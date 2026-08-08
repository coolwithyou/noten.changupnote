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
  applicationSurfaces: 40,
  documentArtifacts: 120,
  nonFieldDocumentArtifacts: 115,
  pageImageArtifacts: 80,
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
  applicationPrecomputeJobs: 5,
  applicationPrecomputeAttempts: 7,
  applicationPrecomputeWorkerHeartbeats: 2,
  fieldCandidateArtifacts: 5,
  documentFields: 25,
  fieldsReadySurfaces: 4,
  leasedJobs: 0,
  leasedApplicationPrecomputeJobs: 0,
  leasedApplicationPrecomputeAttempts: 0,
};

const input = {
  generatedAt: "2026-07-31T00:00:00.000Z",
  gitCommit: "a".repeat(40),
  gitTree: "b".repeat(40),
  gitDirty: false,
  implementationSha256: "c".repeat(64),
  mode: "preserve_current" as const,
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
    applicationPrecomputeJobs: 5,
    applicationPrecomputeAttempts: 7,
    applicationPrecomputeWorkerHeartbeats: 2,
    fieldCandidateArtifacts: 5,
    documentFields: 25,
  },
  resetCounts: {
    fieldsReadySurfaces: 4,
  },
  preserve: {
    grants: 100,
    attachmentArchives: 30,
    applicationSurfaces: 40,
    nonFieldDocumentArtifacts: 115,
    pageImageArtifacts: 80,
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
assert.notEqual(
  plan.stateSha256,
  createDeepAnalysisLayerRebuildPlan({
    ...input,
    implementationSha256: "d".repeat(64),
  }).stateSha256,
);
assert.notEqual(
  plan.stateSha256,
  createDeepAnalysisLayerRebuildPlan({
    ...input,
    gitDirty: true,
  }).stateSha256,
);
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
assert.doesNotThrow(() =>
  assertDeepAnalysisLayerRebuildPreconditions({
    ...plan,
    mode: "fresh_start",
    keepRuns: [],
  })
);
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
    mode: "preserve_current",
    keepRuns: [],
  }),
  /0건/,
);
assert.throws(
  () => assertDeepAnalysisLayerRebuildPreconditions({
    ...plan,
    before: { ...plan.before, leasedApplicationPrecomputeJobs: 1 },
  }),
  /Kordoc job/,
);
assert.throws(
  () => assertDeepAnalysisLayerRebuildPreconditions({
    ...plan,
    before: { ...plan.before, leasedApplicationPrecomputeAttempts: 1 },
  }),
  /Kordoc attempt/,
);
assert.throws(
  () => assertDeepAnalysisLayerRebuildPreconditions({
    ...plan,
    mode: "fresh_start",
  }),
  /보존할 수 없습니다/,
);

const freshStartPlan = createDeepAnalysisLayerRebuildPlan({
  ...input,
  mode: "fresh_start",
  keepRuns: [],
  deleteCounts: {
    ...input.deleteCounts,
    jobs: before.jobs,
    runs: before.runs,
    stageReceipts: before.stageReceipts,
    axisResults: before.axisResults,
    audits: before.audits,
    exceptionEvents: before.exceptionEvents,
  },
  preserve: {
    ...input.preserve,
    jobs: 0,
    runs: 0,
    stageReceipts: 0,
    axisResults: 0,
    audits: 0,
    exceptionEvents: 0,
  },
});
assert.notEqual(plan.stateSha256, freshStartPlan.stateSha256);
assert.doesNotThrow(() =>
  assertDeepAnalysisLayerRebuildPreconditions(freshStartPlan)
);

console.log("analysis layer rebuild tests: ok");
