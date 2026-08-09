import assert from "node:assert/strict";
import type { LabAudit, LabAuditItem } from "@/features/dev/analysis-lab/contract";
import { isAiAdjudicationResolved } from "@/features/dev/analysis-lab/contract";
import {
  buildAdjudicationJudgments,
  buildAiAdjudicationSystemPrompt,
  renderAdjudicationConflictContext,
  selectPendingAdjudicationItems,
} from "./ai-adjudication";
import { applyAiAdjudicationJudgments, isLabAuditComplete } from "./audit-store";

const criterion: LabAuditItem = {
  kind: "criterion",
  criterionIndex: 2,
  reason: "ai_non_correct",
  aiVerdict: "needs_edit",
  aiNote: "기계 판정이 반대임",
  humanVerdict: null,
  note: null,
  aiAuditVerdict: "correct",
  aiAuditNote: null,
};
const axis: LabAuditItem = {
  kind: "axis",
  dimension: "other",
  reason: "missed_condition_flag",
  aiVerdict: "missed_condition",
  aiNote: "우대 체크박스",
  aiMatchImpact: "ranking",
  humanVerdict: null,
  note: null,
  aiAuditVerdict: "confirmed_absent",
  aiAuditNote: "서식만으로는 조건 아님",
};
const audit: LabAudit = {
  schema: "lab-audit-v1",
  grantId: "g1",
  runId: "run-1",
  model: "claude-fable-5",
  aiPromptVersion: "ai-review-v7",
  auditorEmail: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  items: [criterion, axis],
  overallNote: null,
  aiAuditModel: "claude-sonnet-5",
};

assert.equal(selectPendingAdjudicationItems(audit).length, 2);
assert.match(buildAiAdjudicationSystemPrompt("기준"), /다수결이나 기존 모델의 권위가 아니라/);
assert.match(renderAdjudicationConflictContext([criterion]), /1차 검수: needs_edit[\s\S]*2차 감사: correct/);

const judgments = buildAdjudicationJudgments([criterion, axis], {
  ok: true,
  criterionReviews: [{ criterionIndex: 2, verdict: "correct", note: "원문과 구조가 일치함" }],
  axisReviews: [{ dimension: "other", verdict: "missed_condition", note: "우대 효과 명시", matchImpact: "ranking" }],
});
const merged = applyAiAdjudicationJudgments(audit, {
  model: "claude-opus-5",
  promptVersion: "ai-adjudication-v1",
  transport: "claude-cli",
  judgments,
  now: "2026-08-09T01:00:00.000Z",
});
assert.equal(merged.status, "ok");
if (merged.status !== "ok") throw new Error("unreachable");
assert.equal(merged.applied, 2);
assert.equal(isAiAdjudicationResolved(merged.audit.items[0]!), true);
assert.equal(isAiAdjudicationResolved(merged.audit.items[1]!), true);
assert.equal(isLabAuditComplete(merged.audit), true);
assert.equal(merged.audit.items[0]!.humanVerdict, null, "사람 판정 필드는 사용하지 않음");
assert.equal(merged.audit.aiAdjudicationTransport, "claude-cli");
assert.equal(selectPendingAdjudicationItems(merged.audit).length, 0);

assert.throws(
  () => buildAdjudicationJudgments([criterion], {
    ok: true,
    criterionReviews: [{ criterionIndex: 2, verdict: "unsure", note: "모름" }],
    axisReviews: [],
  }),
  /unsure/,
);
assert.equal(applyAiAdjudicationJudgments(audit, {
  model: "claude-sonnet-5",
  promptVersion: "v1",
  transport: "claude-cli",
  judgments: [],
}).status, "invalid", "2차 감사 모델 자기 판정 차단");

assert.equal(applyAiAdjudicationJudgments(audit, {
  model: "claude-fable-5",
  promptVersion: "v1",
  transport: "claude-cli",
  judgments: [],
}).status, "invalid", "1차 검수 모델 자기 판정 차단");

console.log("✅ AI 3차 판정 — 충돌 전용 선택·Opus provenance·사람 필드 불가침·완료 판정");
