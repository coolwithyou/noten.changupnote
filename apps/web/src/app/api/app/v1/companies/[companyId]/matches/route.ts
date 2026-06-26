import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    await requireAppCompanyAccess(_request, companyId);
    const dashboard = await loadServiceDashboard({ companyId, limit: 40 });
    return appData({
      counts: dashboard.counts,
      matches: dashboard.matches,
    }, undefined, {
      rulesetVer: dashboard.rulesetVer,
      scoringVer: dashboard.scoringVer,
    });
  } catch (error) {
    return appErrorFromUnknown(error, "매칭 결과를 불러오지 못했습니다.");
  }
}
