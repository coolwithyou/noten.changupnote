import { NextResponse } from "next/server";
import { completeSimpleAuth } from "@/lib/server/codef/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// dev 전용 가드 — api/dev/service-data 와 동일 규약(프로덕션 404).
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

/** 승인 후 완료(폴링 아님, 사용자 승인 후 1회 호출). body: { sessionId }. */
export async function POST(request: Request) {
  if (isProduction()) return notFound();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return NextResponse.json({ error: "invalid_session", message: "sessionId가 필요합니다." }, { status: 400 });
  }

  const result = await completeSimpleAuth(sessionId);
  return NextResponse.json(result);
}
