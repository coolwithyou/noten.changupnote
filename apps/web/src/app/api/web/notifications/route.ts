import type { ActionResult, NotificationSettingsDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const data = await getAppPreferencesStore().getNotificationSettings(access.userId);
    return NextResponse.json<ActionResult<NotificationSettingsDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<NotificationSettingsDto>(error, {
      code: "notifications_failed",
      message: "알림 설정을 불러오지 못했습니다.",
    });
  }
}

export async function PUT(request: Request) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess(), readBody(request)]);
    const data = await getAppPreferencesStore().updateNotificationSettings(access.userId, body);
    return NextResponse.json<ActionResult<NotificationSettingsDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<NotificationSettingsDto>(error, {
      code: "notifications_update_failed",
      message: "알림 설정을 저장하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<Partial<NotificationSettingsDto>> {
  try {
    const parsed = await request.json() as Partial<NotificationSettingsDto>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
