import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadNotificationCenter } from "@/lib/server/notifications/notificationCenter";
import {
  buildNotificationCenterReport,
  notificationCenterReportDownloadResponse,
} from "@/lib/server/notifications/notificationCenterReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const center = await loadNotificationCenter({ access, limit: 40 });
    const report = buildNotificationCenterReport({ center });
    return notificationCenterReportDownloadResponse(report);
  } catch (error) {
    return webActionError<null>(error, {
      code: "notification_center_report_failed",
      message: "알림센터 리포트를 다운로드하지 못했습니다.",
    });
  }
}
