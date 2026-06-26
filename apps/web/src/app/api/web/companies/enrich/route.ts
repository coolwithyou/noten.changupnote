import type { ActionResult, CompanyEnrichmentRequest, CompanyEnrichmentResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { enrichServiceCompany } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), readBody(request)]);
    if (!body.bizNo?.trim()) {
      return NextResponse.json<ActionResult<CompanyEnrichmentResult>>({
        ok: false,
        error: {
          code: "invalid_biz_no",
          message: "bizNo가 필요합니다.",
          field: "bizNo",
        },
      }, { status: 400 });
    }

    const data = await enrichServiceCompany({
      companyId: access.companyId,
      userId: access.userId,
      bizNo: body.bizNo,
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
