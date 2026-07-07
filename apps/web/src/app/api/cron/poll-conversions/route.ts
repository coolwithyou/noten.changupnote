// 변환 폴링 스윕 라우트. pending surface 를 변환 서버에 (재)등록·폴링해 document_artifacts 와
// extraction_status 를 반영한다 (Phase 2 T8 의 서버 측 배선 — 계획 2026-07-08 슬라이스 A3).
//
// Vercel Hobby 플랜의 cron 2개 제한으로 vercel.json 에는 등재하지 않는다. 트리거 경로:
//   1) ingest-kstartup cron 말미의 잔여 예산 스윕 (일 1회 기본선)
//   2) 수동: curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/poll-conversions?limit=20
//   3) on-demand: 공고 상세 진입 시 grant 단위 폴링 (별도 라우트)
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { runConversionPollSweep } from "@/lib/server/conversion/pollSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const limit = boundedIntParam(params.get("limit"), 20, 1, 100);
  const staleMs = boundedIntParam(params.get("staleMs"), 0, 0, 7 * 24 * 3600 * 1000);

  const startedAt = Date.now();
  const db = getCunoteDb();

  try {
    const summary = await runConversionPollSweep(db, {
      limit,
      staleMs,
      // 함수 예산 300초 안에서 여유를 남긴다 (응답 직렬화·콜드스타트 감안).
      budgetMs: 240_000,
      maxAttempts: 60,
      intervalMs: 1000,
    });

    return NextResponse.json({
      ok: summary.ok,
      params: { limit, staleMs },
      summary: {
        skippedReason: summary.skippedReason,
        pendingCount: summary.pendingCount,
        previewReady: summary.previewReady,
        failed: summary.failed,
        stillPending: summary.stillPending,
        skipped: summary.skipped,
        budgetExhausted: summary.budgetExhausted,
      },
      results: summary.results,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "conversion_sweep_failed",
          message: error instanceof Error ? error.message : "변환 폴링 스윕에 실패했습니다.",
        },
        params: { limit, staleMs },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

/** 쿼리 파라미터를 정수로 파싱한다. 비어있으면 fallback, 범위를 벗어나면 clamp. */
function boundedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
