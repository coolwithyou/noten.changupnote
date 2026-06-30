import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadNotificationCenter } from "@/lib/server/notifications/notificationCenter";
import type { NotificationCenterResult } from "@/lib/notifications/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const data = await loadNotificationCenter({ access });
    return NextResponse.json<ActionResult<NotificationCenterResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<NotificationCenterResult>(error, {
      code: "notification_feed_failed",
      message: "알림 피드를 불러오지 못했습니다.",
    });
  }
}
