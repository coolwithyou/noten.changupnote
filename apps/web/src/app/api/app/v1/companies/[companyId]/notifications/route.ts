import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { loadNotificationFeed } from "@/lib/server/notifications/notificationCenter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const access = await requireAppCompanyAccess(request, companyId);
    return appData(await loadNotificationFeed({
      access: {
        companyId: access.companyId,
        userId: access.userId,
        role: "viewer",
        mode: access.mode,
      },
      limit: 40,
    }));
  } catch (error) {
    return appErrorFromUnknown(error, "알림 피드를 불러오지 못했습니다.");
  }
}
