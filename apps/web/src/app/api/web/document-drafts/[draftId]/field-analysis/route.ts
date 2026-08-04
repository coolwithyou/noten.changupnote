import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  ensureDraftApplicationFields,
  type ApplicationFieldAnalysisResult,
} from "@/lib/server/documents/applicationFieldAnalysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

/** 선택된 지원서 초안의 원본 HWP/HWPX 한 건만 KorDoc으로 분석해 workspace 필드맵을 준비한다. */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const data = await ensureDraftApplicationFields({ draftId, access });
    return NextResponse.json<ActionResult<ApplicationFieldAnalysisResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<ApplicationFieldAnalysisResult>(error, {
      code: "application_field_analysis_failed",
      message: "지원서 작성 항목을 분석하지 못했습니다.",
    });
  }
}
