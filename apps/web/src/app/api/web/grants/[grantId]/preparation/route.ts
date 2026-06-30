import type { ActionResult, GrantPreparationResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadGrantPreparation } from "@/lib/server/documents/grantPreparation";

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
    const preparation = await loadGrantPreparation({ grantId, access });
    return NextResponse.json<ActionResult<GrantPreparationResult>>({ ok: true, data: preparation });
  } catch (error) {
    return webActionError<GrantPreparationResult>(error, {
      code: "grant_preparation_failed",
      message: "지원 준비 정보를 불러오지 못했습니다.",
    });
  }
}
