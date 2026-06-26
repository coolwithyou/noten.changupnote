import type { ActionResult, DashboardResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchesPayload = Pick<DashboardResult, "counts" | "matches" | "roadmap" | "rulesetVer" | "scoringVer">;

export async function GET() {
  try {
    const dashboard = await loadServiceDashboard({ limit: 40 });
    const data: MatchesPayload = {
      counts: dashboard.counts,
      matches: dashboard.matches,
      roadmap: dashboard.roadmap,
      rulesetVer: dashboard.rulesetVer,
      scoringVer: dashboard.scoringVer,
    };
    return NextResponse.json<ActionResult<MatchesPayload>>({ ok: true, data });
  } catch (error) {
    return NextResponse.json<ActionResult<MatchesPayload>>({
      ok: false,
      error: {
        code: "matches_failed",
        message: error instanceof Error ? error.message : "매칭 결과를 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
