import { NextResponse } from "next/server";

import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { getLessonInboxData, isLessonStatus } from "@/lib/server/knowledge/lessonInboxData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * lesson 후보 목록 조회.
 * 쿼리: ?status=proposed|approved|rejected|retired (기본 proposed), ?sourceId=<uuid>.
 * 응답: { status, sourceId, lessons[](출처 조인용 sourceId 포함), sources(id→메타 맵), counts(상태별) }.
 * 인증 가드는 기존 검수 API(getReviewerIdentity)와 동일 — 미인가는 404 로 감춘다.
 */
export async function GET(request: Request) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status = isLessonStatus(statusParam) ? statusParam : "proposed";
  const sourceIdParam = url.searchParams.get("sourceId")?.trim();
  const sourceId = sourceIdParam && sourceIdParam.length > 0 ? sourceIdParam : undefined;

  const data = await getLessonInboxData({ status, sourceId });
  return NextResponse.json(data);
}
