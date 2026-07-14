import type {
  CompanyProfile,
  DashboardResult,
  NormalizedGrant,
} from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import { activeUnknownQuestionDimensions } from "../company/question-answer-state.js";
import { withMatchRanking } from "../matching/ranking.js";
import { buildActionQueue } from "./build-action-queue.js";
import { buildRoadmap } from "./build-roadmap.js";
import {
  countByEligibility,
  companySummary,
  daysUntil,
  sortMatchedGrants,
  toMatchCard,
  type MatchedGrant,
} from "./match-card.js";

export interface BuildDashboardOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  limit?: number;
}

export function buildDashboard<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 24,
}: BuildDashboardOptions<TPayload>): DashboardResult {
  const matched = grants.map<MatchedGrant<TPayload>>((item) => ({
    item,
    match: withMatchRanking(item, company, matchNormalizedGrant(item, company), { asOf }),
  }));
  const rankedMatched = sortMatchedGrants(matched);
  const sortedMatched = rankedMatched.slice(0, limit);
  const matches = sortedMatched.map((entry) => toMatchCard(entry, { asOf }));
  const nextQuestion = planProfileQuestions(rankedMatched, {
    asOf,
    limit: 1,
    excludeDimensions: activeUnknownQuestionDimensions(company, asOf),
  })[0]?.question;
  const counts = dashboardCounts(matched, asOf);

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
    const answerableUnknownCount = new Set(card.ruleTrace
      .filter((trace) => trace.result === "unknown" && trace.action?.type === "progressive")
      .map((trace) => trace.dimension)).size;
    if (tier === "recommendable" && card.status === "open") openNow += 1;
    if (tier === "needs_profile_input" && answerableUnknownCount === 1) oneAnswer += 1;
    if (card.bucket === "preparable" || (tier === "needs_profile_input" && answerableUnknownCount > 1)) {
      preparable += 1;
    }

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
