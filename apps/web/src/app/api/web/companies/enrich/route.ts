import type { ActionResult, CompanyEnrichmentRequest, CompanyEnrichmentResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { requireActiveConsent } from "@/lib/server/consents/consentStore";
import { enrichServiceCompany, getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), readBody(request)]);
    // bizNo 미제공 시 현재 회사에 저장된 사업자번호로 대체한다.
    const bizNo = body.bizNo?.trim()
      || (await getServiceRepositories().companies.getCompanyBizNo({
        companyId: access.companyId,
        userId: access.userId,
      }))?.trim();
    if (!bizNo) {
      return NextResponse.json<ActionResult<CompanyEnrichmentResult>>({
        ok: false,
        error: {
          code: "invalid_biz_no",
          message: "bizNo가 필요합니다.",
          field: "bizNo",
        },
      }, { status: 400 });
    }

    await requireActiveConsent({
      companyId: access.companyId,
      userId: access.userId,
      scope: "basic_info",
    });

    const data = await enrichServiceCompany({
      companyId: access.companyId,
      userId: access.userId,
      bizNo,
    });
    return NextResponse.json<ActionResult<CompanyEnrichmentResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<CompanyEnrichmentResult>(error, {
      code: "company_enrichment_failed",
      message: "회사 정보를 보강하지 못했습니다.",
    });
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
