import assert from "node:assert/strict";
import type { GrantPromotionPlan } from "./promote";
import {
  assertManifestConfirmation,
  canonicalJson,
  createPromotionReleaseManifest,
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
