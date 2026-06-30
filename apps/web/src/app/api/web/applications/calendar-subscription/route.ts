import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  applicationCalendarSubscriptionDownloadResponse,
  buildApplicationCalendarSubscription,
} from "@/lib/server/applications/applicationCalendarSubscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await requireCompanyAccess();
    const subscription = buildApplicationCalendarSubscription({
      access,
      origin: new URL(request.url).origin,
    });
    return applicationCalendarSubscriptionDownloadResponse(subscription);
  } catch (error) {
    return webActionError<null>(error, {
      code: "application_calendar_subscription_failed",
      message: "신청 캘린더 구독 URL을 만들지 못했습니다.",
    });
  }
}
