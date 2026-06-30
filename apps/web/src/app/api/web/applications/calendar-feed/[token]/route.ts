import { webActionError } from "@/lib/server/auth/webActionError";
import { buildApplicationBoardCalendar } from "@/lib/server/applications/applicationCalendar";
import { verifyApplicationCalendarSubscriptionToken } from "@/lib/server/applications/applicationCalendarSubscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    token: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { token } = await context.params;
    const access = verifyApplicationCalendarSubscriptionToken({ token });
    const calendar = await buildApplicationBoardCalendar({ access });
    return new Response(calendar.ics, {
      status: 200,
      headers: {
        "cache-control": "private, max-age=300",
        "content-disposition": `inline; filename="${calendar.fallbackFilename}"`,
        "content-type": "text/calendar; charset=utf-8",
      },
    });
  } catch (error) {
    return webActionError<null>(error, {
      code: "application_calendar_feed_failed",
      message: "신청 캘린더 구독 feed를 불러오지 못했습니다.",
    });
  }
}
