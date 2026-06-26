import type { ActionQueueItem, ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dashboard = await loadServiceDashboard({ limit: 40 });
    return NextResponse.json<ActionResult<ActionQueueItem[]>>({
      ok: true,
      data: dashboard.actionQueue,
    });
  } catch (error) {
    return NextResponse.json<ActionResult<ActionQueueItem[]>>({
      ok: false,
      error: {
        code: "action_queue_failed",
        message: error instanceof Error ? error.message : "다음 할 일을 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
