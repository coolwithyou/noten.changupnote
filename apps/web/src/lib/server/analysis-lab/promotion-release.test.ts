import assert from "node:assert/strict";
import type { GrantPromotionPlan } from "./promote";
import {
  evaluatePromotionAggregateEvidence,
  type PromotionAggregateApiCostGate,
  type PromotionAggregateGateId,
} from "./promotion-gate-evidence";
import {
  assertPromotionReleaseContinuationBinding,
  assertManifestConfirmation,
  canonicalJson,
  createPromotionReleaseManifest,
  isUnexplainedPromotionShadowTransition,
  promotionPlanHasUnsafeUnresolvedCriteria,
  releasePlanItemHasUnsafePendingCriteria,
  mergePromotionApprovalGateEvidence,
  planSha256,
  pseudonymizePromotionCompanyKey,
  resolvePromotionReleaseTransport,
  validatePromotionReleaseManifest,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleasePlanItem,
  type PromotionSourceArtifact,
} from "./promotion-release";

const aggregateThresholds = {
  strictPrecisionMin: 0.9,
  wrongRateMax: 0.1,
  missedPerNoticeMax: 1,
  coverageRatioMin: 1,
  costPerNoticeMaxUsd: 1,
  structuredRatioMin: 0.5,
};

function aggregateEvidence(
  plans: PromotionReleasePlanItem[],
  apiCostGate: PromotionAggregateApiCostGate | null = null,
) {
  return evaluatePromotionAggregateEvidence({ plans, thresholds: aggregateThresholds, apiCostGate });
}

function aggregateGate(
  plans: PromotionReleasePlanItem[],
  id: PromotionAggregateGateId,
  apiCostGate: PromotionAggregateApiCostGate | null = null,
) {
  return aggregateEvidence(plans, apiCostGate).gates.find((gate) => gate.id === id)!;
}

const plan: GrantPromotionPlan = {
  grantId: "00000000-0000-4000-8000-000000000001",
  runId: "run-2026-07-25T000000.000Z-abcd",
  title: "테스트 공고",
  origin: "human",
  auditState: "human_reviewed",
  criteria: [],
  criterionIndexByPosition: [],
  criterionStableKeys: [],
  resolutions: [],
  conversion: {
    grantId: "00000000-0000-4000-8000-000000000001",
    runId: "run-2026-07-25T000000.000Z-abcd",
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

const planItem: PromotionReleasePlanItem = {
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
  costUsd: 0.25,
};

function manifest(item: PromotionReleasePlanItem = planItem) {
  return createPromotionReleaseManifest({
    releaseId: "deep-test-r1",
    revision: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: "2026-W30",
    canaryGrantIds: [plan.grantId],
    sourceArtifacts: [{
      grantId: plan.grantId,
      runId: plan.runId,
      runSha256: "f".repeat(64),
      overlaySha256: null,
      confirmationsSha256: null,
      reviewSha256: "1".repeat(64),
    }],
    plans: [item],
  });
}

{
  const mismatchedTransport = manifest({ ...planItem, transport: "claude-cli" });
  assert.throws(
    () => validatePromotionReleaseManifest(mismatchedTransport),
    /transport provenance/,
    "API source를 claude-cli로 표시한 release manifest는 거부해야 한다",
  );
}

{
  const merged = mergePromotionApprovalGateEvidence({
    schema: "aggregate-split-publication-gate-v1",
    verdict: "PASS",
    splitCaseId: "case-1",
  }, {
    aggregateSha256: "a".repeat(64),
    shadowSha256: "b".repeat(64),
    dryRunSha256: "c".repeat(64),
  });
  assert.equal(merged.schema, "aggregate-split-publication-gate-v1");
  assert.equal(merged.verdict, "PASS");
  assert.equal(merged.splitCaseId, "case-1");
  assert.equal(merged.aggregateSha256, "a".repeat(64));
}

{
  assert.equal(
    canonicalJson({ b: "값", a: [2, 1] }),
    canonicalJson({ a: [2, 1], b: "값" }),
    "object key 순서와 Unicode 표현은 hash 입력에 영향을 주지 않아야 한다",
  );
  const first = manifest();
  const second = manifest();
  assert.equal(first.servingProvenance, "experiment_only");
  assert.equal(first.releasePlanSha256, second.releasePlanSha256);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(validatePromotionReleaseManifest(first), first);
  assert.doesNotThrow(() => assertManifestConfirmation(first, first.manifestSha256.slice(0, 12)));
  assert.throws(() => assertManifestConfirmation(first, "short"), /12자/);
}

const verifiedLocalSource = {
  grantId: plan.grantId,
  runId: plan.runId,
  runSha256: "f".repeat(64),
  aiReviewSha256: "1".repeat(64),
  auditSha256: "2".repeat(64),
  overlaySha256: null,
  confirmationsSha256: null,
  localLabEvidence: {
    schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
    transport: "claude-cli" as const,
    model: "claude-opus-5",
    promptVersion: "lab-deep-v7",
    inputSha256: "3".repeat(64),
    reviewMethod: "ai_audit" as const,
    reviewModel: "claude-fable-5",
    reviewPromptVersion: "ai-review-v3",
    reviewTransport: "claude-cli" as const,
    auditModel: "claude-sonnet-5",
    auditPromptVersion: "ai-audit-v2",
    auditTransport: "claude-cli" as const,
  },
};

{
  const previousPlan: PromotionReleasePlanItem = {
    ...planItem,
    deepRepairReadiness: {
      schema: "deep-repair-promotion-readiness-v1",
      disposition: "ready",
      reasons: [],
      unresolvedAxes: [],
      sourceRevisionSha256: "4".repeat(64),
      inputSha256: "3".repeat(64),
      attachmentManifestSha256: "5".repeat(64),
      receiptSha256: "6".repeat(64),
    },
  };
  const previousSource: PromotionSourceArtifact = {
    ...verifiedLocalSource,
    sourceRevisionSha256: "4".repeat(64),
    localLabEvidence: {
      ...verifiedLocalSource.localLabEvidence,
      reviewMethod: "deep_repair_receipt",
      deepRepair: {
        schema: "verified-deep-repair-source-v1",
        seriesId: "deep-v21",
        sequence: 0,
        proposalSha256: "7".repeat(64),
        planSha256: "8".repeat(64),
        planArtifactSha256: "9".repeat(64),
        manifestSha256: "a".repeat(64),
        receiptSha256: "6".repeat(64),
        observationsSha256: "b".repeat(64),
        evaluatorReceiptSha256: "c".repeat(64),
        attachmentManifestSha256: "5".repeat(64),
        sourceRevisionSha256: "4".repeat(64),
        executionGitSha: "d".repeat(40),
        packageRuntimeSha256: "e".repeat(64),
        validatorVersion: "deep-analysis-validator-v10",
      },
    },
  };
  const currentPlan: PromotionReleasePlanItem = {
    ...previousPlan,
    deepRepairReadiness: {
      ...previousPlan.deepRepairReadiness!,
      sourceRevisionSha256: "f".repeat(64),
    },
  };
  const currentSource: PromotionSourceArtifact = {
    ...previousSource,
    sourceRevisionSha256: "f".repeat(64),
    localLabEvidence: {
      ...previousSource.localLabEvidence!,
      deepRepair: {
        ...previousSource.localLabEvidence!.deepRepair!,
        sourceRevisionSha256: "f".repeat(64),
      },
    },
  };
  assert.deepEqual(
    assertPromotionReleaseContinuationBinding(
      { plans: [previousPlan], sourceArtifacts: [previousSource] },
      { plans: [currentPlan], sourceArtifacts: [currentSource] },
    ),
    { refreshedSourceGrantIds: [plan.grantId] },
    "source provenance만 갱신되고 promotion material이 같으면 기존 승인 범위를 이어간다",
  );
  assert.throws(
    () => assertPromotionReleaseContinuationBinding(
      { plans: [previousPlan], sourceArtifacts: [previousSource] },
      {
        plans: [{
          ...currentPlan,
          deepRepairReadiness: {
            ...currentPlan.deepRepairReadiness!,
            inputSha256: "0".repeat(64),
          },
        }],
        sourceArtifacts: [currentSource],
      },
    ),
    /promotion material 결속/,
    "분석 입력이 바뀐 경우에는 source revision 갱신으로 위장해 권한을 상속할 수 없다",
  );
}

assert.equal(
  resolvePromotionReleaseTransport({}, verifiedLocalSource),
  "claude-cli",
  "legacy verified-local source는 plan transport가 없어도 구독으로 복원한다",
);
assert.equal(
  resolvePromotionReleaseTransport({}, manifest().sourceArtifacts[0]),
  "api",
  "legacy non-local source의 미기록 transport는 API로 유지한다",
);
assert.equal(
  resolvePromotionReleaseTransport({}, {
    ...verifiedLocalSource,
    deepAnalysisRunId: "deep-run-1",
  }),
  "api",
  "production deep provenance는 local evidence보다 API 해석이 우선한다",
);

{
  const mismatchedRunSource = createPromotionReleaseManifest({
    releaseId: "deep-mismatched-source-run-r1",
    revision: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: "mismatched-source-run",
    canaryGrantIds: [plan.grantId],
    sourceArtifacts: [{ ...verifiedLocalSource, runId: "run-other" }],
    plans: [{ ...planItem, transport: "claude-cli" }],
  });
  assert.throws(
    () => validatePromotionReleaseManifest(mismatchedRunSource),
    /source runId.*불일치/,
    "같은 grant의 다른 local run provenance로 API plan 비용을 위장할 수 없다",
  );

  const duplicateSource = createPromotionReleaseManifest({
    releaseId: "deep-duplicate-source-r1",
    revision: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: "duplicate-source",
    canaryGrantIds: [plan.grantId],
    sourceArtifacts: [verifiedLocalSource, { ...verifiedLocalSource }],
    plans: [{ ...planItem, transport: "claude-cli" }],
  });
  assert.throws(
    () => validatePromotionReleaseManifest(duplicateSource),
    /source artifact grant 중복/,
    "grant별 source artifact는 정확히 하나여야 한다",
  );
}

{
  const verifiedLocal = createPromotionReleaseManifest({
    releaseId: "deep-local-test-r1",
    revision: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: "local-canary",
    canaryGrantIds: [plan.grantId],
    sourceArtifacts: [verifiedLocalSource],
    plans: [{ ...planItem, transport: "claude-cli" }],
  });
  assert.equal(verifiedLocal.servingProvenance, "verified_local_lab");
  assert.equal(verifiedLocal.plans[0]?.transport, "claude-cli");
  assert.deepEqual(validatePromotionReleaseManifest(verifiedLocal), verifiedLocal);

  verifiedLocal.servingProvenance = "production_deep_run";
  assert.throws(
    () => validatePromotionReleaseManifest(verifiedLocal),
    /serving provenance/,
    "source artifact와 다른 provenance 표시는 거부해야 한다",
  );

  const dualProvenance = createPromotionReleaseManifest({
    releaseId: "deep-dual-source-test-r1",
    revision: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: "invalid-dual-source",
    canaryGrantIds: [plan.grantId],
    sourceArtifacts: [{
      ...verifiedLocalSource,
      deepAnalysisRunId: "deep-run-1",
    }],
    plans: [{ ...planItem, transport: "claude-cli" }],
  });
  assert.throws(
    () => validatePromotionReleaseManifest(dualProvenance),
    /source provenance.*상호배타/,
    "production deep source와 verified-local source를 동시에 주장할 수 없다",
  );
}

{
  const changed = manifest();
  changed.plans[0]!.promotionPlan.title = "변경된 제목";
  assert.throws(() => validatePromotionReleaseManifest(changed), /plan hash/);
}

{
  const pendingItem: PromotionReleasePlanItem = {
    ...planItem,
    promotionPlan: {
      ...plan,
      criteria: [{
        id: "conditional-only",
        grant_id: plan.grantId,
        dimension: "other",
        kind: "required",
        operator: "text_only",
        value: { text: "선정 후 입주 조건" },
        confidence: 0.9,
        needs_review: true,
        source_field: "deep_analysis",
        source_span: "선정 후 입주 조건",
        parser_version: "deep-analysis-v3",
      }],
    },
  };
  assert.equal(
    releasePlanItemHasUnsafePendingCriteria(pendingItem),
    true,
    "일반 release의 needs_review는 계속 fail-closed여야 한다",
  );
  const autoPromotableItem: PromotionReleasePlanItem = {
    ...pendingItem,
    deepAnalysisReadiness: {
      schema: "deep-analysis-promotion-readiness-v1",
      analysisComplete: "passed",
      auditComplete: "passed",
      matcherRepresentable: "passed",
      autoPromotable: "passed",
      humanReviewRequired: false,
      terminalRoute: "auto_promotable",
      blockers: [],
    },
    deepAnalysisConditionalOnlyCriteria: [0],
  };
  assert.equal(
    releasePlanItemHasUnsafePendingCriteria(autoPromotableItem),
    false,
    "봉인된 R1~R3 auto-promotable receipt의 conditional_only는 보존 발행해야 한다",
  );
  const conditionalPromotableItem: PromotionReleasePlanItem = {
    ...autoPromotableItem,
    deepAnalysisReadiness: {
      schema: "deep-analysis-promotion-readiness-v1",
      analysisComplete: "passed",
      auditComplete: "not_assessed",
      matcherRepresentable: "not_assessed",
      autoPromotable: "blocked",
      conditionalPromotable: "passed",
      humanReviewRequired: false,
      terminalRoute: "conditional_promotable",
      deferredCriterionIndexes: [0],
      blockers: [],
      deferrals: [{
        code: "audit_uncertain",
        stage: "audit_complete",
        count: 1,
        detail: "사용자 확인 필요",
      }],
    },
  };
  assert.equal(
    releasePlanItemHasUnsafePendingCriteria(conditionalPromotableItem),
    false,
    "애매한 criterion만 needs_review로 봉인한 조건부 승격은 발행 가능해야 한다",
  );
  const auditedLocalConditionalItem: PromotionReleasePlanItem = {
    ...pendingItem,
    promotionPlan: {
      ...pendingItem.promotionPlan,
      origin: "audited",
      auditState: "deterministic_contract",
      reviewRisk: {
        schema: "promotion-review-risk-v1",
        disposition: "conditional",
        blockers: [],
        deferrals: [{
          code: "ranking_criterion_suppressed",
          criterionIndex: 2,
          verdict: "needs_edit",
          detail: "오류가 있는 우대조건은 점수에서 제외",
        }],
        suppressedCriterionIndexes: [2],
        suppressedVerdicts: { needsEdit: 1, wrong: 0, unsure: 0 },
        deferredMissedConditions: 0,
      },
    },
  };
  assert.equal(
    releasePlanItemHasUnsafePendingCriteria(auditedLocalConditionalItem),
    false,
    "release 준비가 허용한 독립 감사 local canary를 shadow가 다시 거부하지 않는다",
  );
  assert.equal(
    releasePlanItemHasUnsafePendingCriteria({
      ...auditedLocalConditionalItem,
      promotionPlan: {
        ...auditedLocalConditionalItem.promotionPlan,
        auditState: "mixed_resolution",
      },
    }),
    true,
    "감사 근거가 봉인되지 않은 local plan은 계속 fail-closed한다",
  );
  assert.equal(
    aggregateGate([pendingItem], "coverage_ratio").blocking,
    true,
    "일반 사람 검수 release의 상대 coverage 게이트는 계속 발행을 차단해야 한다",
  );
  assert.equal(
    aggregateGate([autoPromotableItem], "coverage_ratio").blocking,
    false,
    "봉인된 deep auto-promotable release에서 상대 coverage는 관찰 지표여야 한다",
  );
  assert.equal(
    aggregateGate([autoPromotableItem], "structured_ratio").blocking,
    false,
    "봉인된 deep auto-promotable release에서 structured 비율은 관찰 지표여야 한다",
  );
  assert.equal(
    aggregateGate([conditionalPromotableItem], "coverage_ratio").blocking,
    false,
    "조건부 deep release에서도 상대 coverage는 관찰 지표여야 한다",
  );
  assert.equal(
    aggregateGate([autoPromotableItem], "wrong_rate").blocking,
    false,
    "sealed deep release는 존재하지 않는 review verdict 오류율을 가장하지 않아야 한다",
  );
  assert.equal(
    aggregateGate(
      [autoPromotableItem],
      "cost_per_notice_usd",
      { actualUsd: 0.25, maxUsd: 1, pass: true },
    ).blocking,
    true,
    "운영 API 딥분석 release의 실제 비용은 계속 차단한다",
  );
  const subscriptionHumanItem: PromotionReleasePlanItem = {
    ...pendingItem,
    transport: "claude-cli",
    costUsd: 99,
  };
  assert.equal(
    aggregateGate([subscriptionHumanItem], "cost_per_notice_usd").blocking,
    false,
    "일반 사람 검수 release도 claude-cli 명목 비용으로 승격을 차단하지 않는다",
  );
  assert.equal(
    aggregateGate([
      subscriptionHumanItem,
      { ...pendingItem, transport: "api", costUsd: 0.25 },
    ], "cost_per_notice_usd", { actualUsd: 0.25, maxUsd: 1, pass: true }).blocking,
    true,
    "API가 섞인 release는 API subset 비용 게이트를 계속 차단 조건으로 사용한다",
  );
  assert.equal(
    aggregateEvidence([{
      ...pendingItem,
      promotionPlan: {
        ...pendingItem.promotionPlan,
        conversion: {
          ...pendingItem.promotionPlan.conversion,
          verdicts: { correct: 3, needs_edit: 0, wrong: 0, unsure: 21 },
        },
      },
    }]).decidedReviewCount,
    24,
    "일반 사람 검수 release의 unsure는 기존 정밀도 분모에 남아야 한다",
  );
  assert.equal(
    aggregateEvidence([conditionalPromotableItem]).decidedReviewCount,
    0,
    "sealed deep release는 review verdict 분모 자체를 만들지 않아야 한다",
  );

  const rankingConditionalPlan: GrantPromotionPlan = {
    ...plan,
    reviewRisk: {
      schema: "promotion-review-risk-v1",
      disposition: "conditional",
      blockers: [],
      deferrals: [{
        code: "ranking_criterion_suppressed",
        criterionIndex: 2,
        verdict: "needs_edit",
        detail: "우대 criterion을 발행에서 제외",
      }, {
        code: "ranking_condition_unmodeled",
        dimension: "ip",
        detail: "평가 우대만 미반영",
      }],
      suppressedCriterionIndexes: [2],
      suppressedVerdicts: { needsEdit: 1, wrong: 0, unsure: 0 },
      deferredMissedConditions: 1,
    },
  };
  assert.deepEqual(
    aggregateEvidence([{
      ...planItem,
      promotionPlan: {
        ...rankingConditionalPlan,
        conversion: {
          ...rankingConditionalPlan.conversion,
          verdicts: { correct: 9, needs_edit: 1, wrong: 0, unsure: 0 },
          missedConditions: 1,
        },
      },
    }]).effectiveReviewTotals,
    { correct: 9, needsEdit: 0, wrong: 0, unsure: 0, missed: 0 },
    "실제로 억제한 ranking-only 오류만 gate 계산에서 제외하고 원본 totals는 보존한다",
  );
  const auditedLocalItem = {
    ...planItem,
    promotionPlan: {
      ...rankingConditionalPlan,
      origin: "audited" as const,
      auditState: "deterministic_contract" as const,
    },
  };
  assert.equal(
    aggregateGate([auditedLocalItem], "structured_ratio").blocking,
    false,
    "독립 감사된 local conditional 카나리의 구조화 비율은 관찰 지표다",
  );
  assert.equal(
    aggregateGate([auditedLocalItem], "wrong_rate").blocking,
    true,
    "local conditional 카나리도 실제 오류율은 계속 차단한다",
  );
  assert.equal(
    aggregateGate([{
      ...auditedLocalItem,
      promotionPlan: {
        ...auditedLocalItem.promotionPlan,
        reviewRisk: {
          ...auditedLocalItem.promotionPlan.reviewRisk!,
          disposition: "blocked" as const,
        },
      },
    }], "structured_ratio").blocking,
    true,
    "자격 blocker가 있는 local plan은 관찰 지표 예외를 받지 않는다",
  );
}

{
  const needsReviewCriterion = {
    id: "lab-shadow:test:llm-1",
    grant_id: plan.grantId,
    dimension: "other" as const,
    kind: "exclusion" as const,
    operator: "text_only" as const,
    value: { note: "사업장 입지 원문 확인" },
    confidence: 0.9,
    needs_review: true,
    source_field: "analysis_lab_deep",
    source_span: "도내 본사 또는 공장 소재",
    parser_version: "analysis-lab-shadow-v2",
  };
  const auditedConditionalPlan: GrantPromotionPlan = {
    ...plan,
    origin: "audited",
    auditState: "deterministic_contract",
    criteria: [needsReviewCriterion],
    criterionIndexByPosition: [1],
    criterionStableKeys: ["stable-1"],
    reviewRisk: {
      schema: "promotion-review-risk-v1",
      disposition: "conditional",
      blockers: [],
      deferrals: [{
        code: "ranking_criterion_suppressed",
        criterionIndex: 2,
        verdict: "needs_edit",
        detail: "오류가 있는 우대조건은 점수에서 제외",
      }],
      suppressedCriterionIndexes: [2],
      suppressedVerdicts: { needsEdit: 1, wrong: 0, unsure: 0 },
      deferredMissedConditions: 0,
    },
  };
  assert.equal(
    promotionPlanHasUnsafeUnresolvedCriteria(auditedConditionalPlan),
    true,
    "명시적 카나리 선택 없이는 local needs_review를 계속 차단한다",
  );
  assert.equal(
    promotionPlanHasUnsafeUnresolvedCriteria(auditedConditionalPlan, { auditedLocalCanary: true }),
    false,
    "독립 감사된 단일 conditional 카나리만 needs_review를 unknown으로 보존할 수 있다",
  );
  const auditedVerifiedPlan: GrantPromotionPlan = {
    ...auditedConditionalPlan,
    reviewRisk: {
      schema: "promotion-review-risk-v1",
      disposition: "verified",
      blockers: [],
      deferrals: [],
      suppressedCriterionIndexes: [],
      suppressedVerdicts: { needsEdit: 0, wrong: 0, unsure: 0 },
      deferredMissedConditions: 0,
    },
  };
  assert.equal(
    promotionPlanHasUnsafeUnresolvedCriteria(auditedVerifiedPlan, { auditedLocalCanary: true }),
    false,
    "독립 감사된 verified 카나리는 더 약한 conditional 카나리보다 엄격히 차단하지 않는다",
  );
  assert.equal(
    releasePlanItemHasUnsafePendingCriteria({
      ...planItem,
      promotionPlan: auditedVerifiedPlan,
    }),
    false,
    "verified local 카나리의 강등 criterion은 matcher unknown으로 보존 발행한다",
  );
  assert.equal(
    aggregateGate([{
      ...planItem,
      promotionPlan: auditedVerifiedPlan,
    }], "structured_ratio").blocking,
    false,
    "verified local 카나리의 구조화 비율도 관찰 지표다",
  );
  assert.equal(
    aggregateGate([{
      ...planItem,
      promotionPlan: auditedVerifiedPlan,
      transport: "claude-cli",
    }], "cost_per_notice_usd").blocking,
    false,
    "claude-cli local 카나리의 명목 API 환산 비용은 실제 지출 차단 지표가 아니다",
  );
  const auditedApiItem: PromotionReleasePlanItem = {
    ...planItem,
    promotionPlan: auditedVerifiedPlan,
    transport: "api",
  };
  assert.equal(
    aggregateGate(
      [auditedApiItem],
      "cost_per_notice_usd",
      { actualUsd: 0.25, maxUsd: 1, pass: true },
    ).blocking,
    true,
    "audited plan이어도 API 실제 비용은 차단 게이트를 유지한다",
  );
  assert.equal(
    aggregateGate([
      auditedApiItem,
      { ...auditedApiItem, grantId: "mixed-subscription", transport: "claude-cli" },
    ], "cost_per_notice_usd", { actualUsd: 0.25, maxUsd: 1, pass: true }).blocking,
    true,
    "audited API/구독 혼합 release도 API subset 비용을 차단 조건으로 유지한다",
  );
  assert.equal(
    promotionPlanHasUnsafeUnresolvedCriteria({
      ...auditedConditionalPlan,
      resolutions: [{ criterionIndex: 1, state: "pending", decidedBy: null, note: null }],
    }, { auditedLocalCanary: true }),
    true,
    "우대조건 억제 목록 밖 pending은 카나리에서도 차단한다",
  );
  assert.equal(
    promotionPlanHasUnsafeUnresolvedCriteria({
      ...auditedConditionalPlan,
      resolutions: [{ criterionIndex: 2, state: "pending", decidedBy: null, note: "우대조건 오류" }],
    }, { auditedLocalCanary: true }),
    false,
    "발행에서 이미 제거한 preferred pending은 중복 차단하지 않는다",
  );
  assert.equal(
    promotionPlanHasUnsafeUnresolvedCriteria({
      ...auditedConditionalPlan,
      reviewRisk: { ...auditedConditionalPlan.reviewRisk!, disposition: "blocked" },
    }, { auditedLocalCanary: true }),
    true,
    "자격 blocker가 있는 plan은 needs_review 예외를 받을 수 없다",
  );
}

{
  const before = {
    eligibility: "conditional",
    tier: "needs_profile_input",
    decided: 0,
    unknownHard: 2,
  };
  assert.equal(
    isUnexplainedPromotionShadowTransition(before, {
      eligibility: "conditional",
      tier: "needs_core_review",
      decided: 0,
      unknownHard: 16,
    }),
    false,
    "eligibility를 바꾸지 않고 hard unknown 근거가 늘어난 보수화는 설명 가능하다",
  );
  assert.equal(
    isUnexplainedPromotionShadowTransition(before, {
      eligibility: "ineligible",
      tier: "not_recommended",
      decided: 0,
      unknownHard: 16,
    }),
    true,
    "판정 근거 없는 eligibility 변화는 계속 차단해야 한다",
  );

  assert.equal(
    isUnexplainedPromotionShadowTransition({
      eligibility: "conditional",
      tier: "needs_core_review",
      decided: 0,
      unknownHard: 3,
    }, {
      eligibility: "conditional",
      tier: "needs_profile_input",
      decided: 0,
      unknownHard: 5,
    }),
    false,
    "비구조 검토를 질문 가능한 조건으로 바꾼 동일 eligibility 전환은 설명 가능하다",
  );
  assert.equal(
    isUnexplainedPromotionShadowTransition({
      eligibility: "conditional",
      tier: "needs_core_review",
      decided: 0,
      unknownHard: 3,
    }, {
      eligibility: "conditional",
      tier: "needs_profile_input",
      decided: 0,
      unknownHard: 1,
    }),
    true,
    "조건 삭제로 unknown hard가 줄어든 상태 개선은 계속 차단한다",
  );
}

{
  const rawCompanyKey = "bizNo:1234567890";
  const secret = "test-release-artifact-secret-32-characters";
  const first = pseudonymizePromotionCompanyKey(secret, "deep-test-r1", rawCompanyKey);
  const repeated = pseudonymizePromotionCompanyKey(secret, "deep-test-r1", rawCompanyKey);
  const nextRelease = pseudonymizePromotionCompanyKey(secret, "deep-test-r2", rawCompanyKey);
  assert.equal(first, repeated, "같은 릴리스 안에서는 회사 가명키가 안정적이어야 한다");
  assert.notEqual(first, nextRelease, "릴리스가 달라지면 회사 가명키를 연결할 수 없어야 한다");
  assert.equal(JSON.stringify({ companyKey: first, companyLabel: first }).includes(rawCompanyKey), false);
  assert.throws(
    () => pseudonymizePromotionCompanyKey("short", "deep-test-r1", rawCompanyKey),
    /32자/,
  );
}

console.log("promotion release tests: ok");
