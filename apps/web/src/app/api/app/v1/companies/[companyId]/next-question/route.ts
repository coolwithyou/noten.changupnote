import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    await requireCompanyAccess(companyId);
    const dashboard = await loadServiceDashboard({ limit: 40 });
    return appData(dashboard.nextQuestion ?? null);
  } catch (error) {
    return appErrorFromUnknown(error, "다음 질문을 불러오지 못했습니다.");
  }
}
