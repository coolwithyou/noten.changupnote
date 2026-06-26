import type { CriterionDimension } from "@cunote/contracts";
import { updateCompanyProfileField } from "@cunote/core";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

interface ProfileFieldRequest {
  field?: CriterionDimension;
  value?: unknown;
  confidence?: number | null;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    if (!body.field) {
      return appError("invalid_profile_field", "field가 필요합니다.", 400, "field");
    }

    const current = await getServiceRepositories().companies.resolveCompanyProfile({ companyId });
    if (!current) return appError("company_not_found", "회사를 찾지 못했습니다.", 404, "companyId");

    const profile = updateCompanyProfileField(current, {
      field: body.field,
      value: body.value,
      confidence: body.confidence ?? null,
    });
    const saved = await getServiceRepositories().companies.saveCompanyProfile({
      companyId,
      userId: access.userId,
      profile,
    });

    return appData({ profile: saved });
  } catch (error) {
    return appErrorFromUnknown(error, "회사 프로필 입력을 저장하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<ProfileFieldRequest> {
  try {
    const parsed = await request.json() as ProfileFieldRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
