import assert from "node:assert/strict";
import test from "node:test";
import { GRANT_PRODUCT_READINESS_SCHEMA, type GrantReadiness } from "./grantReadiness";
import { planGrantNextWork } from "./grantNextWork";

function readiness(blockerCodes: GrantReadiness["blockerCodes"]): GrantReadiness {
  return {
    schema: GRANT_PRODUCT_READINESS_SCHEMA,
    category: blockerCodes.length === 0 ? "A" : "D",
    blockerCodes,
    eligibleQuestionCount: 0,
    eligibleQuestionCoveredCount: 0,
  };
}

test("분석 결과가 있고 발행 결속만 없으면 모델을 다시 실행하지 않는다", () => {
  const actual = planGrantNextWork(readiness([
    "analysis_source_binding_missing",
    "analysis_attachment_binding_missing",
    "criteria_structure_incomplete",
    "criteria_review_incomplete",
  ]));
  assert.equal(actual.action, "condition_review");
  assert.equal(actual.requiresModelRun, false);
});

test("질문만 빠진 공고는 질문 준비로 보내고 모델을 다시 실행하지 않는다", () => {
  const actual = planGrantNextWork(readiness(["eligible_question_missing"]));
  assert.equal(actual.action, "question_preparation");
  assert.equal(actual.requiresModelRun, false);
});

test("원문 변경은 영향 검토가 먼저이며 분석 없음만 모델 실행 후보가 된다", () => {
  assert.deepEqual(planGrantNextWork(readiness(["source_revision_changed"])), {
    schema: "grant-next-work-v1",
    action: "source_change_review",
    requiresModelRun: false,
    blockerCodes: ["source_revision_changed"],
  });
  assert.equal(planGrantNextWork(readiness(["analysis_missing"])).requiresModelRun, true);
});

test("차단이 없으면 기존 결과를 재사용한다", () => {
  assert.equal(planGrantNextWork(readiness([])).action, "reuse_ready");
});

console.log("grant next work: minimal resumable action routing passed");
