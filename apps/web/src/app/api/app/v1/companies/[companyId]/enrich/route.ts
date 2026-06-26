import type { CompanyEnrichmentRequest } from "@cunote/contracts";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { enrichServiceCompany } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    if (!body.bizNo?.trim()) {
      return appError("invalid_biz_no", "bizNo가 필요합니다.", 400, "bizNo");
    }

    const data = await enrichServiceCompany({
      companyId,
      userId: access.userId,
      bizNo: body.bizNo,
    });
    return appData(data);
  } catch (error) {
    return appErrorFromUnknown(error, "회사 정보를 보강하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<CompanyEnrichmentRequest> {
  try {
    const parsed = await request.json() as CompanyEnrichmentRequest;
    return parsed && typeof parsed === "object" ? parsed : { bizNo: "" };
  } catch {
    return { bizNo: "" };
  }
}
