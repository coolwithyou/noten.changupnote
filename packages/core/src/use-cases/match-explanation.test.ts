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
assert.equal(explainCondition(source).asksUser, true);
assert.equal(explainCondition(source).statusLabel, "확인 필요");
const answered = { ...match, ruleTrace: [{ ...input, result: "pass" as const }, source] };
assert.equal(explainMatch(answered).passed, 1);
assert.equal(explainMatch(answered).hasSourceBlocker, true);
assert.equal(explainMatch(answered).action, "source");
assert.equal(explainMatch(answered).summary, "이 조건만 확인하면 지원 가능 여부를 확정할 수 있어요.");
assert.equal(
  explainMatch({ ...answered, ruleTrace: [source, { ...source, criterionId: "route-2" }] }).summary,
  "남은 조건 2개를 확인하면 지원 가능 여부를 확정할 수 있어요.",
);
assert.equal(
  explainMatch({ ...answered, ruleTrace: [{ ...source, unresolvedReason: "criterion_needs_review" }] }).summary,
  "공고에서 확인할 조건이 남아 있어요. 아래 근거를 확인해 주세요.",
);
assert.equal(
  explainMatch({
    ...answered,
    confirmationQuestionCount: 1,
    ruleTrace: [{ ...source, confirmationNextAction: "user_confirmation" }],
  }).summary,
  "이 질문에 답하면 지원 가능 여부를 확정할 수 있어요.",
);
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, result: "pass" }], eligibility: "eligible" }).action, "source", "card-level gate survives all pass traces");
assert.equal(explainMatch({ ...match, matchingEvidence: { level: "discovery", sourceRevisionSha256: null, reason: "unreviewed" } }).conditions.length, 0);
assert.equal(explainMatch({ ...match, status: "closed" }).action, "details");
assert.equal(explainMatch({ ...match, eligibility: "ineligible" }).action, "details");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, confirmationNextAction: "user_confirmation" }] }).action, "source", "unbound questions are not callable");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, kind: "preferred" }] }).unknown, 0);
console.log("match explanation tests passed");
