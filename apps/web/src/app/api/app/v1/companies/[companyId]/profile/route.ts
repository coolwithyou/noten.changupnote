import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const access = await requireAppCompanyAccess(_request, companyId);
    const profile = await getServiceRepositories().companies.resolveCompanyProfile({
      companyId,
      userId: access.userId,
    });
    if (!profile) return appError("company_not_found", "회사를 찾지 못했습니다.", 404, "companyId");
    return appData({ profile });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 프로필을 불러오지 못했습니다.");
  }
}
