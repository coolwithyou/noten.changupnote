import { buildNotificationFeed } from "@cunote/core";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const access = await requireAppCompanyAccess(request, companyId);
    const dashboard = await loadServiceDashboard({ companyId, userId: access.userId, limit: 40 });
    return appData(buildNotificationFeed({
      matches: dashboard.matches,
    }));
  } catch (error) {
    return appErrorFromUnknown(error, "알림 피드를 불러오지 못했습니다.");
  }
}
