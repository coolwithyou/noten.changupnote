import { appData, appError, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { getConsentStore, isConsentScope } from "@/lib/server/consents/consentStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    companyId: string;
    scope: string;
  }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { companyId, scope } = await context.params;
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    if (!isConsentScope(scope)) return appError("invalid_consent_scope", "유효한 동의 scope가 필요합니다.", 400, "scope");

    const revoked = await getConsentStore().revokeConsent({
      companyId: access.companyId,
      userId: access.userId,
      scope,
    });
    return appData({ scope, revoked });
  } catch (error) {
    return appErrorFromUnknown(error, "동의 철회에 실패했습니다.");
  }
}
