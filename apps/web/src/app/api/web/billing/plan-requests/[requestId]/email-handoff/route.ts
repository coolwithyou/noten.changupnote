import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  billingPlanRequestEmailHandoffDownloadResponse,
  buildBillingPlanRequestEmailHandoff,
} from "@/lib/server/billing/planRequestEmailHandoff";
import { BillingPlanRequestHistoryError } from "@/lib/server/billing/planRequestHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    requestId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ requestId }, access, session] = await Promise.all([
      context.params,
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const handoff = await buildBillingPlanRequestEmailHandoff({
      access,
      session,
      requestId,
    });
    return billingPlanRequestEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof BillingPlanRequestHistoryError) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        },
      }, { status: error.status });
    }
    return webActionError<null>(error, {
      code: "billing_plan_request_email_handoff_failed",
      message: "플랜 전환 요청 메일 파일을 만들지 못했습니다.",
    });
  }
}
