import assert from "node:assert/strict";
import test from "node:test";
import { GRANT_PRODUCT_READINESS_SCHEMA, type GrantReadiness } from "./grantReadiness";
import { planGrantNextWork } from "./grantNextWork";
import type { GrantSourceChangeImpact, GrantSourceChangeClassification } from "../ingestion/grantSourceChangeImpact";

function readiness(blockerCodes: GrantReadiness["blockerCodes"]): GrantReadiness {
  return {
    schema: GRANT_PRODUCT_READINESS_SCHEMA,
    category: blockerCodes.length === 0 ? "A" : "D",
    blockerCodes,
    eligibleQuestionCount: 0,
    eligibleQuestionCoveredCount: 0,
  };
}

function impact(classification: GrantSourceChangeClassification): GrantSourceChangeImpact {
  return {
    schema: "grant-source-change-impact-v2",
    classification,
    changedDomains: ["raw"],
    previousRawSha256: "a".repeat(64),
    currentRawSha256: "b".repeat(64),
    requiresModelRun: false,
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

test("검증된 변경 영향은 완료 단계를 보존한 최소 후속 작업으로 재개한다", () => {
  const changed = readiness(["source_revision_changed"]);
  assert.equal(planGrantNextWork(changed, impact("evidence_refresh")).action, "source_rebind");
  assert.equal(planGrantNextWork(changed, impact("recruitment_only")).action, "recruitment_refresh");
  assert.equal(planGrantNextWork(changed, impact("coverage_review_required")).action, "coverage_review");
  assert.equal(planGrantNextWork(changed, impact("condition_review_required")).action, "condition_review");
  assert.equal(planGrantNextWork(changed, impact("unknown_review_required")).action, "source_change_review");
  for (const classification of [
    "evidence_refresh",
    "recruitment_only",
    "coverage_review_required",
    "condition_review_required",
  ] as const) {
    assert.equal(planGrantNextWork(changed, impact(classification)).requiresModelRun, false);
  }
});

test("차단이 없으면 기존 결과를 재사용한다", () => {
  assert.equal(planGrantNextWork(readiness([])).action, "reuse_ready");
});

console.log("grant next work: minimal resumable action routing passed");
