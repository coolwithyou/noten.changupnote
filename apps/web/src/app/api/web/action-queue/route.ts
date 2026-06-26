import type { ActionQueueItem, ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const dashboard = await loadServiceDashboard({ companyId: access.companyId, limit: 40 });
    return NextResponse.json<ActionResult<ActionQueueItem[]>>({
      ok: true,
      data: dashboard.actionQueue,
    });
  } catch (error) {
    return webActionError<ActionQueueItem[]>(error, {
      code: "action_queue_failed",
      message: "다음 할 일을 불러오지 못했습니다.",
    });
  }
}
