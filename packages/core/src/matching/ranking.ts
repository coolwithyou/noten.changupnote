import type { CompanyProfile, MatchRanking, MatchResult, NormalizedGrant } from "@cunote/contracts";
import { calculatePriority } from "./priority.js";
import { calculateRelevance } from "./relevance.js";

export function calculateMatchRanking<TPayload>(
  entry: NormalizedGrant<TPayload>,
  company: CompanyProfile,
  match: MatchResult,
  options: { asOf?: Date } = {},
): MatchRanking {
  const relevance = calculateRelevance(company, entry.grant, entry.criteria);
  const priority = calculatePriority(entry.grant, match, options);
  return {
    relevanceScore: relevance.score,
    priorityScore: priority.score,
    reasons: [...relevance.reasons, ...priority.reasons].slice(0, 5),
  };
}

export function withMatchRanking<TPayload>(
  entry: NormalizedGrant<TPayload>,
  company: CompanyProfile,
  match: MatchResult,
  options: { asOf?: Date } = {},
): MatchResult {
  return { ...match, ranking: calculateMatchRanking(entry, company, match, options) };
}
