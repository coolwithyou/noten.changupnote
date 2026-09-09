import type { ActionResult, OwnedCompanyMatchingResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { requestCompanyScope } from "@/lib/server/auth/requestCompanyScope";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadOwnedCompanyMatching } from "@/lib/server/serviceData";
import { canWriteCompany } from "@/lib/server/auth/companyAccessPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireWebSession();
    const companyId = new URL(request.url).searchParams.get("companyId");
    const access = await requireCompanyAccess(requestCompanyScope(companyId ?? undefined));
    const matching = await loadOwnedCompanyMatching({ companyId: access.companyId, userId: access.userId });
    const data: OwnedCompanyMatchingResult = {
      ...matching,
      profileWriteAllowed: canWriteCompany(access.role),
    };
    return NextResponse.json<ActionResult<OwnedCompanyMatchingResult>>({ ok: true, data }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return webActionError<OwnedCompanyMatchingResult>(error, {
      code: "company_matching_failed", message: "저장된 사업자 정보를 불러오지 못했습니다.",
    });
  }
}
