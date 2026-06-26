import type { ConsentGrantRequest } from "@cunote/contracts";
import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { getConsentStore, isConsentScope } from "@/lib/server/consents/consentStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    companyId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { companyId } = await context.params;
    const access = await requireAppCompanyAccess(request, companyId);
    const consents = await getConsentStore().listCompanyConsents(access.companyId, access.userId);
    return appData({ companyId: access.companyId, consents });
  } catch (error) {
    return appErrorFromUnknown(error, "동의 내역을 불러오지 못했습니다.");
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    if (!isConsentScope(body.scope)) return appError("invalid_consent_scope", "유효한 동의 scope가 필요합니다.", 400, "scope");

    const consent = await getConsentStore().grantConsent({
      companyId: access.companyId,
      userId: access.userId,
      scope: body.scope,
      purpose: body.purpose ?? null,
    });
    return appData({ consent });
  } catch (error) {
    return appErrorFromUnknown(error, "동의를 저장하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<Partial<ConsentGrantRequest>> {
  try {
    const parsed = await request.json() as Partial<ConsentGrantRequest>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
