// lot 만료 소멸 cron (설계 5.4 / 9.2). 일 1회 04:00 KST.
//
//   status=active AND expires_at < now() AND remaining > 0 인 lot 마다
//     applyLedgerEntry(expiry, -remaining, key=expiry:{lotId}, lotSelection={targetLotIds:[lotId]})
//     → lot status=expired
//
// ★ 반드시 targetLotIds(레드팀 M1). ★ pending hold 지갑은 이번 회차 스킵(5.4, 레드팀 M8과 경합 방지).
// 시스템 경로지만 원장 변이가 있으므로 각 지갑 userId 로 withCunoteDbUser 컨텍스트를 세팅한다(4.13/5.2).
// CRON_SECRET Bearer 로 보호.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { expireLots } from "@/lib/server/credits/lotExpiryService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const limit = boundedIntParam(params.get("limit"), 1000, 1, 5000);
  const startedAt = Date.now();
  const db = getCunoteDb();

  try {
    const result = await expireLots(db, new Date(), limit);
    return NextResponse.json({
      ok: true,
      summary: result,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "expire_lots_failed",
          message: error instanceof Error ? error.message : "lot 만료 스윕에 실패했습니다.",
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
