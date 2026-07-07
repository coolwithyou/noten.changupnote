// Vercel Cron: K-Startup 증분 수집(래퍼). 로컬 CLI(archive:kstartup)와 동일한 코어(archiveKStartup)를
// live·write·compareDb·skipUnchanged·details 로 호출한다. env 는 Vercel 이 이미 주입하므로 loadMonorepoEnv 불필요.
//
// 시간 예산: 페이지 fetch + 상세 maxDetails 건 ×(350ms + fetch) 로 300초 내 수렴하도록 기본값을 잡는다.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
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
    });

    return NextResponse.json({
      ok: true,
      params: { pages, perPage, maxDetails },
      totals: result.totals,
      detailTotals: result.detailTotals,
      stopReason: result.stopReason,
      pageCount: result.pageCount,
      collectedAt: result.collectedAt,
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

/** 쿼리 파라미터를 정수로 파싱한다. 비어있으면 fallback, 범위를 벗어나면 clamp. */
function boundedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
