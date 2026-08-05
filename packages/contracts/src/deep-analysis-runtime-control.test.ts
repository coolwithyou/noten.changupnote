import assert from "node:assert/strict";
import {
  canRunLocalSubscriptionAnalysis,
  canRunProductionDeepAnalysis,
  effectiveDeepAnalysisRuntimeMode,
  parseDeepAnalysisRuntimeMode,
  type DeepAnalysisRuntimeControl,
} from "./deep-analysis-runtime-control.js";

const base: DeepAnalysisRuntimeControl = {
  controlKey: "global",
  mode: "paused",
  generation: 1,
  changedBy: "test",
  changeReason: null,
  localOwnerId: null,
  localLeaseExpiresAt: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};
const now = new Date("2026-08-05T01:00:00.000Z");

assert.equal(effectiveDeepAnalysisRuntimeMode(base, now), "paused");
assert.equal(canRunProductionDeepAnalysis(base, now), false);

const production = { ...base, mode: "production_api" as const };
assert.equal(canRunProductionDeepAnalysis(production, now), true);
assert.equal(canRunLocalSubscriptionAnalysis(production, "owner-a", now), false);

const local = {
  ...base,
  mode: "local_subscription" as const,
  localOwnerId: "owner-a",
  localLeaseExpiresAt: "2026-08-05T01:02:00.000Z",
};
assert.equal(effectiveDeepAnalysisRuntimeMode(local, now), "local_subscription");
assert.equal(canRunLocalSubscriptionAnalysis(local, "owner-a", now), true);
assert.equal(canRunLocalSubscriptionAnalysis(local, "owner-b", now), false);

const expired = { ...local, localLeaseExpiresAt: "2026-08-05T01:00:00.000Z" };
assert.equal(effectiveDeepAnalysisRuntimeMode(expired, now), "paused");
assert.equal(canRunLocalSubscriptionAnalysis(expired, "owner-a", now), false);

assert.equal(parseDeepAnalysisRuntimeMode("paused"), "paused");
assert.throws(() => parseDeepAnalysisRuntimeMode("active"), /Unknown deep analysis runtime mode/u);

console.log("deep analysis runtime control contract tests passed");
