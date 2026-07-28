import assert from "node:assert/strict";
import {
  DEEP_ANALYSIS_ADJUDICATION_INPUT_RESERVE_TOKENS,
  DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
  priceDeepAnalysisUsage,
  reserveDeepAnalysisPreAuditCost,
  sumDeepAnalysisActualCosts,
} from "./costPolicy";

const introPricingAt = new Date("2026-07-27T00:00:00.000Z");
const standardPricingAt = new Date("2026-09-01T00:00:00.000Z");
const usage = {
  inputTokens: 100_000,
  outputTokens: 20_000,
  cacheReadTokens: 10_000,
};

assert.equal(priceDeepAnalysisUsage({
  model: "claude-opus-4-8",
  usage,
  pricedAt: introPricingAt,
}), 1.005);
assert.equal(priceDeepAnalysisUsage({
  model: "claude-sonnet-5",
  usage,
  pricedAt: introPricingAt,
}), 0.402);
assert.equal(priceDeepAnalysisUsage({
  model: "claude-sonnet-5",
  usage,
  pricedAt: standardPricingAt,
}), 0.603);
assert.equal(priceDeepAnalysisUsage({
  model: "claude-fable-5",
  usage,
  pricedAt: introPricingAt,
}), 2.01);
assert.equal(priceDeepAnalysisUsage({
  model: "claude-haiku-4-5-20251001",
  usage,
  pricedAt: introPricingAt,
}), 0.201);
assert.equal(priceDeepAnalysisUsage({
  model: "claude-opus-5",
  usage,
  pricedAt: introPricingAt,
}), 1.005);
assert.equal(priceDeepAnalysisUsage({
  model: "unknown-model",
  usage,
  pricedAt: introPricingAt,
}), null);
assert.equal(priceDeepAnalysisUsage({
  model: "claude-opus-4-8",
  usage: { ...usage, inputTokens: -1 },
  pricedAt: introPricingAt,
}), null);

const sonnetReservation = reserveDeepAnalysisPreAuditCost({
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  adjudicationModel: "claude-sonnet-5",
  primaryUsage: usage,
  pricedAt: introPricingAt,
});
assert.ok(sonnetReservation);
assert.equal(sonnetReservation.primaryCostUsd, 1.005);
assert.equal(sonnetReservation.auditExecutionReserveUsd, 0.42);
assert.equal(
  sonnetReservation.adjudicationInputReserveTokens,
  DEEP_ANALYSIS_ADJUDICATION_INPUT_RESERVE_TOKENS,
);
assert.equal(
  sonnetReservation.adjudicationOutputReserveTokens,
  DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
);
assert.equal(sonnetReservation.adjudicationReserveUsd, 0.18);
assert.equal(sonnetReservation.adjudicationModel, "claude-sonnet-5");
assert.ok(Math.abs(sonnetReservation.projectedTotalCostUsd - 1.605) < 1e-12);

const fableReservation = reserveDeepAnalysisPreAuditCost({
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-fable-5",
  adjudicationModel: "claude-fable-5",
  primaryUsage: usage,
  pricedAt: introPricingAt,
});
assert.ok(fableReservation);
assert.equal(fableReservation.auditExecutionReserveUsd, 2.1);
assert.equal(fableReservation.adjudicationReserveUsd, 0.9);
assert.ok(fableReservation.projectedTotalCostUsd > 2);

// 2026-07-27 bounded run과 동일한 primary $1.123690을 재현하는 no-cache usage는
// 현재 Sonnet 5 가격과 bounded adjudication reserve를 적용하면 $2 안에 남는다.
const boundedCheckpointReservation = reserveDeepAnalysisPreAuditCost({
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  adjudicationModel: "claude-sonnet-5",
  primaryUsage: {
    inputTokens: 124_738,
    outputTokens: 20_000,
    cacheReadTokens: null,
  },
  pricedAt: introPricingAt,
});
assert.ok(boundedCheckpointReservation);
assert.equal(boundedCheckpointReservation.primaryCostUsd, 1.12369);
assert.equal(boundedCheckpointReservation.auditExecutionReserveUsd, 0.449476);
assert.ok(boundedCheckpointReservation.projectedTotalCostUsd < 2);

assert.equal(reserveDeepAnalysisPreAuditCost({
  primaryModel: "claude-opus-4-8",
  auditModel: "claude-sonnet-5",
  adjudicationModel: "claude-sonnet-5",
  primaryUsage: null,
  pricedAt: introPricingAt,
}), null);
const candidateReservation = reserveDeepAnalysisPreAuditCost({
  primaryModel: "claude-sonnet-5",
  auditModel: "claude-haiku-4-5-20251001",
  adjudicationModel: "claude-opus-5",
  primaryUsage: usage,
  pricedAt: standardPricingAt,
});
assert.ok(candidateReservation);
assert.equal(candidateReservation.primaryCostUsd, 0.603);
assert.equal(candidateReservation.auditExecutionReserveUsd, 0.21);
assert.equal(candidateReservation.adjudicationReserveUsd, 0.45);
assert.ok(Math.abs(candidateReservation.projectedTotalCostUsd - 1.263) < 1e-12);
assert.equal(sumDeepAnalysisActualCosts([1.005, 0.402, 0.18]), 1.587);
assert.equal(sumDeepAnalysisActualCosts([1.005, null]), null);
assert.equal(sumDeepAnalysisActualCosts([1.005, Number.NaN]), null);

console.log("deep-analysis cost policy tests passed");
