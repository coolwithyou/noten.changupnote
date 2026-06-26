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
    const access = await requireAppCompanyAccess(_request, companyId);
    const dashboard = await loadServiceDashboard({ companyId, userId: access.userId, limit: 40 });
    return appData({ actions: dashboard.actionQueue });
  } catch (error) {
    return appErrorFromUnknown(error, "액션 큐를 불러오지 못했습니다.");
  }
}
