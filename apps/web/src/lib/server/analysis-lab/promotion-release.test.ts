import assert from "node:assert/strict";
import type { GrantPromotionPlan } from "./promote";
import {
  assertManifestConfirmation,
  canonicalJson,
  createPromotionReleaseManifest,
  isUnexplainedPromotionShadowTransition,
  releasePlanItemHasUnsafePendingCriteria,
  mergePromotionApprovalGateEvidence,
  planSha256,
  pseudonymizePromotionCompanyKey,
  validatePromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "./promotion-release";

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

function manifest() {
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
    plans: [planItem],
  });
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
  assert.equal(first.releasePlanSha256, second.releasePlanSha256);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(validatePromotionReleaseManifest(first), first);
  assert.doesNotThrow(() => assertManifestConfirmation(first, first.manifestSha256.slice(0, 12)));
  assert.throws(() => assertManifestConfirmation(first, "short"), /12자/);
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
