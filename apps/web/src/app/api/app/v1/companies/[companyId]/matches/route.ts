import { selectMatchCards } from "@cunote/core";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { parseMatchListQuery } from "@/lib/server/matches/matchListQuery";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const parsedQuery = parseMatchListQuery(request);
    if (!parsedQuery.ok) {
      const { code, message, status, field } = parsedQuery.error;
      return appError(code, message, status, field);
    }

    const { companyId } = await context.params;
    const access = await requireAppCompanyAccess(request, companyId);
    const dashboard = await loadServiceDashboard({ companyId, userId: access.userId, limit: 40 });
    const selected = selectMatchCards(dashboard.matches, parsedQuery.query);

    return appData({
      counts: dashboard.counts,
      matches: selected.matches,
    }, undefined, {
      rulesetVer: dashboard.rulesetVer,
      scoringVer: dashboard.scoringVer,
      cursor: selected.cursor,
      hasMore: selected.hasMore,
    });
  } catch (error) {
    return appErrorFromUnknown(error, "매칭 결과를 불러오지 못했습니다.");
  }
}
