import type { ActionResult, NextQuestionDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { loadServiceDashboard } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const dashboard = await loadServiceDashboard({
      companyId: access.companyId,
      userId: access.userId,
      limit: 1,
      writeMatchStates: false,
    });
    return NextResponse.json<ActionResult<NextQuestionDto | null>>({
      ok: true,
      data: dashboard.nextQuestion ?? null,
    });
  } catch (error) {
    return webActionError<NextQuestionDto | null>(error, {
      code: "next_question_failed",
      message: "다음 질문을 불러오지 못했습니다.",
    });
  }
}
