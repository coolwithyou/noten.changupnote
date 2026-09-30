import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import { discoveryListSchema, discoverySelectionSchema, selectDiscoveryPage } from "./discoverySelections";

const asOf = new Date("2026-09-30T14:59:59Z");
const card: MatchCard = {
  grantId: "a", source: "bizinfo", sourceId: "a", title: "검토 공고", agency: null,
  status: "open", eligibility: "ineligible", bucket: "preparable", fitScore: 0,
  matchingEvidence: { level: "verified", sourceRevisionSha256: "a".repeat(64) },
  quality: { eligibilityConfidence: "high", verificationCompleteness: 100, evidenceCoverage: 100, extractionReadiness: "reviewed" },
  supportAmount: { label: "미확인", min: null, max: null, unit: "KRW", per: "기업" }, benefits: [],
  applyEnd: "2026-09-30", dDay: 0, ruleTrace: [{ criterionId: "region", dimension: "region", kind: "required", result: "fail", label: "지역", sourceSpan: "서울 소재 기업", checklistSection: "needs_check" }],
  matchConfidence: 0, rulesetVer: "fixture", scoringVer: "fixture", authoringMode: "unknown", writeSupport: "unknown",
  recommendationTier: "not_recommended", criteriaExtracted: true,
};
const cards = [card, { ...card, grantId: "b" }, { ...card, grantId: "c", applyEnd: "2026-09-29" },
  { ...card, grantId: "d", status: "closed" as const }, { ...card, grantId: "e", ruleTrace: [] }];
const before = JSON.stringify(cards);
const query = discoveryListSchema.parse({ limit: 1 });
const first = selectDiscoveryPage(cards, [], query, asOf);
assert.equal(first.total, 2); assert.equal(first.nextOffset, 1); assert.equal(first.rows[0]!.match.grantId, "a");
const second = selectDiscoveryPage(cards, [], { ...query, offset: 1 }, asOf);
assert.equal(second.rows[0]!.match.grantId, "b"); assert.equal(second.nextOffset, null);
const selections = [{ grantId: "a", restored: true, revision: 1 }, { grantId: "c", restored: true, revision: 1 }];
assert.deepEqual(selectDiscoveryPage(cards, selections, query, asOf).rows.map((row) => row.match.grantId), ["b"]);
const restored = selectDiscoveryPage(cards, selections, { ...query, view: "restored" }, asOf);
assert.deepEqual(restored.rows.map((row) => row.match.grantId), ["a"]);
assert.equal(restored.rows[0]!.match.eligibility, "ineligible", "복원은 적격성을 변경하지 않는다");
assert.equal(selectDiscoveryPage(cards, selections, { ...query, view: "restored" }, new Date("2026-09-30T15:00:00Z")).total, 0);
assert.equal(selectDiscoveryPage(cards, [{ ...selections[0]!, restored: false, revision: 2 }], query, asOf).rows[0]!.selection.revision, 2);
assert.equal(JSON.stringify(cards), before, "원래 판정/근거를 변경하지 않는다");
for (const input of [{ offset: -1 }, { limit: 41 }, { view: "all" }, { companyId: "foreign" }]) assert.equal(discoveryListSchema.safeParse(input).success, false);
assert.equal(discoverySelectionSchema.safeParse({ grantId: crypto.randomUUID(), restored: true, expectedRevision: 0, companyId: "foreign" }).success, false);
console.log("discoverySelections: pagination, restoration, deadlines, immutable eligibility PASS");
