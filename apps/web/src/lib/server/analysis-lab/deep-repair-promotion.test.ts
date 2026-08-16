import assert from "node:assert/strict";
import type { LabRun } from "@/features/dev/analysis-lab/contract";
import {
  assertDeepRepairReceiptChain,
  classifyDeepRepairPromotionReadiness,
  DEEP_REPAIR_PROMOTION_READINESS_SCHEMA,
  guardDeepRepairPromotionPlan,
} from "./deep-repair-promotion";
import type { GrantPromotionPlan } from "./promote";
import {
  createPromotionReleaseManifest,
  isVerifiedLocalLabSourceArtifact,
  planSha256,
  validatePromotionReleaseManifest,
  VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleasePlanItem,
  type PromotionSourceArtifact,
} from "./promotion-release";
import { resolvePromotionServingEvidence } from "./promotion-serving";
import {
  assertReceiptBackedPromotionMutationAdmitted,
  PromotionMutationAdmissionError,
} from "./promotion-mutation-admission";

const grantId = "00000000-0000-4000-8000-000000000021";
const runId = "run-2026-08-16T110956.775Z-6561c7";
const sha = (char: string) => char.repeat(64);

assert.doesNotThrow(() => assertDeepRepairReceiptChain([
  {
    target: { sequence: 0, waveId: "wave-1", grantId },
    parentReceiptSha256: null,
    receiptSha256: sha("1"),
  },
  {
    target: { sequence: 1, waveId: "wave-1", grantId: `${grantId}-next` },
    parentReceiptSha256: sha("1"),
    receiptSha256: sha("2"),
  },
]));
assert.throws(() => assertDeepRepairReceiptChain([
  {
    target: { sequence: 1, waveId: "wave-1", grantId },
    parentReceiptSha256: null,
    receiptSha256: sha("2"),
  },
]), /연속적이지 않습니다/);

function run(overrides: Partial<LabRun> = {}): LabRun {
  return {
    runId,
    grantId,
    source: "bizinfo",
    sourceId: "PBLN_DEEP_REPAIR",
    title: "deep repair release",
    model: "claude-opus-5",
    transport: "claude-cli",
    promptVersion: "lab-deep-v17",
    startedAt: "2026-08-16T11:09:56.775Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: sha("1"),
    attachmentManifestSha256: sha("2"),
    usage: null,
    costUsd: null,
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [{
      dimension: "region",
      kind: "required",
      operator: "text_only",
      value: { note: "서울 소재" },
      confidence: 0.9,
      sourceSpan: "서울 소재 기업",
      spanVerified: true,
      note: null,
    }],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryRepairCount: 0,
    primaryValidationOutcome: "publishable",
    matchingReadiness: "ready",
    primaryRepairProvenance: {
      deterministicPrimaryRepairCount: 0,
      modelPrimaryRepairCount: 0,
      newIssueAfterRepairCount: 0,
      blockingNewIssueAfterRepairCount: 0,
      sourceIncompleteIssueAfterRepairCount: 0,
    },
    error: null,
    ...overrides,
  };
}

function current(overrides: Record<string, unknown> = {}) {
  return {
    sourceRevisionSha256: sha("3"),
    inputSha256: sha("1"),
    attachmentManifestSha256: sha("2"),
    status: "open",
    servingState: "visible",
    applicationOpen: true,
    hasDeepAnalysisRun: false,
    hasPromotionItem: false,
    confirmedDuplicate: false,
    ...overrides,
  };
}

assert.equal(
  classifyDeepRepairPromotionReadiness(run(), current(), sha("4")).disposition,
  "ready",
);
assert.equal(
  classifyDeepRepairPromotionReadiness(
    run({ matchingReadiness: "conditional" }),
    current(),
    sha("4"),
  ).disposition,
  "conditional",
);
assert.deepEqual(
  classifyDeepRepairPromotionReadiness(run({
    matchingReadiness: "conditional",
    primaryRepairProvenance: {
      deterministicPrimaryRepairCount: 0,
      modelPrimaryRepairCount: 1,
      newIssueAfterRepairCount: 1,
      blockingNewIssueAfterRepairCount: 1,
      sourceIncompleteIssueAfterRepairCount: 0,
    },
  }), current(), sha("4")).reasons,
  ["blocking_new_issue_after_repair"],
  "통계 verdict가 아니라 해당 run의 blocking 신규 issue가 관리자 큐를 결정한다",
);
assert.equal(
  classifyDeepRepairPromotionReadiness(run(), current({ inputSha256: sha("9") }), sha("4")).disposition,
  "held",
  "current input drift는 release를 차단한다",
);
const readyForPlan = classifyDeepRepairPromotionReadiness(run(), current(), sha("4"));
assert.deepEqual(
  guardDeepRepairPromotionPlan(readyForPlan, {
    criteria: [],
    conversion: {
      grantId,
      runId,
      verdicts: { correct: 1, needs_edit: 0, wrong: 0, unsure: 0 },
      missedConditions: 0,
      inputRows: 1,
      converted: 0,
      downgraded: 0,
      dropped: 1,
      error: "contract failure",
    },
  }),
  {
    ...readyForPlan,
    disposition: "held",
    reasons: ["empty_promotion_plan", "promotion_conversion_drop", "promotion_conversion_error"],
  },
  "실제 matcher plan이 비거나 변환 실패면 publishable run도 보류한다",
);

const sourceArtifact: PromotionSourceArtifact = {
  grantId,
  runId,
  runSha256: sha("5"),
  overlaySha256: null,
  confirmationsSha256: null,
  sourceRevisionSha256: sha("3"),
  localLabEvidence: {
    schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
    transport: "claude-cli",
    model: "claude-opus-5",
    promptVersion: "lab-deep-v17",
    inputSha256: sha("1"),
    reviewMethod: "deep_repair_receipt",
    deepRepair: {
      schema: VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA,
      seriesId: "deep-v21",
      sequence: 0,
      proposalSha256: sha("6"),
      planSha256: sha("7"),
      planArtifactSha256: sha("8"),
      manifestSha256: sha("9"),
      receiptSha256: sha("4"),
      observationsSha256: sha("a"),
      evaluatorReceiptSha256: sha("b"),
      attachmentManifestSha256: sha("2"),
      sourceRevisionSha256: sha("3"),
      executionGitSha: "c".repeat(40),
      packageRuntimeSha256: sha("d"),
      validatorVersion: "deep-analysis-validator-v10",
    },
  },
};
assert.equal(isVerifiedLocalLabSourceArtifact(sourceArtifact), true);

const promotionPlan: GrantPromotionPlan = {
  grantId,
  runId,
  title: "deep repair release",
  origin: "deep_repair",
  auditState: "deep_repair_receipt",
  criteria: [{
    id: "lab-shadow:test:llm-1",
    grant_id: grantId,
    dimension: "region",
    kind: "required",
    operator: "text_only",
    value: { note: "서울 소재" },
    confidence: 0.9,
    needs_review: true,
    source_field: "analysis_lab_deep",
    source_span: "서울 소재 기업",
    parser_version: "analysis-lab-shadow-v2",
  }],
  criterionIndexByPosition: [0],
  criterionStableKeys: [sha("e")],
  resolutions: [{
    criterionIndex: 0,
    state: "deep_repair_receipt",
    decidedBy: sha("4"),
    note: null,
  }],
  conversion: {
    grantId,
    runId,
    verdicts: { correct: 1, needs_edit: 0, wrong: 0, unsure: 0 },
    missedConditions: 0,
    inputRows: 1,
    converted: 1,
    downgraded: 1,
    dropped: 0,
    error: null,
  },
  scopeRejectedCriterionIndexes: [],
  questions: [],
  droppedQuestionCandidates: 0,
};
const readiness = {
  schema: DEEP_REPAIR_PROMOTION_READINESS_SCHEMA,
  disposition: "ready" as const,
  reasons: [],
  unresolvedAxes: [],
  sourceRevisionSha256: sha("3"),
  inputSha256: sha("1"),
  attachmentManifestSha256: sha("2"),
  receiptSha256: sha("4"),
};
const planItem: PromotionReleasePlanItem = {
  grantId,
  planSha256: planSha256(promotionPlan),
  promotionPlan,
  deepRepairReadiness: readiness,
  beforeCriteriaSha256: sha("1"),
  beforeQuestionsSha256: sha("2"),
  dedupComponentSha256: sha("3"),
  criteriaCountBefore: 0,
  criteriaCountAfter: 1,
  questionCountAfter: 0,
  pendingCount: 0,
  downgradedCount: 1,
  transport: "claude-cli",
  costUsd: null,
};
const manifest = createPromotionReleaseManifest({
  releaseId: "deep-v21-closed-beta-r1",
  revision: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
  gitCommit: "f".repeat(40),
  buildDigest: "0".repeat(40),
  cohortLabel: "deep-v21-closed-beta",
  canaryGrantIds: [grantId],
  sourceArtifacts: [sourceArtifact],
  plans: [planItem],
});
assert.equal(manifest.servingProvenance, "verified_local_lab");
assert.deepEqual(validatePromotionReleaseManifest(manifest), manifest);
assert.doesNotThrow(() => assertReceiptBackedPromotionMutationAdmitted(manifest));
assert.throws(
  () => assertReceiptBackedPromotionMutationAdmitted({
    ...manifest,
    plans: [{
      ...manifest.plans[0]!,
      promotionPlan: { ...manifest.plans[0]!.promotionPlan, origin: "human" },
    }],
  }),
  PromotionMutationAdmissionError,
  "legacy review release는 receipt 기반 mutation admission을 통과할 수 없다",
);
assert.equal(resolvePromotionServingEvidence({
  grantId,
  runId,
  planSha256: planItem.planSha256,
  deepAnalysisRunId: null,
  releaseManifestSha256: manifest.manifestSha256,
  manifest,
})?.kind, "verified_local_lab");

console.log("deep repair promotion tests: ok");
