import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { getAppPreferencesStore } from "@/lib/server/appApi/preferencesStore";
import { requireAppSession } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const [session, { deviceId }] = await Promise.all([requireAppSession(request), context.params]);
    const deleted = await getAppPreferencesStore().deleteDevice(session.user.id, deviceId);
    return appData({ deleted });
  } catch (error) {
    return appErrorFromUnknown(error, "기기를 삭제하지 못했습니다.");
  }
}
