import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string; grantId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { companyId, grantId } = await context.params;
    await requireAppCompanyAccess(_request, companyId);
    return appData({ accepted: true, companyId, grantId }, { status: 202 });
  } catch (error) {
    return appErrorFromUnknown(error, "매칭 이벤트를 기록하지 못했습니다.");
  }
}
