import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { buildApplicationBoardCalendar } from "@/lib/server/applications/applicationCalendar";
import { textDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const calendar = await buildApplicationBoardCalendar({ access });

    return textDownloadResponse({
      body: calendar.ics,
      filename: calendar.filename,
      fallbackFilename: calendar.fallbackFilename,
      contentType: "text/calendar; charset=utf-8",
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "application_board_calendar_download_failed",
      message: "신청 보드 일정을 다운로드하지 못했습니다.",
    });
  }
}
