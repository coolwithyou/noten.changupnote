import type { ActionResult, ConsentRevokeResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getConsentStore, isConsentScope } from "@/lib/server/consents/consentStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    scope: string;
  }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const [{ scope }, access] = await Promise.all([
      context.params,
      requireCompanyAccess({ permission: "write" }),
    ]);
    if (!isConsentScope(scope)) {
      return NextResponse.json<ActionResult<ConsentRevokeResult>>({
        ok: false,
        error: {
          code: "invalid_consent_scope",
          message: "유효한 동의 scope가 필요합니다.",
          field: "scope",
        },
      }, { status: 400 });
    }

    const revoked = await getConsentStore().revokeConsent({
      companyId: access.companyId,
      userId: access.userId,
      scope,
    });
    return NextResponse.json<ActionResult<ConsentRevokeResult>>({
      ok: true,
      data: {
        scope,
        revoked,
      },
    });
  } catch (error) {
    return webActionError<ConsentRevokeResult>(error, {
      code: "consent_revoke_failed",
      message: "동의 철회에 실패했습니다.",
    });
  }
}
