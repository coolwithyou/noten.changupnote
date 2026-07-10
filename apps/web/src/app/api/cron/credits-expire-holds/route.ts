// hold TTL 만료 스윕 (설계 5.3 / 9.2). 매 5분 주기.
//
//   status=pending AND expires_at < now() 인 hold →
//     credit_holds.status = released (released_reason="ttl_expired")
//     usage_events.status  = failed   (error_code="hold_expired")
//
// 이 전환은 ★ 잠정적이다: 뒤늦은 capture 가 도착하면 usage:{usageEventId} 멱등 키로 정산이 이긴다
// (레드팀 B3 — captureHold 는 hold 상태에 의존하지 않는다). 대사(14.1)가 미정산 후보를 리포트한다.
//
// 시스템 경로(user 컨텍스트 없음, 4.13): CRON_SECRET Bearer 로 보호. 원장 분개는 없다(hold 는 분개가 아님).
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const limit = boundedIntParam(params.get("limit"), 500, 1, 5000);
  const startedAt = Date.now();
  const db = getCunoteDb();

  try {
    // 만료 대상 hold 를 released 로 전환하고, 대응 usage_events 를 failed 로 잠정 표기한다.
    // (원장 분개 없음. hold 는 admission control 일 뿐.)
    const expired = await db.execute<{ id: string; usage_event_id: string }>(sql`
      WITH due AS (
        SELECT id, usage_event_id
        FROM credit_holds
        WHERE status = 'pending' AND expires_at < now()
        ORDER BY expires_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ), released AS (
        UPDATE credit_holds h
        SET status = 'released', released_reason = 'ttl_expired', updated_at = now()
        FROM due
        WHERE h.id = due.id
        RETURNING h.id, h.usage_event_id
      )
      SELECT id, usage_event_id FROM released
    `);

    const usageEventIds = expired.map((r) => r.usage_event_id);
    let usageFailed = 0;
    if (usageEventIds.length > 0) {
      // pending 인 usage_events 만 failed 로 표기(이미 settled 면 건드리지 않는다 — capture 가 이긴 경우).
      const marked = await db.execute<{ id: string }>(sql`
        UPDATE usage_events
        SET status = 'failed', error_code = 'hold_expired', updated_at = now()
        WHERE id = ANY(${sql`ARRAY[${sql.join(usageEventIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})
          AND status = 'pending'
        RETURNING id
      `);
      usageFailed = marked.length;
    }

    return NextResponse.json({
      ok: true,
      summary: { holdsExpired: expired.length, usageEventsFailed: usageFailed },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "expire_holds_failed",
          message: error instanceof Error ? error.message : "hold 만료 스윕에 실패했습니다.",
        },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

function boundedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
