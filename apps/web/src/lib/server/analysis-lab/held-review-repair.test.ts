import assert from "node:assert/strict";
import type { LabReview, LabRun } from "@/features/dev/analysis-lab/contract";
import { buildHeldReviewRepairPlan } from "./held-review-repair";

const run = {
  runId: "run-old",
  criteria: [
    { kind: "required", dimension: "size", operator: "in", value: { sizes: ["중소기업"] } },
    { kind: "preferred", dimension: "prior_award", operator: "not_in", value: {} },
  ],
} as LabRun;
const review = {
  criterionReviews: [
    { criterionIndex: 0, verdict: "needs_edit", note: "상세 공고가 더 넓은 대상을 허용함" },
    { criterionIndex: 1, verdict: "needs_edit", note: "우대 극성 반전" },
  ],
  axisReviews: [],
} as Pick<LabReview, "criterionReviews" | "axisReviews">;
const plan = buildHeldReviewRepairPlan({ run, review });
assert.ok(plan);
assert.equal(plan.blockingCount, 1, "preferred 오류는 억제 가능한 랭킹 보류이므로 재분석 blocker에서 제외");
assert.match(plan.taskInstruction, /VERIFIED_REVIEW_BLOCKERS/);
assert.match(plan.taskInstruction, /상세 공고가 더 넓은 대상을 허용함/);
assert.doesNotMatch(plan.taskInstruction, /우대 극성 반전/);

const safe = buildHeldReviewRepairPlan({
  run,
  review: {
    criterionReviews: [
      { criterionIndex: 0, verdict: "correct", note: null },
      { criterionIndex: 1, verdict: "needs_edit", note: "랭킹만 보류" },
    ],
    axisReviews: [],
  },
});
assert.equal(safe, null, "조건부 안전 종결을 불필요하게 재분석하지 않음");
console.log("✅ held review repair — 신청자격 blocker만 Opus 재분석 피드백으로 좁힘");
