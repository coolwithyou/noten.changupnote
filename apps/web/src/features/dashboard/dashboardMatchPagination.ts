export const DASHBOARD_MATCH_PAGE_SIZE = 40;

export function initialDashboardMatchCursor(
  loadedCount: number,
  reportedCount: number,
): string | null {
  return loadedCount > 0 && loadedCount < reportedCount ? String(loadedCount) : null;
}

export function dashboardMatchesPagePath(cursor: string): string {
  const params = new URLSearchParams({
    status: "all",
    sort: "recommended",
    limit: String(DASHBOARD_MATCH_PAGE_SIZE),
    cursor,
  });
  return `/api/web/matches?${params.toString()}`;
}

export function mergeUniqueMatches<T extends { grantId: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(current.map((match) => match.grantId));
  const merged = [...current];
  for (const match of incoming) {
    if (seen.has(match.grantId)) continue;
    seen.add(match.grantId);
    merged.push(match);
  }
  return merged;
}
