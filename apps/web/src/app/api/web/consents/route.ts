import type { ActionResult, ConsentGrantRequest, ConsentListResult, ConsentRecordDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getConsentStore, isConsentScope } from "@/lib/server/consents/consentStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const consents = await getConsentStore().listCompanyConsents(access.companyId, access.userId);
    return NextResponse.json<ActionResult<ConsentListResult>>({
      ok: true,
      data: {
        companyId: access.companyId,
        consents,
      },
    });
  } catch (error) {
    return webActionError<ConsentListResult>(error, {
      code: "consents_failed",
      message: "동의 내역을 불러오지 못했습니다.",
    });
  }
}

export async function PUT(request: Request) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), readBody(request)]);
    if (!isConsentScope(body.scope)) {
      return NextResponse.json<ActionResult<ConsentRecordDto>>({
        ok: false,
        error: {
          code: "invalid_consent_scope",
          message: "유효한 동의 scope가 필요합니다.",
          field: "scope",
        },
      }, { status: 400 });
    }

    const data = await getConsentStore().grantConsent({
      companyId: access.companyId,
      userId: access.userId,
      scope: body.scope,
      purpose: body.purpose ?? null,
    });
    return NextResponse.json<ActionResult<ConsentRecordDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<ConsentRecordDto>(error, {
      code: "consent_grant_failed",
      message: "동의를 저장하지 못했습니다.",
    });
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
