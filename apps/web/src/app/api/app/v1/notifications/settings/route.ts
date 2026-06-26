import type { NotificationSettingsDto } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { requireAppSession } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAppSession(request);
    const settings = await getAppPreferencesStore().getNotificationSettings(session.user.id);
    return appData(settings);
  } catch (error) {
    return appErrorFromUnknown(error, "알림 설정을 불러오지 못했습니다.");
  }
}

export async function PUT(request: Request) {
  try {
    const [session, body] = await Promise.all([requireAppSession(request), readBody(request)]);
    const settings = await getAppPreferencesStore().updateNotificationSettings(session.user.id, body);
    return appData(settings);
  } catch (error) {
    return appErrorFromUnknown(error, "알림 설정을 저장하지 못했습니다.");
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
