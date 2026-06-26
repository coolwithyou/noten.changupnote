import type { ActionResult, ApplySheet } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadServiceApplySheet } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { grantId } = await context.params;
    const access = await requireCompanyAccess();
    const sheet = await loadServiceApplySheet(grantId, { companyId: access.companyId });
    if (!sheet) {
      return NextResponse.json<ActionResult<ApplySheet>>({
        ok: false,
        error: {
          code: "grant_not_found",
          message: "공고를 찾지 못했습니다.",
          field: "grantId",
        },
      }, { status: 404 });
    }

    return NextResponse.json<ActionResult<ApplySheet>>({ ok: true, data: sheet });
  } catch (error) {
    return webActionError<ApplySheet>(error, {
      code: "grant_detail_failed",
      message: "공고 상세를 불러오지 못했습니다.",
    });
  }
}
