import type { ActionResult, DashboardResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await loadServiceDashboard({ limit: 40 });
    return NextResponse.json<ActionResult<DashboardResult>>({ ok: true, data });
  } catch (error) {
    return NextResponse.json<ActionResult<DashboardResult>>({
      ok: false,
      error: {
        code: "dashboard_failed",
        message: error instanceof Error ? error.message : "기회 맵을 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
