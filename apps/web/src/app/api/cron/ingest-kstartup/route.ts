// Vercel Cron: K-Startup 증분 수집(래퍼). 로컬 CLI(archive:kstartup)와 동일한 코어(archiveKStartup)를
// live·write·compareDb·skipUnchanged·details 로 호출한다. env 는 Vercel 이 이미 주입하므로 loadMonorepoEnv 불필요.
//
// 시간 예산: 페이지 fetch + 상세 maxDetails 건 ×(350ms + fetch) 로 300초 내 수렴하도록 기본값을 잡는다.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { runConversionPollSweep } from "@/lib/server/conversion/pollSweep";
import { getCunoteDb } from "@/lib/server/db/client";
import { archiveKStartup } from "@/lib/server/ingestion/archiveKStartupCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const pages = boundedIntParam(params.get("pages"), 2, 1, 5);
  const perPage = boundedIntParam(params.get("perPage"), 100, 1, 100);
  const maxDetails = boundedIntParam(params.get("maxDetails"), 120, 0, 200);

  const startedAt = Date.now();
  // getCunoteDb 는 모듈 캐시 풀을 재사용한다(warm invocation 간 공유). 라우트에서 close 하지 않는다.
  const db = getCunoteDb();

  try {
    const result = await archiveKStartup({
      db,
      source: "live",
      perPage,
      startPage: 1,
      pages,
      allPages: false,
      maxPages: pages,
      limit: undefined,
      write: true,
      compareDb: true,
      skipUnchanged: true,
      stopAfterUnchangedPages: 0,
      collectedAt: new Date(),
      details: true,
      maxDetailFetches: maxDetails,
      // 첨부 본문 다운로드는 별도 측정·예산 확정 전까지 명시적으로 비활성화한다.
      archiveAttachments: false,
    });

    // 잔여 예산 변환 폴링 스윕 (계획 2026-07-08 슬라이스 A3): 이 수집이 등록한 pending surface 를
    // 같은 실행에서 변환한다. Hobby 플랜 cron 2개 제한으로 별도 cron 을 못 늘려 여기 얹는다.
    // 실패·예산 부족은 무해 — pending 으로 남아 on-demand 폴링/수동 스윕이 회복한다.
    const conversionSweep = await runTailConversionSweep(db, startedAt);

    return NextResponse.json({
      ok: true,
      params: { pages, perPage, maxDetails },
      totals: result.totals,
      detailTotals: result.detailTotals,
      attachmentArchiveTotals: result.attachmentArchiveTotals,
      revisionRefresh: result.revisionRefresh,
      stopReason: result.stopReason,
      pageCount: result.pageCount,
      collectedAt: result.collectedAt,
      conversionSweep,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "ingest_failed",
          message: error instanceof Error ? error.message : "K-Startup 수집에 실패했습니다.",
        },
        params: { pages, perPage, maxDetails },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

/**
 * 함수 예산(300초) 중 남은 시간으로 변환 폴링 스윕을 돌린다. 여유가 15초 미만이면 건너뛴다.
 * 스윕 내부 오류는 삼켜서 수집 응답을 깨지 않는다.
 */
async function runTailConversionSweep(db: ReturnType<typeof getCunoteDb>, startedAt: number) {
  const leftoverMs = 240_000 - (Date.now() - startedAt);
  if (leftoverMs < 15_000) {
    return { skippedReason: "budget_exhausted", leftoverMs };
  }
  try {
    const summary = await runConversionPollSweep(db, {
      limit: 10,
      budgetMs: leftoverMs,
      maxAttempts: 60,
      intervalMs: 1000,
    });
    return {
      skippedReason: summary.skippedReason ?? null,
      pendingCount: summary.pendingCount,
      previewReady: summary.previewReady,
      failed: summary.failed,
      stillPending: summary.stillPending,
      budgetExhausted: summary.budgetExhausted,
      elapsedMs: summary.elapsedMs,
    };
  } catch (error) {
    return {
      skippedReason: "sweep_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 쿼리 파라미터를 정수로 파싱한다. 비어있으면 fallback, 범위를 벗어나면 clamp. */
function boundedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
