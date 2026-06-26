import type { ActionResult, DashboardResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireCompanyAccess();
    const data = await loadServiceDashboard({ limit: 40 });
    return NextResponse.json<ActionResult<DashboardResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<DashboardResult>(error, {
      code: "dashboard_failed",
      message: "기회 맵을 불러오지 못했습니다.",
    });
  }
}
