import type { MatchCard } from "@cunote/contracts";

export const MATCH_STATUS_FILTERS = [
  "all",
  "eligible",
  "conditional",
  "ineligible",
  "now",
  "soon",
  "preparable",
] as const;

export const MATCH_SORT_KEYS = [
  "recommended",
  "fit",
  "deadline",
  "amount",
] as const;

export type MatchStatusFilter = (typeof MATCH_STATUS_FILTERS)[number];
export type MatchSortKey = (typeof MATCH_SORT_KEYS)[number];

export interface SelectMatchCardsOptions {
  status?: MatchStatusFilter | null;
  sort?: MatchSortKey | null;
  cursor?: string | null;
  limit?: number;
}

export interface SelectMatchCardsResult {
  matches: MatchCard[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

export function selectMatchCards(
  matches: MatchCard[],
  options: SelectMatchCardsOptions = {},
): SelectMatchCardsResult {
  const status = options.status && options.status !== "all" ? options.status : null;
  const sort = options.sort ?? "recommended";
  const limit = boundedLimit(options.limit);
  const offset = cursorToOffset(options.cursor);
  const filtered = status ? matches.filter((match) => matchesStatus(match, status)) : matches;
  const sorted = sortMatchCards(filtered, sort);
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    matches: page,
    cursor: nextOffset < sorted.length ? String(nextOffset) : null,
    hasMore: nextOffset < sorted.length,
    total: sorted.length,
  };
}

export function isMatchStatusFilter(value: string): value is MatchStatusFilter {
  return (MATCH_STATUS_FILTERS as readonly string[]).includes(value);
}

export function isMatchSortKey(value: string): value is MatchSortKey {
  return (MATCH_SORT_KEYS as readonly string[]).includes(value);
}

/**
 * "준비하면 열려요"는 사용자가 둘 이상의 프로필 답변으로 해소할 수 있는 공고만 뜻한다.
 * 내부 bucket의 legacy `preparable`은 되돌릴 수 없는 hard fail에도 붙으므로 UI/API 필터 근거로
 * 직접 사용하지 않는다.
 */
export function isPreparableMatchCard(match: MatchCard): boolean {
  const tier = match.recommendationTier ?? (
    match.eligibility === "eligible"
      ? "recommendable"
      : match.eligibility === "ineligible"
        ? "not_recommended"
        : "needs_profile_input"
  );
  if (tier !== "needs_profile_input") return false;
  return new Set(match.ruleTrace
    .filter((trace) => trace.result === "unknown" && trace.action?.type === "progressive")
    .map((trace) => trace.dimension)).size > 1;
}

function matchesStatus(match: MatchCard, status: Exclude<MatchStatusFilter, "all">): boolean {
  if (status === "preparable") return isPreparableMatchCard(match);
  return match.eligibility === status || match.bucket === status;
}

function sortMatchCards(matches: MatchCard[], sort: MatchSortKey): MatchCard[] {
  if (sort === "recommended") return [...matches];
  return matches
    .map((match, index) => ({ match, index }))
    .sort((left, right) => compareMatchCards(left.match, right.match, sort) || left.index - right.index)
    .map((entry) => entry.match);
}

function compareMatchCards(left: MatchCard, right: MatchCard, sort: MatchSortKey): number {
  if (sort === "fit") return scoreDisplayRank(left) - scoreDisplayRank(right) || right.fitScore - left.fitScore;
  if (sort === "amount") return amountMax(right) - amountMax(left);
  if (sort === "deadline") return deadlineRank(left) - deadlineRank(right);
  return 0;
}

function scoreDisplayRank(match: MatchCard): number {
  return match.scoreDisplay === "hidden" ? 1 : 0;
}

function amountMax(match: MatchCard): number {
  return match.supportAmount.max ?? match.supportAmount.min ?? 0;
}

function deadlineRank(match: MatchCard): number {
  if (match.dDay === null || match.dDay < 0) return Number.MAX_SAFE_INTEGER;
  return match.dDay;
}

function cursorToOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

function boundedLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(40, Math.floor(limit)));
}
