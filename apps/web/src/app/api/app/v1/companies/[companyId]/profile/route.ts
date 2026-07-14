import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { resolveProductCompanyProfile } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const access = await requireAppCompanyAccess(_request, companyId);
    const resolution = await resolveProductCompanyProfile({
      context: "owned_read",
      companyId,
      userId: access.userId,
      asOf: new Date().toISOString(),
    });
    return appData({ profile: resolution.profile, profileView: resolution.view });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 프로필을 불러오지 못했습니다.");
  }
}
