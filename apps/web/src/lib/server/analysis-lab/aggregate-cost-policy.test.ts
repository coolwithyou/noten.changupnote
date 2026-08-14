import assert from "node:assert/strict";
import { summarizeReviewedRunCosts } from "./aggregate-cost-policy";

{
  const summary = summarizeReviewedRunCosts([
    { transport: "claude-cli", costUsd: 4 },
    { transport: "claude-cli", costUsd: 6 },
  ], 1);

  assert.deepEqual(summary.subscription, {
    runCount: 2,
    costSampleCount: 2,
    totalUsd: 10,
    averageUsd: 5,
  });
  assert.deepEqual(summary.api, {
    runCount: 0,
    costSampleCount: 0,
    totalUsd: 0,
    averageUsd: null,
  });
  assert.equal(summary.apiCostGate, null, "전부 구독이면 비용 gate를 판정 수와 종합 verdict에서 제외");
  console.log("✅ 전부 구독 비용 — 높은 명목 USD는 telemetry-only, API 비용 gate 없음");
}

{
  const summary = summarizeReviewedRunCosts([
    { transport: "api", costUsd: 0.5 },
    { costUsd: 2.5 },
  ], 1);

  assert.deepEqual(summary.api, {
    runCount: 2,
    costSampleCount: 2,
    totalUsd: 3,
    averageUsd: 1.5,
  });
  assert.deepEqual(summary.apiCostGate, {
    actualUsd: 1.5,
    maxUsd: 1,
    pass: false,
  });
  assert.equal(summary.subscription.runCount, 0);
  console.log("✅ API 비용 — transport 미기록 legacy도 API로 보고 API 평균에 기존 $1 gate 적용");
}

{
  const summary = summarizeReviewedRunCosts([
    { transport: "api", costUsd: 0.25 },
    { transport: "claude-cli", costUsd: 40 },
    { transport: "claude-cli", costUsd: 60 },
    { costUsd: 0.75 },
  ], 1);

  assert.deepEqual(summary.apiCostGate, {
    actualUsd: 0.5,
    maxUsd: 1,
    pass: true,
  });
  assert.deepEqual(summary.subscription, {
    runCount: 2,
    costSampleCount: 2,
    totalUsd: 100,
    averageUsd: 50,
  });
  console.log("✅ 혼합 비용 — API subset만 gate, 구독 명목 USD는 별도 telemetry");
}
