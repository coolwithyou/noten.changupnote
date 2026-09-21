import type {
  CompanyProfile,
  CriterionConfirmation,
  DashboardResult,
  NormalizedGrant,
} from "@cunote/contracts";
import {
  matchNormalizedGrant,
  type MatchingConfirmationCriterionBinding,
} from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import { activeUnknownQuestionDimensions } from "../company/question-answer-state.js";
import { withMatchRanking } from "../matching/ranking.js";
import { buildActionQueue } from "./build-action-queue.js";
import { buildRoadmap } from "./build-roadmap.js";
import {
  answerableHardUnknownDimensions,
  hasUnanswerableHardUnknown,
  isPreparableMatchCard,
} from "./select-match-cards.js";
import {
  countByEligibility,
  companySummary,
  daysUntil,
  grantKey,
  sortMatchedGrants,
  toMatchCard,
  type MatchedGrant,
} from "./match-card.js";

export interface BuildDashboardOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  limit?: number;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
  confirmationQuestionBindingsByGrantId?: ReadonlyMap<string, MatchingConfirmationCriterionBinding[]>;
}

export function buildDashboard<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 24,
  confirmationsByGrantId,
  confirmationQuestionBindingsByGrantId,
}: BuildDashboardOptions<TPayload>): DashboardResult {
  const matched = grants.map<MatchedGrant<TPayload>>((item) => ({
    item,
    match: withMatchRanking(
      item,
      company,
      matchNormalizedGrant(
        item,
        company,
        {
          asOf,
          ...(confirmationsByGrantId
            ? { confirmations: confirmationsByGrantId.get(grantKey(item.grant)) ?? [] }
            : {}),
          ...(confirmationQuestionBindingsByGrantId
            ? {
                confirmationQuestionBindings:
                  confirmationQuestionBindingsByGrantId.get(grantKey(item.grant)) ?? [],
              }
            : {}),
        },
      ),
      { asOf },
    ),
  }));
  const rankedMatched = sortMatchedGrants(matched);
  const sortedMatched = rankedMatched.slice(0, limit);
  const matches = sortedMatched.map((entry) => toMatchCard(entry, { asOf }));
  const profileQuestionCandidates = rankedMatched.filter((entry) =>
    entry.match.eligibility === "conditional"
    && entry.item.matching_evidence?.level !== "discovery"
  );
  const nextQuestion = planProfileQuestions(profileQuestionCandidates, {
    asOf,
    limit: 1,
    excludeDimensions: activeUnknownQuestionDimensions(company, asOf),
  })[0]?.question;
  const counts = dashboardCounts(rankedMatched, asOf);

  const dashboard: DashboardResult = {
    company: companySummary(company),
    counts,
    matches,
    roadmap: buildRoadmap({ matches }),
    actionQueue: buildActionQueue({ matches }),
    rulesetVer: matches[0]?.rulesetVer ?? "unknown",
    scoringVer: matches[0]?.scoringVer ?? "unknown",
  };
  if (nextQuestion) dashboard.nextQuestion = nextQuestion;
  return dashboard;
}

function recommendationTierForMatch(
  match: MatchedGrant<unknown>["match"],
): NonNullable<ReturnType<typeof toMatchCard>["recommendationTier"]> {
  return match.review_gate?.tier ??
    (match.eligibility === "eligible"
      ? "recommendable"
      : match.eligibility === "ineligible"
        ? "not_recommended"
        : "needs_profile_input");
}

function dashboardCounts<TPayload>(
  matched: Array<MatchedGrant<TPayload>>,
  asOf: Date,
): DashboardResult["counts"] {
  const eligibility = countByEligibility(matched.map((entry) => entry.match));
  const recommendation = {
    recommendable: 0,
    reviewNeeded: 0,
    notRecommended: 0,
  };
  let deadlineSoon = 0;
  let openNow = 0;
  let needsProfileInput = 0;
  let oneAnswer = 0;
  let needsCoreReview = 0;
  let preparable = 0;
  for (const entry of matched) {
    const tier = entry.match.review_gate?.tier ??
      (entry.match.eligibility === "eligible"
        ? "recommendable"
        : entry.match.eligibility === "ineligible"
          ? "not_recommended"
          : "needs_profile_input");
    if (tier === "recommendable") recommendation.recommendable += 1;
    else if (tier === "not_recommended") recommendation.notRecommended += 1;
    else recommendation.reviewNeeded += 1;
    if (tier === "needs_profile_input") needsProfileInput += 1;
    if (tier === "needs_core_review") needsCoreReview += 1;

    const card = toMatchCard(entry, { asOf });
    const answerableUnknownCount = answerableHardUnknownDimensions(card).size;
    if (tier === "recommendable" && card.status === "open") openNow += 1;
    if (
      tier === "needs_profile_input"
      && answerableUnknownCount === 1
      && !hasUnanswerableHardUnknown(card)
    ) oneAnswer += 1;
    if (isPreparableMatchCard(card)) preparable += 1;

    const dDay = daysUntil(entry.item.grant.apply_end ?? null, asOf);
    if (entry.match.eligibility !== "ineligible" && dDay !== null && dDay >= 0 && dDay <= 7) {
      deadlineSoon += 1;
    }
  }
  return {
    ...eligibility,
    deadlineSoon,
    ...recommendation,
    openNow,
    needsProfileInput,
    oneAnswer,
    needsCoreReview,
    preparable,
  };
}
