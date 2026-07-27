import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type * as schema from "@/lib/server/db/schema";
import type { GrantPromotionPlan } from "../analysis-lab/promote";
import {
  createPromotionReleaseManifest,
  planSha256,
  type PromotionReleasePlanItem,
} from "../analysis-lab/promotion-release";
import {
  evaluateAggregateSplitExposureGate,
  runAggregateSplitExposure,
  type AggregateSplitExposureCandidate,
  type AggregateSplitExposurePort,
} from "./aggregateSplitExposure";

const splitCaseId = "11111111-1111-4111-8111-111111111111";
const parentGrantId = "22222222-2222-4222-8222-222222222222";
const releaseDbId = "33333333-3333-4333-8333-333333333333";
const childIds = [
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

const ready = buildCandidate("not_ready");
assert.deepEqual(evaluateAggregateSplitExposureGate(ready), {
  ready: true,
  phase: "ready",
  firstBlocker: null,
});

const missingS12 = buildCandidate("not_ready");
missingS12.items[1]!.stageReceipts.publication_complete = {
  status: "failed",
  evidence: {},
};
assert.equal(
  evaluateAggregateSplitExposureGate(missingS12).firstBlocker?.code,
  "aggregate_split_exposure_s12_not_passed",
);

const resumed = buildCandidate("verifying");
assert.equal(evaluateAggregateSplitExposureGate(resumed).phase, "resume");

const visibleWithoutReceipts = buildCandidate("visible");
assert.equal(
  evaluateAggregateSplitExposureGate(visibleWithoutReceipts).firstBlocker?.code,
  "aggregate_split_exposure_visible_receipt_mismatch",
);

const completed = buildCandidate("visible", true);
assert.equal(evaluateAggregateSplitExposureGate(completed).phase, "complete");

const rolledBack = buildCandidate("rolled_back");
assert.equal(evaluateAggregateSplitExposureGate(rolledBack).phase, "ready");

const exposureCliSource = readFileSync(
  new URL("./aggregate-split-exposure-cli.ts", import.meta.url),
  "utf8",
);
assert.match(exposureCliSource, /AGGREGATE_SPLIT_EXPOSURE_EXECUTE/);
assert.match(exposureCliSource, /--execute/);

{
  let finalized = false;
  let rolledBack = false;
  let rollbackReceipts = false;
  const port = fakePort({
    verificationFailures: [],
    onFinalize: () => {
      finalized = true;
    },
    onRollback: () => {
      rolledBack = true;
    },
    onRollbackReceipts: () => {
      rollbackReceipts = true;
    },
  });
  const result = await runAggregateSplitExposure(port);
  assert.equal(result.outcome, "visible");
  assert.equal(finalized, true);
  assert.equal(rolledBack, false);
  assert.equal(rollbackReceipts, false);
}

{
  let finalized = false;
  let rolledBack = false;
  let rollbackReceipts = false;
  const port = fakePort({
    verificationFailures: [{
      grantId: childIds[1]!,
      stage: "analysis_fresh",
      issues: ["input hash mismatch"],
    }],
    onFinalize: () => {
      finalized = true;
    },
    onRollback: () => {
      rolledBack = true;
    },
    onRollbackReceipts: () => {
      rollbackReceipts = true;
    },
  });
  await assert.rejects(
    runAggregateSplitExposure(port),
    /input hash mismatch/,
  );
  assert.equal(finalized, false);
  assert.equal(rolledBack, true);
  assert.equal(rollbackReceipts, true);
}

console.log("aggregate split exposure tests passed");

function fakePort(input: {
  verificationFailures: Array<{ grantId: string; stage: string; issues: string[] }>;
  onFinalize(): void;
  onRollback(): void;
  onRollbackReceipts(): void;
}): AggregateSplitExposurePort {
  return {
    async loadCandidate() {
      return buildCandidate("not_ready");
    },
    async transitionVisibility() {
      return {
        outcome: "transitioned",
        candidate: buildCandidate("verifying"),
      };
    },
    async verifyServing() {
      return { failures: input.verificationFailures };
    },
    async finalizeVisibility() {
      input.onFinalize();
    },
    async rollbackVisibility() {
      input.onRollback();
    },
    async appendRollbackReceipts() {
      input.onRollbackReceipts();
    },
  };
}

function buildCandidate(
  exposureStatus: "not_ready" | "verifying" | "visible" | "rolled_back",
  withServingReceipts = false,
): AggregateSplitExposureCandidate {
  const now = new Date("2026-07-26T03:00:00.000Z");
  const plans = childIds.map((childId, index) => promotionPlan(childId, index));
  const planItems: PromotionReleasePlanItem[] = plans.map((plan) => ({
    grantId: plan.grantId,
    planSha256: planSha256(plan),
    promotionPlan: plan,
    beforeCriteriaSha256: "a".repeat(64),
    beforeQuestionsSha256: "b".repeat(64),
    dedupComponentSha256: "c".repeat(64),
    criteriaCountBefore: 0,
    criteriaCountAfter: 0,
    questionCountAfter: 0,
    pendingCount: 0,
    downgradedCount: 0,
    costUsd: 0.1,
  }));
  const manifest = createPromotionReleaseManifest({
    releaseId: "aggregate-split-test-r1",
    revision: 1,
    createdAt: now.toISOString(),
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: `aggregate-split:${splitCaseId}`,
    canaryGrantIds: [childIds[0]!],
    sourceArtifacts: plans.map((plan, index) => ({
      grantId: plan.grantId,
      runId: plan.runId,
      runSha256: String(index + 1).repeat(64),
      overlaySha256: null,
      confirmationsSha256: null,
      reviewSha256: "f".repeat(64),
    })),
    plans: planItems,
  });
  const children = childIds.map((id, index) => ({
    id,
    splitCaseId,
    parentGrantId,
    stableKey: `p00${index + 1}`,
    ordinal: index,
    status: "prepared",
    sourceRevisionSha256: String(index + 6).repeat(64),
    inputSha256: String(index + 8).repeat(64),
  })) as Array<typeof schema.grantAggregateSplitChildren.$inferSelect>;
  const items = children.map((child, index) => {
    const itemId = `66666666-6666-4666-8666-66666666666${index}`;
    const runId = `77777777-7777-4777-8777-77777777777${index}`;
    const commonEvidence = {
      releaseId: manifest.releaseId,
      promotionItemId: itemId,
    };
    return {
      id: itemId,
      grantId: child.id,
      status: "applied",
      deepAnalysisRunId: runId,
      run: {
        id: runId,
        runId: `run-${index}`,
        grantId: child.id,
        sourceRevisionSha256: child.sourceRevisionSha256,
        inputSha256: child.inputSha256!,
        status: "passed",
      } as typeof schema.grantDeepAnalysisRuns.$inferSelect,
      stageReceipts: {
        publication_complete: {
          status: "passed",
          evidence: commonEvidence,
        },
        ...(withServingReceipts
          ? {
            serving_complete: {
              status: "passed",
              evidence: commonEvidence,
            },
            analysis_fresh: {
              status: "passed",
              evidence: commonEvidence,
            },
          }
          : {}),
      },
    };
  });
  const exposureAttempted = exposureStatus !== "not_ready";
  const visibilityActive = exposureStatus === "verifying" || exposureStatus === "visible";
  return {
    splitCase: {
      id: splitCaseId,
      grantId: parentGrantId,
      status: "completed",
      materializationStatus: "prepared",
      promotionStatus: "enqueued",
      programCount: childIds.length,
      preparedChildCount: childIds.length,
      stagedChildCount: childIds.length,
      enqueuedChildCount: childIds.length,
      exposureStatus,
      exposureReleaseId: exposureAttempted ? manifest.releaseId : null,
      exposedChildCount: visibilityActive ? childIds.length : 0,
      childrenVisibleAt: exposureAttempted ? now : null,
      servingVerifiedAt: exposureStatus === "visible" ? now : null,
      visibilityRolledBackAt: exposureStatus === "rolled_back" ? now : null,
    } as typeof schema.grantAggregateSplitCases.$inferSelect,
    children,
    parentServingState: visibilityActive ? "suppressed" : "visible",
    childServingStates: new Map(
      childIds.map((id) => [id, visibilityActive ? "visible" : "staged"]),
    ),
    release: {
      id: releaseDbId,
      releaseId: manifest.releaseId,
      manifest,
      manifestSha256: manifest.manifestSha256,
      releasePlanSha256: manifest.releasePlanSha256,
      status: "active",
      gateSummary: {
        schema: "aggregate-split-publication-gate-v1",
        verdict: "PASS",
        splitCaseId,
        parentGrantId,
        childCount: childIds.length,
      },
    } as unknown as typeof schema.analysisLabPromotionReleases.$inferSelect,
    items,
  };
}

function promotionPlan(grantId: string, index: number): GrantPromotionPlan {
  const runId = `run-${index}`;
  return {
    grantId,
    runId,
    title: `child ${index}`,
    origin: "audited",
    auditState: "ai_audit_concur",
    criteria: [],
    criterionIndexByPosition: [],
    criterionStableKeys: [],
    resolutions: [],
    conversion: {
      grantId,
      runId,
      verdicts: { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 },
      missedConditions: 0,
      inputRows: 0,
      converted: 0,
      downgraded: 0,
      dropped: 0,
      error: null,
    },
    questions: [],
    droppedQuestionCandidates: 0,
  };
}
