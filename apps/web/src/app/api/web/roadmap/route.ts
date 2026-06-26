import type { ActionResult, DashboardResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RoadmapPayload = Pick<DashboardResult, "counts" | "roadmap" | "rulesetVer" | "scoringVer">;

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const dashboard = await loadServiceDashboard({ companyId: access.companyId, userId: access.userId, limit: 40 });
    const data: RoadmapPayload = {
      counts: dashboard.counts,
      roadmap: dashboard.roadmap,
      rulesetVer: dashboard.rulesetVer,
      scoringVer: dashboard.scoringVer,
    };
    return NextResponse.json<ActionResult<RoadmapPayload>>({ ok: true, data });
  } catch (error) {
    return webActionError<RoadmapPayload>(error, {
      code: "roadmap_failed",
      message: "로드맵을 불러오지 못했습니다.",
    });
  }
}
