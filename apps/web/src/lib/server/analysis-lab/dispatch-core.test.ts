import assert from "node:assert/strict";
import type { LabAudit, LabRun } from "@/features/dev/analysis-lab/contract";
import {
  assignDispatchCandidates,
  buildDispatchCandidateItems,
  computeAgreementMetrics,
  excludePreviouslyDispatched,
  limitQuestionSpotchecks,
  type DispatchNoticeCandidate,
} from "./dispatch-core";

const run = {
  runId: "run-2026-07-23T000000.000Z-deadbe",
  grantId: "00000000-0000-4000-8000-000000000001",
  source: "bizinfo",
  sourceId: "source-1",
  title: "검수 배분 테스트",
  model: "extractor",
  promptVersion: "lab-deep-v3",
  startedAt: "2026-07-23T00:00:00.000Z",
  durationMs: 1,
  inputBlocks: [],
  inputTotalChars: 1,
  inputSha256: "0".repeat(64),
  usage: null,
  costUsd: null,
  analysisMarkdown: "",
  programIntent: null,
  criteria: [
    {
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { regions: ["41"] },
      confidence: 0.5,
      sourceSpan: "경기도",
      spanVerified: false,
      note: null,
    },
  ],
  axisAssessments: [],
  taxonomyProposals: [],
  dimensionDiffs: [],
  error: null,
} satisfies LabRun;

const review = {
  runId: run.runId,
  grantId: run.grantId,
  model: "reviewer-model",
  promptVersion: "ai-review-v2",
  createdAt: "2026-07-23T01:00:00.000Z",
  criterionReviews: [{ criterionIndex: 0, verdict: "needs_edit" as const, note: "수정" }],
  axisReviews: [],
};

const audit = {
  schema: "lab-audit-v1",
  grantId: run.grantId,
  runId: run.runId,
  model: review.model,
  aiPromptVersion: review.promptVersion,
  auditorEmail: null,
  createdAt: review.createdAt,
  updatedAt: review.createdAt,
  items: [{
    kind: "criterion" as const,
    criterionIndex: 0,
    reason: "ai_non_correct" as const,
    aiVerdict: "needs_edit",
    aiNote: "수정",
    humanVerdict: null,
    note: null,
  }],
  overallNote: null,
} satisfies LabAudit;

const items = buildDispatchCandidateItems({ run, review, audit });
assert.deepEqual(items.map((item) => item.sourceItemKey), ["audit:c:0"]);
assert.equal(items[0]?.collectTarget, "audit_file", "동결 감사 대상은 overlay로 중복 배분하면 안 된다");
assert.equal(
  excludePreviouslyDispatched(run.runId, items, new Set([`${run.runId}:audit:c:0`])).length,
  0,
  "기배분 source_item_key는 다음 주에도 중복 배분하면 안 된다",
);

const notices: DispatchNoticeCandidate[] = Array.from({ length: 10 }, (_, index) => ({
  run: { ...run, runId: `${run.runId.slice(0, -6)}${index.toString(16).padStart(6, "0")}` },
  review,
  audit,
  items,
}));
const first = assignDispatchCandidates(notices, { seed: 42, reviewerCount: 2, overlapRatio: 0.15 });
const second = assignDispatchCandidates(notices, { seed: 42, reviewerCount: 2, overlapRatio: 0.15 });
assert.deepEqual(first, second, "같은 seed의 배분은 결정론적이어야 한다");
assert.equal(first.filter((item) => item.blind).length, 4, "10공고의 15% 반올림=2공고가 양측 blind로 배분된다");

const questionNotices: DispatchNoticeCandidate[] = notices.map((notice, index) => ({
  ...notice,
  items: [{
    sourceItemKey: `overlay:q:${index}`,
    collectTarget: "overlay",
    itemKind: "question_check",
    criterionIndex: index,
    dimension: "region",
    payload: {},
  }],
}));
const limitedQuestions = limitQuestionSpotchecks(questionNotices, { seed: 42, limit: 3 });
assert.equal(limitedQuestions.reduce((sum, notice) => sum + notice.items.length, 0), 3);
assert.deepEqual(
  limitedQuestions,
  limitQuestionSpotchecks(questionNotices, { seed: 42, limit: 3 }),
  "질문 스팟체크 표본도 같은 seed에서 결정론적이어야 한다",
);

const metrics = computeAgreementMetrics([
  { itemKind: "criterion", overlapGroup: "g1", humanVerdict: "correct", raterKey: "young" },
  { itemKind: "criterion", overlapGroup: "g1", humanVerdict: "correct", raterKey: "kim" },
  { itemKind: "axis", overlapGroup: "g2", humanVerdict: "confirmed_absent", raterKey: "kim" },
  { itemKind: "axis", overlapGroup: "g2", humanVerdict: "confirmed_absent", raterKey: "young" },
  { itemKind: "question_check", overlapGroup: "g3", humanVerdict: "correct", raterKey: "kim" },
  { itemKind: "question_check", overlapGroup: "g3", humanVerdict: "correct", raterKey: "young" },
  { itemKind: "question_check", overlapGroup: "g4", humanVerdict: "correct", raterKey: "kim" },
  { itemKind: "question_check", overlapGroup: "g4", humanVerdict: "wrong", raterKey: "young" },
]);
assert.equal(metrics.length, 3, "item_kind별로 분리해야 한다");
const criterionMetric = metrics.find((metric) => metric.itemKind === "criterion");
assert.equal(criterionMetric?.agreementRate, 1);
assert.equal(criterionMetric?.kappa, null, "단일 범주 완전 일치는 κ N/A다");
const questionMetric = metrics.find((metric) => metric.itemKind === "question_check");
assert.equal(questionMetric?.pairCount, 2);
assert.equal(questionMetric?.agreementRate, 0.5);
assert.equal(questionMetric?.kappa, 0, "정상 분모의 Cohen κ를 계산해야 한다");
assert.deepEqual(questionMetric?.categoryDistribution, { correct: 3, wrong: 1 });

console.log("dispatch-core tests: ok");
