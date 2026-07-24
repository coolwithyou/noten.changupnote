import assert from "node:assert/strict";
import {
  verifyAppliedPromotionSnapshot,
  type PromotionVerificationIssue,
} from "./verify-promotion";
import {
  promotionGrantSnapshotStateSha256,
  type PromotionGrantSnapshot,
} from "./promotion-snapshot";

function snapshot(): PromotionGrantSnapshot {
  return {
    grantId: "g1",
    criteria: [{
      id: "c1",
      grantId: "g1",
      dimension: "size",
      operator: "in",
      value: { values: ["small"] },
      kind: "required",
      weight: null,
      confidence: 0.9,
      sourceSpan: "소기업",
      rawText: null,
      sourceField: null,
      stableKey: "stable-1",
      needsReview: false,
      parserVersion: "lab-deep-v3",
    }],
    questions: [{
      id: "q1",
      grantId: "g1",
      grantCriteriaId: "c1",
      criterionStableKey: "stable-1",
      definitionSha256: "definition-1",
      version: 1,
      supersedesQuestionId: null,
      criterionRef: null,
      prompt: "소기업인가요?",
      options: [],
      answerType: "single",
      reusable: "per_notice",
      conditionKey: null,
      promptVer: "v1",
      provenance: {},
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: "2026-07-25T00:00:00.000Z",
    }],
    answerBindings: [{
      questionId: "q1",
      count: 1,
      identitySha256: "answers-v1",
    }],
    dedupComponentGrantIds: ["g1"],
    dedupLinks: [],
  };
}

{
  const current = snapshot();
  const issues = verifyAppliedPromotionSnapshot({
    grantId: "g1",
    planStableKeys: ["stable-1"],
    plannedQuestions: [{ criterionStableKey: "stable-1", definitionSha256: "definition-1" }],
    beforeSnapshot: snapshot(),
    currentSnapshot: current,
    expectedStateSha256: promotionGrantSnapshotStateSha256(current),
  });
  assert.deepEqual(issues, []);
}

{
  const current = snapshot();
  current.questions[0]!.grantCriteriaId = null;
  current.answerBindings = [];
  const issues: PromotionVerificationIssue[] = verifyAppliedPromotionSnapshot({
    grantId: "g1",
    planStableKeys: ["stable-1"],
    plannedQuestions: [{ criterionStableKey: "stable-1", definitionSha256: "definition-1" }],
    beforeSnapshot: snapshot(),
    currentSnapshot: current,
    expectedStateSha256: promotionGrantSnapshotStateSha256(current),
  });
  assert.ok(issues.some((issue) => issue.code === "question_anchor"));
  assert.ok(issues.some((issue) => issue.code === "answer_binding_deleted"));
}

console.log("verify promotion tests: ok");
