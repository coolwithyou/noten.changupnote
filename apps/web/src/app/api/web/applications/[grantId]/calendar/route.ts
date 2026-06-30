import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { buildApplicationCalendar } from "@/lib/server/applications/applicationCalendar";
import { textDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { grantId } = await context.params;
    const access = await requireCompanyAccess();
    const calendar = await buildApplicationCalendar({ grantId, access });

    return textDownloadResponse({
      body: calendar.ics,
      filename: calendar.filename,
      fallbackFilename: calendar.fallbackFilename,
      contentType: "text/calendar; charset=utf-8",
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "application_calendar_download_failed",
      message: "신청 일정을 다운로드하지 못했습니다.",
    });
  }
}
