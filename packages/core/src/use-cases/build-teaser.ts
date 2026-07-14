import type { CompanyEvidence, CompanyProfile, MatchCard, NormalizedGrant, TeaserResult } from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import { planProfileQuestions } from "../matching/question-planner.js";
import { withMatchRanking } from "../matching/ranking.js";
import { activeUnknownQuestionDimensions } from "../company/question-answer-state.js";
import {
  companyAttributes,
  countByEligibility,
  daysUntil,
  sortMatchedGrants,
  supportAmountMax,
  toMatchCard,
  type MatchedGrant,
} from "./match-card.js";

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
}

export function buildTeaser<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 8,
  recommendableLimit,
  reviewNeededLimit,
  companyEvidence,
}: BuildTeaserOptions<TPayload>): TeaserResult {
  const matched = grants.map<MatchedGrant<TPayload>>((item) => ({
    item,
    match: withMatchRanking(item, company, matchNormalizedGrant(item, company), { asOf }),
  }));
  const sorted = sortMatchedGrants(matched);
  const nextQuestion = planProfileQuestions(sorted, {
    asOf,
    limit: 1,
    excludeDimensions: activeUnknownQuestionDimensions(company, asOf),
  })[0]?.question ?? null;
  const cards = sorted.map((entry) => toMatchCard(entry, { asOf }));
  const allRecommendableCards = cards.filter(isRecommendableCard);
  const openRecommendableCards = allRecommendableCards.filter((card) => card.status === "open");
  const visibleRecommendableCards = allRecommendableCards.filter(
    (card) => card.status === "open" || card.status === "upcoming",
  );
  const reviewNeededCards = cards.filter(isReviewNeededCard);
  const balancedReviewNeededCards = balanceReviewNeededCards(reviewNeededCards);
  const needsProfileInputCount = cards.filter(
    (card) => recommendationTierForCard(card) === "needs_profile_input",
  ).length;
  const oneAnswerCount = cards.filter(isOneAnswerCard).length;
  const needsCoreReviewCount = cards.filter(
    (card) => recommendationTierForCard(card) === "needs_core_review",
  ).length;
  const notRecommendedCards = cards.filter(isNotRecommendedCard);
  const {
    recommendable: recommendableMatches,
    reviewNeeded: reviewNeededMatches,
  } = selectVisibleTeaserBuckets(visibleRecommendableCards, balancedReviewNeededCards, {
    limit,
    ...(recommendableLimit === undefined ? {} : { recommendableLimit }),
    ...(reviewNeededLimit === undefined ? {} : { reviewNeededLimit }),
  });
  const visibleMatches = [...recommendableMatches, ...reviewNeededMatches];
  const counts = countByEligibility(matched.map((entry) => entry.match));
  const deadlineSoon = matched.filter((entry) => {
    const dDay = daysUntil(entry.item.grant.apply_end ?? null, asOf);
    return entry.match.eligibility !== "ineligible" && dDay !== null && dDay >= 0 && dDay <= 7;
  }).length;

  const result: TeaserResult = {
    attributes: companyAttributes(company),
    estimatedMaxAmount: sumRecommendableAmount(matched),
    conditionalUpside: sumReviewNeededAmount(matched),
    counts: {
      ...counts,
      deadlineSoon,
      recommendable: allRecommendableCards.length,
      openNow: openRecommendableCards.length,
      reviewNeeded: reviewNeededCards.length,
      needsProfileInput: needsProfileInputCount,
      oneAnswer: oneAnswerCount,
      needsCoreReview: needsCoreReviewCount,
      preparable: cards.filter(isDisplayPreparableCard).length,
      notRecommended: notRecommendedCards.length,
    },
    matches: visibleMatches,
    nextQuestion,
    recommendableMatches,
    reviewNeededMatches,
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
  const buckets = [
    cards.filter(isOneAnswerCard),
    cards.filter((card) => recommendationTierForCard(card) === "needs_core_review"),
    cards.filter((card) =>
      recommendationTierForCard(card) === "needs_profile_input" && !isOneAnswerCard(card)
    ),
  ];
  const result: MatchCard[] = [];
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

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isRecommendableCard(card: MatchCard): boolean {
  return recommendationTierForCard(card) === "recommendable";
}

function isReviewNeededCard(card: MatchCard): boolean {
  const tier = recommendationTierForCard(card);
  return tier === "needs_core_review" || tier === "needs_profile_input";
}

function isNotRecommendedCard(card: MatchCard): boolean {
  return recommendationTierForCard(card) === "not_recommended";
}

function isOneAnswerCard(card: MatchCard): boolean {
  if (recommendationTierForCard(card) !== "needs_profile_input") return false;
  return answerableUnknownDimensions(card).size === 1;
}

function isDisplayPreparableCard(card: MatchCard): boolean {
  if (card.bucket === "preparable") return true;
  return recommendationTierForCard(card) === "needs_profile_input" &&
    answerableUnknownDimensions(card).size > 1;
}

function answerableUnknownDimensions(card: MatchCard): Set<string> {
  return new Set(card.ruleTrace
    .filter((trace) => trace.result === "unknown" && trace.action?.type === "progressive")
    .map((trace) => trace.dimension));
}

function recommendationTierForCard(card: MatchCard): NonNullable<MatchCard["recommendationTier"]> {
  return card.recommendationTier ?? (card.eligibility === "eligible" ? "recommendable" : card.eligibility === "ineligible" ? "not_recommended" : "needs_profile_input");
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
      const tier = entry.match.review_gate?.tier ??
        (entry.match.eligibility === "eligible" ? "recommendable" : entry.match.eligibility === "ineligible" ? "not_recommended" : "needs_profile_input");
      return tier === "needs_core_review" || tier === "needs_profile_input";
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
