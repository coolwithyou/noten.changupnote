import type { ActionResult, StatsResult } from "@cunote/contracts";
import { buildStats } from "@cunote/core";
import { NextResponse } from "next/server";
import { loadServiceGrants } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const asOf = new Date();
    const grants = await loadServiceGrants({ asOf, limit: 40 });
    const data = buildStats({ grants, asOf });
    return NextResponse.json<ActionResult<StatsResult>>({ ok: true, data });
  } catch (error) {
    return NextResponse.json<ActionResult<StatsResult>>({
      ok: false,
      error: {
        code: "stats_failed",
        message: error instanceof Error ? error.message : "지원사업 집계를 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
