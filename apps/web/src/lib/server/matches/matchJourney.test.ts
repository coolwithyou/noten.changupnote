import assert from "node:assert/strict";
import { buildMatchEventResult, buildSaveMatchEventInput, parseMatchJourney } from "./matchEvents";
const journey = { version: 1, sessionId: "12345678-1234-4123-8123-123456789abc", action: "card_open", elapsedMs: 30, evidence: "verified", eligibility: "conditional" };
assert.deepEqual(parseMatchJourney({ ...journey, answer: "sensitive", companyValue: "private" }), journey);
for (const override of [{ version: 2 }, { action: "application_completed" }, { elapsedMs: NaN }, { elapsedMs: -1 }, { elapsedMs: 86_400_001 }, { sessionId: "business-number" }, { evidence: "guessed" }]) {
  assert.throws(() => parseMatchJourney({ ...journey, ...override }), { code: "invalid_match_journey" });
}
const input = buildSaveMatchEventInput({ companyId: "owned", grantId: "notice", body: {
  journey: parseMatchJourney(journey), payload: { answer: "secret" }, rulesetVer: "private value",
} });
assert.equal(input.companyId, "owned");
assert.equal(input.rulesetVer, undefined);
assert.equal("payload" in input, false);
assert.equal(buildMatchEventResult({ event: input, receipt: { id: "memory", acceptedAt: "now", persisted: false } }).receipt.persisted, false);
assert.equal(buildMatchEventResult({ event: input, receipt: { id: "db", acceptedAt: "now", persisted: true } }).accepted, true);
console.log("match journey: allowlisted metadata, bounds and nonpersistent receipts passed");
