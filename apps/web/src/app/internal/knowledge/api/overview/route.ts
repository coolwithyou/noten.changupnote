import { NextResponse } from "next/server";

import { buildKnowledgeDashboardData } from "@/lib/server/knowledge/knowledgeDashboardData";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 지식 관리 대시보드 개요 데이터.
 *
 * 인증: getReviewerIdentity(미인가는 404 — 리뷰어 워크스페이스와 동일 가드).
 * 응답: buildKnowledgeDashboardData() 결과를 그대로 JSON 으로 반환한다.
 */
export async function GET() {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  try {
    const data = await buildKnowledgeDashboardData();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: "dashboard_failed", message }, { status: 500 });
  }
}
