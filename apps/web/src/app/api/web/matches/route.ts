import type { ActionResult, DashboardResult } from "@cunote/contracts";
import { selectMatchCards } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { parseMatchListQuery } from "@/lib/server/matches/matchListQuery";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchesPayload = Pick<DashboardResult, "counts" | "matches" | "roadmap" | "rulesetVer" | "scoringVer"> & {
  cursor: string | null;
  hasMore: boolean;
  total: number;
};

export async function GET(request: Request) {
  try {
    const parsedQuery = parseMatchListQuery(request);
    if (!parsedQuery.ok) {
      const { code, message, field, status } = parsedQuery.error;
      return NextResponse.json<ActionResult<MatchesPayload>>({
        ok: false,
        error: { code, message, field },
      }, { status });
    }

    const access = await requireCompanyAccess();
    // cursor/status/sort는 전체 활성 공고 카드 집합 위에서 적용해야 한다.
    // 40건만 dashboard에 요청하면 두 번째 페이지와 필터 결과가 최신 40건으로 잘린다.
    const dashboard = await loadServiceDashboard({
      companyId: access.companyId,
      userId: access.userId,
      limit: 5_000,
      writeMatchStates: false,
    });
    const selected = selectMatchCards(dashboard.matches, parsedQuery.query);
    const data: MatchesPayload = {
      counts: dashboard.counts,
      matches: selected.matches,
      roadmap: dashboard.roadmap,
      rulesetVer: dashboard.rulesetVer,
      scoringVer: dashboard.scoringVer,
      cursor: selected.cursor,
      hasMore: selected.hasMore,
      total: selected.total,
    };
    return NextResponse.json<ActionResult<MatchesPayload>>({ ok: true, data });
  } catch (error) {
    return webActionError<MatchesPayload>(error, {
      code: "matches_failed",
      message: "매칭 결과를 불러오지 못했습니다.",
    });
  }
}
