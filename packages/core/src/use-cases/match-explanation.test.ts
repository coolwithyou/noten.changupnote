import assert from "node:assert/strict";
import type { MatchCard, RuleTraceChip } from "@cunote/contracts";
import {
  explainCondition,
  explainMatch,
  projectMatchConfirmationReadiness,
} from "./match-explanation.js";
import { selectTeaserDisplay } from "./build-teaser.js";

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
assert.equal(explainCondition(source).asksUser, false);
assert.equal(explainCondition(source).statusLabel, "확인 필요");
const answered = { ...match, ruleTrace: [{ ...input, result: "pass" as const }, source] };
assert.equal(explainMatch(answered).passed, 1);
assert.equal(explainMatch(answered).hasSourceBlocker, true);
assert.equal(explainMatch(answered).action, "source");
assert.equal(explainMatch(answered).summary, "공고에서 확인할 조건이 남아 있어요. 아래 근거를 확인해 주세요.");
assert.equal(
  explainMatch({ ...answered, ruleTrace: [source, { ...source, criterionId: "route-2" }] }).summary,
  "공고에서 확인할 조건이 남아 있어요. 아래 근거를 확인해 주세요.",
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
  "직접 답할 조건이 1개 있어요. 답변 후 판정을 다시 확인해요.",
);
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, result: "pass" }], eligibility: "eligible" }).action, "source", "card-level gate survives all pass traces");
assert.equal(explainMatch({ ...match, matchingEvidence: { level: "discovery", sourceRevisionSha256: null, reason: "unreviewed" } }).conditions.length, 0);
assert.equal(explainMatch({ ...match, status: "closed" }).action, "details");
assert.equal(explainMatch({ ...match, eligibility: "ineligible" }).action, "details");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, confirmationNextAction: "user_confirmation" }] }).action, "source", "unbound questions are not callable");
assert.equal(explainMatch({ ...match, ruleTrace: [{ ...input, kind: "preferred" }] }).unknown, 0);

const oneQuestionAway = {
  status: "open" as const,
  eligibility: "conditional" as const,
  recommendationTier: "needs_profile_input" as const,
  matchingEvidence: { level: "verified" as const, sourceRevisionSha256: "current", reason: "reviewed" },
  criteriaExtracted: true,
  confirmationQuestionCount: 1,
  confirmationQuestionIds: ["q-last-hard"],
  confirmationEligibilityQuestionIds: ["q-last-hard"],
  ruleTrace: [{
    ...source,
    criterionId: "last-hard-criterion",
    kind: "required" as const,
    result: "unknown" as const,
    unresolvedReason: "criterion_text_only" as const,
    confirmationNextAction: "user_confirmation" as const,
  }],
};
assert.deepEqual(projectMatchConfirmationReadiness(oneQuestionAway), {
  status: "one_question_away",
  representativeCriterionId: "last-hard-criterion",
  representativeQuestionId: "q-last-hard",
  activeQuestionIds: ["q-last-hard"],
  hardQuestionCriterionIds: ["last-hard-criterion"],
  hasAdditionalReview: false,
});
const { matchingEvidence: _matchingEvidence, ...verifiedOnlyServedCard } = oneQuestionAway;
assert.equal(
  projectMatchConfirmationReadiness(verifiedOnlyServedCard).status,
  "one_question_away",
  "verified-only serving may omit the evidence envelope after filtering",
);
assert.equal(
  explainMatch(oneQuestionAway).summary,
  "이 질문에 답하면 지원 가능 여부를 바로 다시 확인할 수 있어요.",
);
assert.equal(
  projectMatchConfirmationReadiness({
    ...oneQuestionAway,
    confirmationQuestionCount: 2,
    confirmationQuestionIds: ["q-confirmed-hard", "q-last-hard"],
    confirmationEligibilityQuestionIds: ["q-last-hard"],
    ruleTrace: [
      { ...oneQuestionAway.ruleTrace[0]!, criterionId: "already-confirmed", result: "pass" as const },
      ...oneQuestionAway.ruleTrace,
    ],
  }).representativeQuestionId,
  "q-last-hard",
  "a confirmed hard question is a reconfirmation option, not another remaining eligibility gate",
);
assert.equal(
  projectMatchConfirmationReadiness({
    ...oneQuestionAway,
    ruleTrace: [
      ...oneQuestionAway.ruleTrace,
      { ...oneQuestionAway.ruleTrace[0]!, criterionId: "same-dimension-second-hard-question" },
    ],
  }).status,
  "not_one_question_away",
  "two hard questions on one dimension must not collapse into one",
);
assert.equal(
  projectMatchConfirmationReadiness({
    ...oneQuestionAway,
    ruleTrace: [
      ...oneQuestionAway.ruleTrace,
      { ...oneQuestionAway.ruleTrace[0]!, criterionId: "preferred-question", kind: "preferred" },
    ],
    confirmationQuestionCount: 2,
    confirmationQuestionIds: ["q-last-hard", "q-preferred"],
    confirmationEligibilityQuestionIds: ["q-last-hard"],
  }).representativeQuestionId,
  "q-last-hard",
  "a preferred unknown does not block the final hard question",
);
const { confirmationQuestionCount: _count, ...withoutQuestionCount } = oneQuestionAway;
const { confirmationQuestionIds: _ids, ...withoutQuestionIds } = oneQuestionAway;
const { confirmationEligibilityQuestionIds: _eligibilityIds, ...withoutEligibilityQuestionIds } = oneQuestionAway;
for (const blocked of [
  { ...oneQuestionAway, status: "closed" as const },
  { ...oneQuestionAway, eligibility: "ineligible" as const },
  { ...oneQuestionAway, matchingEvidence: { level: "discovery" as const, sourceRevisionSha256: null, reason: "unreviewed" as const } },
  { ...oneQuestionAway, recommendationTier: "needs_core_review" as const },
  withoutQuestionCount,
  withoutQuestionIds,
  withoutEligibilityQuestionIds,
  {
    ...oneQuestionAway,
    ruleTrace: [
      ...oneQuestionAway.ruleTrace,
      {
        ...oneQuestionAway.ruleTrace[0]!,
        criterionId: "source-review",
        confirmationNextAction: "admin_source_review" as const,
        unresolvedReason: "criterion_needs_review" as const,
      },
    ],
  },
]) {
  assert.equal(
    projectMatchConfirmationReadiness(blocked).status,
    "not_one_question_away",
    "closed, ineligible, discovery, unannotated, or source-review cards must fail closed",
  );
}

// Server annotations arrive after the initial candidate order. The exact v2
// proof, rather than a dimension/count shortcut, must select a later card into
// the limited teaser page and count it across the whole annotated pool.
const earlierReviewCards = Array.from({ length: 8 }, (_, index) => ({
  grantId: `earlier-${index}`,
  status: "open" as const,
  eligibility: "conditional" as const,
  recommendationTier: "needs_profile_input" as const,
  ruleTrace: [],
}) as unknown as MatchCard);
const laterOneQuestionAway = {
  ...oneQuestionAway,
  grantId: "later-exact-question",
} as unknown as MatchCard;
const selectedDisplay = selectTeaserDisplay(
  [...earlierReviewCards, laterOneQuestionAway],
  { limit: 3, recommendableLimit: 0, reviewNeededLimit: 3 },
);
assert.equal(selectedDisplay.oneQuestionAwayCount, 1);
assert.equal(selectedDisplay.matches[0]?.grantId, "later-exact-question");
assert.equal(
  selectedDisplay.matches.some((card) => card.grantId === "later-exact-question"),
  true,
  "a later exact candidate must not be lost to the pre-annotation teaser page",
);
const secondOneQuestionAway = {
  ...laterOneQuestionAway,
  grantId: "second-later-exact-question",
} as MatchCard;
const selectedMultipleExact = selectTeaserDisplay(
  [...earlierReviewCards, laterOneQuestionAway, secondOneQuestionAway],
  { limit: 3, recommendableLimit: 0, reviewNeededLimit: 3 },
);
assert.equal(selectedMultipleExact.oneQuestionAwayCount, 2);
assert.deepEqual(
  selectedMultipleExact.matches.slice(0, 2).map((card) => card.grantId),
  ["later-exact-question", "second-later-exact-question"],
  "all exact candidates must precede generic review cards within the visible quota",
);
assert.equal(
  selectTeaserDisplay([
    ...earlierReviewCards,
    { ...laterOneQuestionAway, confirmationEligibilityQuestionIds: [] },
  ], { limit: 3, recommendableLimit: 0, reviewNeededLimit: 3 }).oneQuestionAwayCount,
  0,
  "missing current-source v2 proof must fail closed even when the generic question shape matches",
);

const verifiedCoreReviewCards = Array.from({ length: 8 }, (_, index) => ({
  ...earlierReviewCards[index]!,
  grantId: `verified-core-${index}`,
  recommendationTier: "needs_core_review" as const,
  matchingEvidence: { level: "verified" as const, sourceRevisionSha256: `verified-${index}` },
}));
const discoveryCoreReview = {
  ...verifiedCoreReviewCards[0]!,
  grantId: "discovery-core",
  matchingEvidence: { level: "discovery" as const, sourceRevisionSha256: null, reason: "unreviewed" as const },
};
const mixedEvidenceDisplay = selectTeaserDisplay(
  [...verifiedCoreReviewCards, discoveryCoreReview],
  { limit: 3, recommendableLimit: 0, reviewNeededLimit: 3 },
);
assert.equal(
  mixedEvidenceDisplay.matches.filter((card) => card.matchingEvidence?.level === "discovery").length,
  1,
  "discovery inventory must receive one generic review slot instead of being starved by verified cards",
);
console.log("match explanation tests passed");
