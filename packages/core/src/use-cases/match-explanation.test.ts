import assert from "node:assert/strict";
import type { MatchCard, RuleTraceChip } from "@cunote/contracts";
import { explainCondition, explainMatch } from "./match-explanation.js";

const input: RuleTraceChip = { criterionId: "type", dimension: "target_type", kind: "required", result: "unknown",
  label: "신청 주체", checklistSection: "needs_check", unresolvedReason: "company_profile_missing",
  confirmationNextAction: "company_profile", sourceSpan: "일반기업 또는 연구기관" };
const source: RuleTraceChip = { ...input, criterionId: "route", dimension: "other", sourceSpan: "GBC 입주 또는 유럽 진출 희망",
  confirmationNextAction: "admin_source_review", unresolvedReason: "criterion_text_only", result: "text_only" };
const match: Parameters<typeof explainMatch>[0] = { status: "open", eligibility: "conditional",
  recommendationTier: "needs_core_review", ruleTrace: [input, source], criteriaExtracted: true };
assert.equal(explainMatch(match).unknown, 2);
assert.equal(explainMatch(match).action, "company_profile");
assert.match(explainMatch(match).summary, /별도 공고 조건 확인/);
assert.equal(explainCondition(source).requirement, "GBC 입주 또는 유럽 진출 희망");
const answered = { ...match, ruleTrace: [{ ...input, result: "pass" as const }, source] };
assert.equal(explainMatch(answered).passed, 1);
assert.equal(explainMatch(answered).hasSourceBlocker, true);
assert.equal(explainMatch(answered).action, "source");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, result: "pass" }], eligibility: "eligible" }).action, "source", "card-level gate survives all pass traces");
assert.equal(explainMatch({ ...match, matchingEvidence: { level: "discovery", sourceRevisionSha256: null, reason: "unreviewed" } }).conditions.length, 0);
assert.equal(explainMatch({ ...match, status: "closed" }).action, "details");
assert.equal(explainMatch({ ...match, eligibility: "ineligible" }).action, "details");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, confirmationNextAction: "user_confirmation" }] }).action, "source", "unbound questions are not callable");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, kind: "preferred" }] }).unknown, 0);
console.log("match explanation tests passed");
