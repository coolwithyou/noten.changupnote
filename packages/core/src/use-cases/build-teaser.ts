import type { CompanyEvidence, CompanyProfile, CriterionConfirmation, MatchCard, NormalizedGrant, TeaserResult } from "@cunote/contracts";
import {
  matchNormalizedGrant,
  type MatchingConfirmationCriterionBinding,
} from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import { withMatchRanking } from "../matching/ranking.js";
import { activeUnknownQuestionDimensions } from "../company/question-answer-state.js";
import {
  companyAttributes,
  countByEligibility,
  daysUntil,
  grantKey,
  sortMatchedGrants,
  supportAmountMax,
  toMatchCard,
  type MatchedGrant,
} from "./match-card.js";
import {
  answerableHardUnknownDimensions,
  hasUnanswerableHardUnknown,
  isPreparableMatchCard,
} from "./select-match-cards.js";
import { projectMatchConfirmationReadiness } from "./match-explanation.js";

export interface BuildTeaserOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  limit?: number;
  /** 전체 카드 제한 안에서 우선 확보할 추천 가능 카드 수. 기본 8개 응답에서는 5개다. */
  recommendableLimit?: number;
  /** 전체 카드 제한 안에서 우선 확보할 검토 필요 카드 수. 기본 8개 응답에서는 3개다. */
  reviewNeededLimit?: number;
  companyEvidence?: CompanyEvidence | null;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
  confirmationQuestionBindingsByGrantId?: ReadonlyMap<string, MatchingConfirmationCriterionBinding[]>;
}

/**
 * The final teaser page is selected after the product server has attached its
 * current-source question annotation. Keeping this separate from matching lets
 * the server inspect the whole evaluated candidate pool before pagination.
 */
export interface TeaserDisplaySelectionOptions {
  limit?: number;
  recommendableLimit?: number;
  reviewNeededLimit?: number;
}

export interface TeaserDisplaySelection {
  matches: MatchCard[];
  recommendableMatches: MatchCard[];
  reviewNeededMatches: MatchCard[];
  oneQuestionAwayCount: number;
}

export function buildTeaser<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 8,
  recommendableLimit,
  reviewNeededLimit,
  companyEvidence,
  confirmationsByGrantId,
  confirmationQuestionBindingsByGrantId,
}: BuildTeaserOptions<TPayload>): TeaserResult {
  const matched = grants.map<MatchedGrant<TPayload>>((item) => ({
    item,
    match: withMatchRanking(item, company, matchNormalizedGrant(item, company, {
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
    }), { asOf }),
  }));
  const sorted = sortMatchedGrants(matched);
  const profileQuestionCandidates = sorted.filter((entry) =>
    entry.match.eligibility === "conditional"
    && entry.item.matching_evidence?.level !== "discovery"
  );
  const nextQuestion = planProfileQuestions(profileQuestionCandidates, {
    asOf,
    limit: 1,
    excludeDimensions: activeUnknownQuestionDimensions(company, asOf),
  })[0]?.question ?? null;
  const cards = sorted.map((entry) => toMatchCard(entry, { asOf }));
  const allRecommendableCards = cards.filter(isRecommendableCard);
  const openRecommendableCards = allRecommendableCards.filter((card) => card.status === "open");
  const reviewNeededCards = cards.filter(isReviewNeededCard);
  const needsProfileInputCount = cards.filter(
    (card) => recommendationTierForCard(card) === "needs_profile_input",
  ).length;
  const needsCoreReviewCount = cards.filter(
    (card) => recommendationTierForCard(card) === "needs_core_review",
  ).length;
  const oneAnswerCount = cards.filter(isOneAnswerCard).length;
  const notRecommendedCards = cards.filter(isNotRecommendedCard);
  const display = selectTeaserDisplay(cards, {
    limit,
    ...(recommendableLimit === undefined ? {} : { recommendableLimit }),
    ...(reviewNeededLimit === undefined ? {} : { reviewNeededLimit }),
  });
  const counts = countByEligibility(sorted.map((entry) => entry.match));
  const deadlineSoon = sorted.filter((entry) => {
    const dDay = daysUntil(entry.item.grant.apply_end ?? null, asOf);
    return entry.match.eligibility !== "ineligible" && dDay !== null && dDay >= 0 && dDay <= 7;
  }).length;

  const result: TeaserResult = {
    attributes: companyAttributes(company),
    estimatedMaxAmount: sumRecommendableAmount(sorted),
    conditionalUpside: sumReviewNeededAmount(sorted),
    counts: {
      ...counts,
      deadlineSoon,
      recommendable: allRecommendableCards.length,
      openNow: openRecommendableCards.length,
      reviewNeeded: reviewNeededCards.length,
      needsProfileInput: needsProfileInputCount,
      oneAnswer: oneAnswerCount,
      oneQuestionAway: display.oneQuestionAwayCount,
      needsCoreReview: needsCoreReviewCount,
      preparable: cards.filter(isPreparableMatchCard).length,
      notRecommended: notRecommendedCards.length,
    },
    matches: display.matches,
    nextQuestion,
    recommendableMatches: display.recommendableMatches,
    reviewNeededMatches: display.reviewNeededMatches,
    searchContext: {
      asOf: asOf.toISOString(),
      evaluatedGrantCount: grants.length,
      lastCollectedAt: latestCollectedAt(grants),
    },
    privacyNote: "사업자번호 원문, 대표자명, 상세주소는 저장하거나 표시하지 않습니다.",
  };
  if (companyEvidence !== undefined) result.companyEvidence = companyEvidence;
  return result;
}

/**
 * Select a page from an already annotated pool. Only
 * `projectMatchConfirmationReadiness` may put a card in the one-question
 * priority; dimensions and generic question counts are deliberately ignored.
 */
export function selectTeaserDisplay(
  cards: readonly MatchCard[],
  options: TeaserDisplaySelectionOptions = {},
): TeaserDisplaySelection {
  const allRecommendableCards = cards.filter(isRecommendableCard);
  const visibleRecommendableCards = allRecommendableCards.filter(
    (card) => card.status === "open" || card.status === "upcoming",
  );
  const reviewNeededCards = cards.filter(isReviewNeededCard);
  const balancedReviewNeededCards = balanceReviewNeededCards(reviewNeededCards);
  const { recommendable, reviewNeeded } = selectVisibleTeaserBuckets(
    visibleRecommendableCards,
    balancedReviewNeededCards,
    {
      limit: options.limit ?? 8,
      ...(options.recommendableLimit === undefined ? {} : { recommendableLimit: options.recommendableLimit }),
      ...(options.reviewNeededLimit === undefined ? {} : { reviewNeededLimit: options.reviewNeededLimit }),
    },
  );
  return {
    matches: [...recommendable, ...reviewNeeded],
    recommendableMatches: recommendable,
    reviewNeededMatches: reviewNeeded,
    oneQuestionAwayCount: cards.filter(isOneQuestionAwayCard).length,
  };
}

function selectVisibleTeaserBuckets(
  recommendableCards: MatchCard[],
  reviewNeededCards: MatchCard[],
  options: { limit: number; recommendableLimit?: number; reviewNeededLimit?: number },
): { recommendable: MatchCard[]; reviewNeeded: MatchCard[] } {
  const limit = nonNegativeInteger(options.limit);
  const defaultReviewQuota = limit >= 2 ? Math.max(1, Math.floor(limit * 3 / 8)) : 0;
  const requestedRecommendable = options.recommendableLimit === undefined
    ? limit - defaultReviewQuota
    : nonNegativeInteger(options.recommendableLimit);
  const recommendableQuota = Math.min(limit, requestedRecommendable);
  const requestedReview = options.reviewNeededLimit === undefined
    ? limit - recommendableQuota
    : nonNegativeInteger(options.reviewNeededLimit);
  const reviewQuota = Math.min(limit - recommendableQuota, requestedReview);

  let recommendable = recommendableCards.slice(0, recommendableQuota);
  let reviewNeeded = reviewNeededCards.slice(0, reviewQuota);
  let remaining = limit - recommendable.length - reviewNeeded.length;

  if (remaining > 0) {
    const additionalRecommendable = recommendableCards.slice(
      recommendable.length,
      recommendable.length + remaining,
    );
    recommendable = [...recommendable, ...additionalRecommendable];
    remaining -= additionalRecommendable.length;
  }
  if (remaining > 0) {
    reviewNeeded = [
      ...reviewNeeded,
      ...reviewNeededCards.slice(reviewNeeded.length, reviewNeeded.length + remaining),
    ];
  }

  return { recommendable, reviewNeeded };
}

/** 각 검토 사유의 대표 카드가 제한된 익명 결과에 최소 한 번씩 나타나게 섞는다. */
function balanceReviewNeededCards(cards: MatchCard[]): MatchCard[] {
  const oneQuestionAway = cards.filter(isOneQuestionAwayCard);
  const buckets = [
    cards.filter((card) => isOneAnswerCard(card) && !isOneQuestionAwayCard(card)),
    cards.filter((card) =>
      recommendationTierForCard(card) === "needs_profile_input"
      && !isOneQuestionAwayCard(card)
      && !isOneAnswerCard(card)
    ),
    cards.filter((card) => recommendationTierForCard(card) === "needs_core_review"),
  ];
  // A card with one exact current-source v2 question is the shortest path to a
  // definitive answer. Keep every such card ahead of generic review buckets so
  // a later exact candidate cannot be displaced by round-robin balancing.
  const result: MatchCard[] = [...oneQuestionAway];
  for (let index = 0; result.length < cards.length; index += 1) {
    let appended = false;
    for (const bucket of buckets) {
      const card = bucket[index];
      if (!card) continue;
      result.push(card);
      appended = true;
    }
    if (!appended) break;
  }
  return result;
}

function isOneQuestionAwayCard(card: MatchCard): boolean {
  return projectMatchConfirmationReadiness(card).status === "one_question_away";
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isRecommendableCard(card: MatchCard): boolean {
  return recommendationTierForCard(card) === "recommendable";
}

function isReviewNeededCard(card: MatchCard): boolean {
  const tier = recommendationTierForCard(card);
  return tier === "needs_profile_input" || tier === "needs_core_review";
}

function isNotRecommendedCard(card: MatchCard): boolean {
  return recommendationTierForCard(card) === "not_recommended";
}

function isOneAnswerCard(card: MatchCard): boolean {
  if (recommendationTierForCard(card) !== "needs_profile_input") return false;
  if (hasUnanswerableHardUnknown(card)) return false;
  return answerableHardUnknownDimensions(card).size === 1;
}

function recommendationTierForCard(card: MatchCard): NonNullable<MatchCard["recommendationTier"]> {
  return card.recommendationTier ?? (card.eligibility === "eligible" ? "recommendable" : card.eligibility === "ineligible" ? "not_recommended" : "needs_profile_input");
}

function recommendationTierForMatch(
  match: MatchedGrant<unknown>["match"],
): NonNullable<MatchCard["recommendationTier"]> {
  return match.review_gate?.tier ??
    (match.eligibility === "eligible"
      ? "recommendable"
      : match.eligibility === "ineligible"
        ? "not_recommended"
        : "needs_profile_input");
}

function sumRecommendableAmount<TPayload>(
  matched: Array<MatchedGrant<TPayload>>,
): number {
  return matched
    .filter((entry) => entry.match.review_gate?.tier === "recommendable")
    .reduce((sum, entry) => sum + supportAmountMax(entry.item.grant.support_amount), 0);
}

function sumReviewNeededAmount<TPayload>(
  matched: Array<MatchedGrant<TPayload>>,
): number {
  return matched
    .filter((entry) => {
      return recommendationTierForMatch(entry.match) === "needs_profile_input";
    })
    .reduce((sum, entry) => sum + supportAmountMax(entry.item.grant.support_amount), 0);
}

function latestCollectedAt<TPayload>(grants: Array<NormalizedGrant<TPayload>>): string | null {
  let latest: Date | null = null;
  for (const entry of grants) {
    const collectedAt = entry.raw.collected_at ? new Date(entry.raw.collected_at) : null;
    if (!collectedAt || Number.isNaN(collectedAt.getTime())) continue;
    if (!latest || collectedAt.getTime() > latest.getTime()) latest = collectedAt;
  }
  return latest ? latest.toISOString() : null;
}
