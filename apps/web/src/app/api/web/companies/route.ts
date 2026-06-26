import type { ActionResult } from "@cunote/contracts";
import type { CompanyRecord } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebCompaniesResult {
  currentCompanyId: string;
  companies: CompanyRecord[];
}

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const companies = await getServiceRepositories().companies.listUserCompanies(access.userId);
    return NextResponse.json<ActionResult<WebCompaniesResult>>({
      ok: true,
      data: {
        currentCompanyId: access.companyId,
        companies,
      },
    });
  } catch (error) {
    return webActionError<WebCompaniesResult>(error, {
      code: "companies_failed",
      message: "회사 목록을 불러오지 못했습니다.",
    });
  }
}
