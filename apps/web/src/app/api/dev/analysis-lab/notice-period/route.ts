// 공모 딥분석 실험실 — 기간 미상 공고의 모집기간 특정 (dev 전용: production 이면 404).
// PATCH /api/dev/analysis-lab/notice-period
//   본문 { grantId, applyEnd: "YYYY-MM-DD", applyStart?: "YYYY-MM-DD" | null }
//   → grants.applyStart/applyEnd 갱신 후 { grantId, applyStart, applyEnd } 반환.
//
// 모집기간 정책(2026-07-23): applyEnd null 공고는 AI 분석 대상에서 제외되는 "기간 미상
// 예외 큐"다 — 사용자가 원문을 감사해 여기로 기간을 입력하면 대상에 편입될 수 있다.
// 실험실에서 유일하게 DB 를 쓰는 라우트이며, 쓰는 컬럼은 grants.applyStart/applyEnd(+updatedAt)뿐.
//
// 날짜 규약(notice-period.ts 헤더 참조): 입력 "YYYY-MM-DD" 는 KST 캘린더 날짜로 해석하되,
// 저장은 수집 파이프라인(dateValue)과 동일하게 그 날짜의 UTC 자정으로 한다 — KST 자정
// 순간(전날 15:00Z)으로 저장하면 .toISOString().slice(0,10) 계열 판독이 하루 밀린다.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { parseDateInputToUtc } from "@/features/dev/analysis-lab/notice-period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

const badRequest = (message: string) =>
  NextResponse.json({ error: "invalid_period", message }, { status: 400 });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request) {
  if (isProduction()) return notFound();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return badRequest("요청 본문(JSON)을 읽지 못했습니다.");
  }

  const grantId = typeof body.grantId === "string" ? body.grantId.trim() : "";
  if (!UUID_PATTERN.test(grantId)) {
    return badRequest("grantId 는 uuid 형식이어야 합니다.");
  }

  // applyEnd 는 필수 — 기간 미상 해제의 최소 조건.
  if (typeof body.applyEnd !== "string" || body.applyEnd.trim().length === 0) {
    return badRequest("applyEnd(접수 마감일, YYYY-MM-DD)는 필수입니다.");
  }
  const applyEnd = parseDateInputToUtc(body.applyEnd.trim());
  if (!applyEnd) {
    return badRequest("applyEnd 는 실존하는 날짜의 YYYY-MM-DD 형식이어야 합니다.");
  }

  // applyStart 는 선택 — null/미지정/빈 문자열이면 null 저장(정책상 시작 미상은 "시작됨" 취급).
  let applyStart: Date | null = null;
  if (body.applyStart !== undefined && body.applyStart !== null) {
    if (typeof body.applyStart !== "string") {
      return badRequest("applyStart 는 YYYY-MM-DD 문자열 또는 null 이어야 합니다.");
    }
    const trimmed = body.applyStart.trim();
    if (trimmed.length > 0) {
      applyStart = parseDateInputToUtc(trimmed);
      if (!applyStart) {
        return badRequest("applyStart 는 실존하는 날짜의 YYYY-MM-DD 형식이어야 합니다.");
      }
    }
  }
  if (applyStart && applyStart.getTime() > applyEnd.getTime()) {
    return badRequest("applyStart 는 applyEnd 보다 늦을 수 없습니다.");
  }

  const db = getCunoteDb();
  const updated = await db
    .update(schema.grants)
    .set({ applyStart, applyEnd, updatedAt: new Date() })
    .where(eq(schema.grants.id, grantId))
    .returning({
      grantId: schema.grants.id,
      applyStart: schema.grants.applyStart,
      applyEnd: schema.grants.applyEnd,
    });
  const row = updated[0];
  if (!row) {
    return NextResponse.json(
      { error: "grant_not_found", message: "해당 grantId 의 공고가 없습니다." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    grantId: row.grantId,
    applyStart: row.applyStart ? row.applyStart.toISOString() : null,
    applyEnd: row.applyEnd ? row.applyEnd.toISOString() : null,
  });
}
