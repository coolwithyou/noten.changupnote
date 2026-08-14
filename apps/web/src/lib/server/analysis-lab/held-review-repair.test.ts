import assert from "node:assert/strict";
import type { LabReview, LabRun } from "@/features/dev/analysis-lab/contract";
import {
  buildHeldReviewRepairPlan,
  combineHeldReviewRepairPlans,
  LAB_HELD_REVIEW_MEMORY_RUN_LIMIT,
} from "./held-review-repair";
import { runLabAnalysis } from "./analyze";
import { resolveRepairApplicationRoundtripOptions } from "./application-roundtrip-policy";
import { AnalysisLabExecutionPausedError } from "./analysis-execution-admission";

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

const cumulative = combineHeldReviewRepairPlans([
  plan,
  {
    blockingCount: 2,
    taskInstruction: "두 번째 run에서 확정한 교정",
  },
]);
assert.ok(cumulative);
assert.equal(cumulative.blockingCount, 3);
assert.match(cumulative.taskInstruction, /상세 공고가 더 넓은 대상을 허용함/);
assert.match(cumulative.taskInstruction, /두 번째 run에서 확정한 교정/);
assert.equal(LAB_HELD_REVIEW_MEMORY_RUN_LIMIT, 5);

await assert.rejects(
  runLabAnalysis("unused-grant", { roundtripModel: "claude-opus-roundtrip" }),
  /roundtripModel은 withApplicationRoundtrip=true와 함께 지정해야 합니다/,
  "단건 분석도 Kordoc 모델만 암묵적으로 지정할 수 없다",
);
await assert.rejects(
  runLabAnalysis("unused-grant", { reuseApplicationRoundtripRunId: "kordoc-existing" }),
  /reuseApplicationRoundtripRunId는 withApplicationRoundtrip=true와 함께 지정해야 합니다/,
  "기존 Kordoc run 재사용도 명시적 opt-in 없이 실행할 수 없다",
);
await assert.rejects(
  runLabAnalysis("unused-grant"),
  AnalysisLabExecutionPausedError,
  "단건·smoke·수동 repair도 Gate R 전에는 DB/모델 실행 전에 차단한다",
);

assert.deepEqual(
  resolveRepairApplicationRoundtripOptions({
    contract: "deep",
    existingRunId: "kordoc-existing",
    model: "claude-opus-5",
  }),
  {
    withApplicationRoundtrip: true,
    reuseApplicationRoundtripRunId: "kordoc-existing",
    roundtripModel: "claude-opus-5",
  },
  "deep repair는 기존 Kordoc run이 있을 때만 검증 후 재사용한다",
);
assert.deepEqual(
  resolveRepairApplicationRoundtripOptions({
    contract: "deep",
    existingRunId: null,
    model: "claude-opus-5",
  }),
  {},
  "기존 Kordoc run이 없는 deep repair는 딥분석만 실행한다",
);
assert.deepEqual(
  resolveRepairApplicationRoundtripOptions({
    contract: "application",
    existingRunId: "kordoc-existing",
    model: "claude-opus-5",
  }),
  {
    withApplicationRoundtrip: true,
    roundtripModel: "claude-opus-5",
  },
  "application repair는 기존 run을 재사용하지 않고 end-to-end로 다시 실행한다",
);
console.log("✅ held review repair — 신청자격 blocker만 Opus 재분석 피드백으로 좁힘");
