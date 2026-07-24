import assert from "node:assert/strict";
import type {
  LabAudit,
  LabCriterion,
  LabReview,
  LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  criterionNeedsReview,
  publishesConfirmationQuestion,
  publishesCriterion,
  resolveCriterionStates,
} from "./criterion-resolution";
import type { HumanReviewOverlay } from "./human-review-overlay";

const criteria: LabCriterion[] = [
  criterion("region", "required"),
  criterion("prior_award", "exclusion"),
  criterion("sanction", "exclusion"),
  criterion("tax_compliance", "exclusion"),
  criterion("biz_age", "required"),
];
const run: LabRun = {
  runId: "resolution-run",
  grantId: "00000000-0000-4000-8000-000000000101",
  source: "bizinfo",
  sourceId: "resolution-source",
  title: "resolver 테스트",
  model: "test-model",
  promptVersion: "lab-deep-v3",
  startedAt: "2026-07-23T00:00:00.000Z",
  durationMs: 1,
  inputBlocks: [],
  inputTotalChars: 0,
  inputSha256: "0".repeat(64),
  usage: null,
  costUsd: null,
  analysisMarkdown: "",
  programIntent: null,
  criteria,
  axisAssessments: [],
  taxonomyProposals: [],
  dimensionDiffs: [],
  error: null,
};
const aiReview = {
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct" as const, note: "표본 밖 correct" },
    { criterionIndex: 1, verdict: "correct" as const, note: "감사 대기" },
    { criterionIndex: 2, verdict: "correct" as const, note: "AI 감사 일치" },
    { criterionIndex: 3, verdict: "correct" as const, note: "사람 감사 뒤집기" },
    { criterionIndex: 4, verdict: "correct" as const, note: "overlay 우선" },
  ],
};
const audit: LabAudit = {
  schema: "lab-audit-v1",
  grantId: run.grantId,
  runId: run.runId,
  model: "review-model",
  aiPromptVersion: "ai-review-v1",
  aiAuditModel: "audit-model",
  aiAuditPromptVersion: "ai-audit-v1",
  auditorEmail: "auditor@noten.im",
  createdAt: "2026-07-23T01:00:00.000Z",
  updatedAt: "2026-07-23T01:00:00.000Z",
  items: [
    auditItem(1, null, "unsure"),
    auditItem(2, null, "correct"),
    auditItem(3, "wrong", null),
    auditItem(4, "wrong", null),
  ],
  overallNote: null,
};
const humanReview: LabReview = {
  grantId: run.grantId,
  runId: run.runId,
  reviewerEmail: "human@noten.im",
  createdAt: "2026-07-23T02:00:00.000Z",
  updatedAt: "2026-07-23T02:00:00.000Z",
  criterionReviews: [{ criterionIndex: 3, verdict: "needs_edit", note: "사람 review 우선" }],
  axisReviews: [],
  overallNote: null,
};
const overlay: HumanReviewOverlay = {
  schema: "human-review-overlay-v1",
  grantId: run.grantId,
  runId: run.runId,
  createdAt: "2026-07-23T03:00:00.000Z",
  updatedAt: "2026-07-23T03:00:00.000Z",
  items: [{
    sourceItemKey: "criterion:4",
    itemKind: "criterion",
    criterionIndex: 4,
    humanVerdict: "correct",
    note: "overlay가 최우선",
    decidedBy: "overlay@noten.im",
    decidedAt: "2026-07-23T03:00:00.000Z",
    revision: 1,
  }],
};

const resolved = resolveCriterionStates({ run, aiReview, audit, humanReview, overlay });
assert.deepEqual(
  resolved.map((item) => item.state),
  [
    "unaudited_correct",
    "pending",
    "confirmed_correct",
    "confirmed_edited",
    "confirmed_correct",
  ],
  "overlay > 사람 review > 감사 사람 판정 > AI 감사 일치 > 표본 밖 correct 순서여야 한다",
);
assert.equal(resolved[3]?.decidedBy, "human@noten.im");
assert.equal(resolved[4]?.decidedBy, "overlay@noten.im");

assert.equal(publishesCriterion("confirmed_correct"), true);
assert.equal(publishesCriterion("unaudited_correct"), true);
assert.equal(publishesCriterion("pending"), true, "pending도 needs_review=true로 발행해야 한다");
assert.equal(publishesCriterion("confirmed_edited"), false);
assert.equal(publishesCriterion("confirmed_wrong"), false);
assert.equal(criterionNeedsReview("pending"), true);
assert.equal(
  criterionNeedsReview("unaudited_correct"),
  true,
  "독립 감사·사람 판정 없는 AI correct는 비차단 노출하되 추천·탈락을 확정하면 안 된다",
);
assert.equal(publishesConfirmationQuestion("confirmed_correct"), true);
assert.equal(publishesConfirmationQuestion("pending"), false, "pending exclusion 질문은 발행하면 안 된다");
assert.equal(publishesConfirmationQuestion("unaudited_correct"), false, "질문은 사람/감사 확정 exclusion만 허용한다");

console.log("criterion-resolution tests: ok");

function criterion(
  dimension: LabCriterion["dimension"],
  kind: LabCriterion["kind"],
): LabCriterion {
  return {
    dimension,
    kind,
    operator: "exists",
    value: {},
    confidence: 0.9,
    sourceSpan: "근거",
    spanVerified: true,
    note: null,
  };
}

function auditItem(
  criterionIndex: number,
  humanVerdict: "wrong" | null,
  aiAuditVerdict: "correct" | "unsure" | null,
): LabAudit["items"][number] {
  return {
    kind: "criterion",
    criterionIndex,
    dimension: criteria[criterionIndex]!.dimension,
    reason: "correct_sample",
    aiVerdict: "correct",
    aiNote: null,
    humanVerdict,
    note: humanVerdict ? "사람 판정" : null,
    aiAuditVerdict,
    aiAuditNote: aiAuditVerdict ? "AI 감사 판정" : null,
  };
}
