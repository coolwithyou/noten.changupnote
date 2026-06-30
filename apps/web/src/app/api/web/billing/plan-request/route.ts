import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  submitBillingPlanRequest,
  type BillingPlanRequestReceipt,
} from "@/lib/server/billing/planRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await requireCompanyAccess({ permission: "write" });
    const session = await getOptionalWebSession();
    const body = await request.json() as Record<string, unknown>;
    const receipt = await submitBillingPlanRequest({
      access,
      session,
      email: typeof body.email === "string" ? body.email : session?.user.email ?? "",
      name: typeof body.name === "string" ? body.name : session?.user.name ?? null,
      desiredPlan: body.desiredPlan,
      seatCount: body.seatCount,
      billingCycle: body.billingCycle,
      message: typeof body.message === "string" ? body.message : null,
    });
    return NextResponse.json<ActionResult<BillingPlanRequestReceipt>>(
      { ok: true, data: receipt },
      { status: receipt.persisted ? 201 : 202 },
    );
  } catch (error) {
    return webActionError<BillingPlanRequestReceipt>(error, {
      code: "billing_plan_request_failed",
      message: "플랜 전환 요청을 접수하지 못했습니다.",
    });
  }
}
