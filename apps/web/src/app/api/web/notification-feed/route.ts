import { buildNotificationFeed } from "@cunote/core";
import type { ActionResult, NotificationFeedResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const dashboard = await loadServiceDashboard({ companyId: access.companyId, userId: access.userId, limit: 40 });
    const data = buildNotificationFeed({
      matches: dashboard.matches,
    });
    return NextResponse.json<ActionResult<NotificationFeedResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<NotificationFeedResult>(error, {
      code: "notification_feed_failed",
      message: "알림 피드를 불러오지 못했습니다.",
    });
  }
}
