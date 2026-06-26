import type { ActionResult, NextQuestionDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dashboard = await loadServiceDashboard({ limit: 40 });
    return NextResponse.json<ActionResult<NextQuestionDto | null>>({
      ok: true,
      data: dashboard.nextQuestion ?? null,
    });
  } catch (error) {
    return NextResponse.json<ActionResult<NextQuestionDto | null>>({
      ok: false,
      error: {
        code: "next_question_failed",
        message: error instanceof Error ? error.message : "다음 질문을 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
