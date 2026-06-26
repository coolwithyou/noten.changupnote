import {
  isMatchSortKey,
  isMatchStatusFilter,
  type MatchSortKey,
  type MatchStatusFilter,
} from "@cunote/core";

export interface MatchListQuery {
  status: MatchStatusFilter | null;
  sort: MatchSortKey;
  cursor: string | null;
  limit: number;
}

export interface MatchListQueryError {
  code: string;
  message: string;
  field: string;
  status: number;
}

export type MatchListQueryResult =
  | { ok: true; query: MatchListQuery }
  | { ok: false; error: MatchListQueryError };

export function parseMatchListQuery(request: Request): MatchListQueryResult {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const sort = url.searchParams.get("sort") ?? "recommended";
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");

  if (status && !isMatchStatusFilter(status)) {
    return invalidQuery("status", "status는 all, eligible, conditional, ineligible, now, soon, preparable 중 하나여야 합니다.");
  }
  if (!isMatchSortKey(sort)) {
    return invalidQuery("sort", "sort는 recommended, fit, deadline, amount 중 하나여야 합니다.");
  }
  if (cursor && !isPositiveInteger(cursor)) {
    return invalidQuery("cursor", "cursor는 양의 정수 오프셋이어야 합니다.");
  }

  const parsedLimit = limit ? Number(limit) : 20;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 40) {
    return invalidQuery("limit", "limit은 1 이상 40 이하의 정수여야 합니다.");
  }

  const statusFilter: MatchStatusFilter | null = status ? (status as MatchStatusFilter) : null;

  return {
    ok: true,
    query: {
      status: statusFilter,
      sort,
      cursor,
      limit: parsedLimit,
    },
  };
}

function invalidQuery(field: string, message: string): MatchListQueryResult {
  return {
    ok: false,
    error: {
      code: "invalid_match_query",
      message,
      field,
      status: 400,
    },
  };
}

function isPositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}
