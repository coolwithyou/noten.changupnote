import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { loadServiceApplySheet } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ grantId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { grantId } = await context.params;
    const companyId = new URL(_request.url).searchParams.get("companyId")?.trim() || undefined;
    const access = await requireAppCompanyAccess(_request, companyId);
    const sheet = await loadServiceApplySheet(grantId, {
      companyId: access.companyId,
      userId: access.userId,
    });
    if (!sheet) return appError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");
    return appData(sheet);
  } catch (error) {
    return appErrorFromUnknown(error, "공고 상세를 불러오지 못했습니다.");
  }
}
