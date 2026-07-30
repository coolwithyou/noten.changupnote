import assert from "node:assert/strict";
import { DEEP_ANALYSIS_SERVING_VERIFIER_VERSION } from "@cunote/contracts";
import {
  DEEP_ANALYSIS_COHORT_REQUIRED_STAGES,
  evaluateDeepAnalysisCohortObservation,
  type DeepAnalysisCohortObservationItem,
  type DeepAnalysisCohortPromotion,
  type DeepAnalysisCohortServingReceipt,
  type DeepAnalysisCohortServingStage,
} from "./cohortObservation";
import { sha256Hex, stableJson } from "./sourceRevision";

const revision = "a".repeat(64);
const inputSha256 = "b".repeat(64);
const promotionAfterSha256 = "d".repeat(64);
const criteriaSha256 = "e".repeat(64);
const traceSha256 = "f".repeat(64);

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
    promotion: null,
    servingReceipts: {},
    costUsdSinceActivation: 0,
    ...override,
  };
}

function passingPromotion(index: number): DeepAnalysisCohortPromotion {
  return {
    itemId: `promotion-item-${index}`,
    itemStatus: "applied",
    releaseId: `release-${index}`,
    releaseStatus: "active",
    afterSha256: promotionAfterSha256,
  };
}

function passingServingReceipts(
  promotion: DeepAnalysisCohortPromotion,
): Record<DeepAnalysisCohortServingStage, DeepAnalysisCohortServingReceipt> {
  const evidenceByStage: Record<
    DeepAnalysisCohortServingStage,
    Record<string, unknown>
  > = {
    publication_complete: {
      releaseId: promotion.releaseId,
      promotionItemId: promotion.itemId,
      expectedAfterSha256: promotion.afterSha256,
      actualAfterSha256: promotion.afterSha256,
    },
    serving_complete: {
      releaseId: promotion.releaseId,
      promotionItemId: promotion.itemId,
      snapshotCriteriaSha256: criteriaSha256,
      repositoryCriteriaSha256: criteriaSha256,
      traceSha256,
    },
    analysis_fresh: {
      releaseId: promotion.releaseId,
      promotionItemId: promotion.itemId,
      runSourceRevisionSha256: revision,
      currentSourceRevisionSha256: revision,
      runInputSha256: inputSha256,
      currentInputSha256: inputSha256,
    },
  };
  return Object.fromEntries(
    Object.entries(evidenceByStage).map(([stage, evidence]) => [
      stage,
      {
        status: "passed",
        verifierVersion: DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
        evidence,
        evidenceSha256: sha256Hex(stableJson(evidence)),
        artifactKey: `deep-analysis/test/${promotion.itemId}/${stage}.json`,
        createdAt: new Date("2026-07-26T03:05:50.000Z"),
      },
    ]),
  ) as Record<DeepAnalysisCohortServingStage, DeepAnalysisCohortServingReceipt>;
}

function passingItem(index: number): DeepAnalysisCohortObservationItem {
  const promotion = passingPromotion(index);
  const suffix = String(index).padStart(12, "0");
  return item({
    grantId: `11111111-1111-4111-8111-${suffix}`,
    sourceId: `PBLN_TEST_${index}`,
    jobId: `22222222-2222-4222-8222-${suffix}`,
    jobStatus: "succeeded",
    runId: `run-${index}`,
    runStatus: "passed",
    runSourceRevisionSha256: revision,
    runInputSha256: inputSha256,
    runStartedAt: new Date("2026-07-26T03:05:00.000Z"),
    runCompletedAt: new Date("2026-07-26T03:05:45.000Z"),
    stageStatuses: passedStatuses,
    axisCount: 22,
    auditVerdict: "concur",
    promotion,
    servingReceipts: passingServingReceipts(promotion),
    costUsdSinceActivation: 0.5,
  });
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
const passedPromotion = passingPromotion(1);
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
    promotion: passedPromotion,
    servingReceipts: passingServingReceipts(passedPromotion),
    costUsdSinceActivation: 0.75,
  })],
});
assert.equal(passed.verdict, "PASS");
assert.equal(passed.analysisCompleteCount, 1);
assert.equal(passed.publicationCompleteCount, 1);
assert.equal(passed.servingCompleteCount, 1);
assert.equal(passed.analysisFreshCount, 1);
assert.equal(passed.servingFreshCount, 1);
assert.equal(passed.analysisLatencySeconds.p95, 45);

const conditionalPromotion = passingPromotion(2);
const conditionalPassed = evaluateDeepAnalysisCohortObservation({
  ...common,
  items: [item({
    jobStatus: "succeeded",
    runId: "43333333-3333-4333-8333-333333333333",
    runStatus: "passed",
    runSourceRevisionSha256: revision,
    runInputSha256: inputSha256,
    runStartedAt: new Date("2026-07-26T03:05:00.000Z"),
    runCompletedAt: new Date("2026-07-26T03:05:45.000Z"),
    stageStatuses: {
      ...passedStatuses,
      independent_audit_passed: "not_applicable",
    },
    axisCount: 22,
    auditVerdict: "unsure",
    promotion: conditionalPromotion,
    servingReceipts: passingServingReceipts(conditionalPromotion),
    costUsdSinceActivation: 0.75,
  })],
});
assert.equal(
  conditionalPassed.verdict,
  "PASS",
  "검증된 반대 finding이 없는 조건부 승격도 처리 완료로 관측해야 한다",
);

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

const exactCohort = Array.from({ length: 20 }, (_, index) => passingItem(index + 1));
const completeCohort = evaluateDeepAnalysisCohortObservation({
  ...common,
  expectedCount: 20,
  items: exactCohort,
});
assert.equal(completeCohort.verdict, "PASS");
assert.equal(completeCohort.analysisCompleteCount, 20);
assert.equal(completeCohort.publicationCompleteCount, 20);
assert.equal(completeCohort.servingCompleteCount, 20);
assert.equal(completeCohort.analysisFreshCount, 20);
assert.equal(completeCohort.servingFreshCount, 20);

const unpublishedGrantId = exactCohort.at(-1)!.grantId;
const cohortWithUnpublishedGrant = exactCohort.map((cohortItem) =>
  cohortItem.grantId === unpublishedGrantId
    ? { ...cohortItem, promotion: null, servingReceipts: {} }
    : cohortItem);
const incompleteServingCohort = evaluateDeepAnalysisCohortObservation({
  ...common,
  expectedCount: 20,
  items: cohortWithUnpublishedGrant,
});
assert.equal(incompleteServingCohort.verdict, "FAIL");
assert.equal(incompleteServingCohort.analysisCompleteCount, 20);
assert.equal(incompleteServingCohort.servingFreshCount, 19);
assert(incompleteServingCohort.failures.includes(
  `promotion_missing:${unpublishedGrantId}`,
));
assert(incompleteServingCohort.failures.includes(
  `serving_receipt_missing:${unpublishedGrantId}:publication_complete`,
));

console.log("deep-analysis cohort observation tests passed");
