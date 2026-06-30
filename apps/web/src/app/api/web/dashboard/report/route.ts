import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { buildDashboardReport, dashboardReportDownloadResponse } from "@/lib/server/dashboard/dashboardReport";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const dashboard = await loadServiceDashboard({
      companyId: access.companyId,
      userId: access.userId,
      limit: 40,
      writeMatchStates: false,
    });
    const report = buildDashboardReport({ dashboard });
    return dashboardReportDownloadResponse(report);
  } catch (error) {
    return webActionError<null>(error, {
      code: "dashboard_report_failed",
      message: "기회 맵 리포트를 다운로드하지 못했습니다.",
    });
  }
}
