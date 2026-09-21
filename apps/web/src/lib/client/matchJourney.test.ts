import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import { createMatchJourneyRecorder } from "./matchJourney";
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalFetch = globalThis.fetch;
const sent: Array<{ url: string; body: Record<string, any> }> = [];
const match = { grantId: "notice/one", eligibility: "conditional", matchingEvidence: { level: "verified" }, title: "private", ruleTrace: [{ companyValue: "private" }] } as unknown as MatchCard;
try {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { webdriver: false } });
  globalThis.fetch = (async (url, options) => { sent.push({ url: String(url), body: JSON.parse(String(options?.body)) }); return new Response(null, { status: 204 }); }) as typeof fetch;
  const record = createMatchJourneyRecorder();
  record(null, match, "card_open");
  record("virtual-example", match, "card_open");
  assert.equal(sent.length, 0);
  record.begin("company-a");
  record("company-a", match, "card_open");
  record("company-a", match, "profile_start");
  assert.equal(sent[0]!.body.journey.sessionId, sent[1]!.body.journey.sessionId);
  assert.equal(sent[0]!.body.companyId, "company-a");
  assert.ok(sent[0]!.url.includes("notice%2Fone"));
  assert.ok(!JSON.stringify(sent).includes("private"));
  record("company-b", match, "detail_open");
  assert.notEqual(sent[1]!.body.journey.sessionId, sent[2]!.body.journey.sessionId);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { webdriver: true } });
  record("company-b", match, "card_open");
  assert.equal(sent.length, 3);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { webdriver: false } });
  globalThis.fetch = (() => { throw new Error("network unavailable"); }) as typeof fetch;
  assert.doesNotThrow(() => record("company-b", match, "profile_start"));
} finally {
  globalThis.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
}
console.log("match journey client: company isolation, automation exclusion, no values, transport failure passed");
