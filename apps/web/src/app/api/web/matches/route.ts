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
    const dashboard = await loadServiceDashboard({ companyId: access.companyId, userId: access.userId, limit: 40 });
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
