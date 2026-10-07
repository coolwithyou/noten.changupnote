import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import { deadlineHasPassed, projectDiscoveryCard } from "./discovery-policy.js";
import { selectTeaserDisplay } from "../use-cases/build-teaser.js";

const sha = "a".repeat(64);
const card: MatchCard = {
  grantId: "candidate", source: "bizinfo", sourceId: "candidate", title: "지원 공고", agency: null,
  status: "open", eligibility: "conditional", bucket: "preparable", fitScore: 0,
  matchingEvidence: { level: "verified", sourceRevisionSha256: sha },
  quality: { eligibilityConfidence: "high", verificationCompleteness: 100, evidenceCoverage: 100, extractionReadiness: "reviewed" },
  supportAmount: { label: "미확인", min: null, max: null, unit: "KRW", per: "기업" },
  benefits: [], applyEnd: "2026-09-30", dDay: 0, ruleTrace: [], matchConfidence: 0,
  rulesetVer: "test", scoringVer: "test", authoringMode: "unknown", writeSupport: "unknown",
  recommendationTier: "needs_core_review", criteriaExtracted: true,
};
const fail: MatchCard["ruleTrace"][number] = { criterionId: "a", dimension: "region", kind: "required", result: "fail",
  label: "지역 조건", sourceSpan: "해당 지역에 소재한 기업", checklistSection: "needs_check" };
const unknown = { ...fail, criterionId: "b", result: "unknown" as const };
const pass = { ...fail, criterionId: "b", result: "pass" as const };
const declined = { ...card, eligibility: "ineligible" as const, recommendationTier: "not_recommended" as const, ruleTrace: [fail] };
assert.equal(projectDiscoveryCard(declined).state, "excluded");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, unknown] }).state, "review");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, pass] }).state, "review", "flat 조건의 AND/OR를 추측하지 않는다");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, { ...fail, criterionId: "b" }] }).state, "excluded");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [] }).state, "review");
const { matchingEvidence: _evidence, ...legacy } = declined;
assert.equal(projectDiscoveryCard(legacy).state, "review");
assert.equal(projectDiscoveryCard({ ...declined, matchingEvidence: { level: "verified", sourceRevisionSha256: "stale" } }).state, "review");
const { sourceSpan: _span, ...spanless } = fail;
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [spanless] }).state, "review");
assert.equal(projectDiscoveryCard({ ...declined, quality: { ...card.quality!, extractionReadiness: "partial" } }).state, "review");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [{ ...fail, unresolvedReason: "source_dispute" }] }).state, "review");
for (const reason of ["source_changed", "unreviewed", "evidence_unavailable"] as const) {
  assert.equal(projectDiscoveryCard({ ...declined, matchingEvidence: { level: "discovery", sourceRevisionSha256: sha, reason } }).state, "review");
}
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [{ ...fail, kind: "preferred" }] }).state, "review");
assert.equal(projectDiscoveryCard({ ...card, eligibility: "eligible", recommendationTier: "recommendable", ruleTrace: [{ ...fail, kind: "preferred" }] }).state, "candidate");
assert.equal(projectDiscoveryCard({ ...card, status: "unknown" }).reason, "period_unconfirmed");
assert.equal(projectDiscoveryCard({ ...card, status: "upcoming" }).state, "upcoming");
assert.equal(projectDiscoveryCard({ ...card, status: "closed" }).reason, "closed");
assert.equal(projectDiscoveryCard({ ...declined, status: "upcoming" }).reason, "confirmed_mismatch");
const expression = (op: "allOf" | "anyOf") => ({ version: "compound-projection-v1" as const, sourceRevisionSha256: sha,
  expression: { [op]: [{ criterionId: "a" }, { criterionId: "b" }] } as { allOf: { criterionId: string }[] } | { anyOf: { criterionId: string }[] } });
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, unknown] }, { reviewedExpression: expression("anyOf") }).state, "review");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, pass] }, { reviewedExpression: expression("anyOf") }).state, "review", "후보 유지가 eligibility 승격은 아니다");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, unknown] }, { reviewedExpression: expression("allOf") }).state, "excluded");
assert.equal(projectDiscoveryCard({ ...declined, ruleTrace: [fail, unknown] }, { reviewedExpression: { ...expression("allOf"), sourceRevisionSha256: "b".repeat(64) } }).state, "review");
assert.equal(projectDiscoveryCard(declined, { reviewedExpression: expression("allOf") }).state, "review", "조건 집합이 다르면 확정 제외하지 않는다");
const asOf = new Date("2026-09-30T14:59:59Z");
assert.equal(deadlineHasPassed("2026-09-30", asOf), false);
assert.equal(deadlineHasPassed("2026-09-30", new Date("2026-09-30T15:00:00Z")), true);
assert.equal(deadlineHasPassed("2026-09-30T18:00:00+09:00", asOf), true);
assert.equal(deadlineHasPassed("2026-09-30 18:00", asOf), true);
assert.equal(deadlineHasPassed("2026-09-30T18:00:00+09:00", new Date("2026-09-30T09:00:00Z")), false);
for (const value of [null, "상시", "예산 소진 시", "2026-02-30", "2026-02-30T18:00:00+09:00", "invalid"]) assert.equal(deadlineHasPassed(value, asOf), false);
const retained = { ...declined, grantId: "retain-unknown", ruleTrace: [fail, unknown] };
const closed = { ...card, grantId: "closed", status: "closed" as const };
const displayed = selectTeaserDisplay([declined, closed, retained, card], { limit: 8 });
assert.deepEqual(new Set(displayed.matches.map(match => match.grantId)), new Set(["retain-unknown", "candidate"]));
assert.equal(retained.eligibility, "ineligible", "탐색 projection은 matcher 결과를 바꾸지 않는다");
console.log("PASS: discovery preserves unknown/OR/preference/source drift, excludes verified mismatch/closed periods, retains date-only KST closing day, and actually selects retained candidates");
