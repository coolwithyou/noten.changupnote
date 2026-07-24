// Vercel Cron: K-Startup 증분 수집(래퍼). 로컬 CLI(archive:kstartup)와 동일한 코어(archiveKStartup)를
// live·write·compareDb·skipUnchanged·details 로 호출한다. env 는 Vercel 이 이미 주입하므로 loadMonorepoEnv 불필요.
//
// 시간 예산: 페이지 fetch + 상세 maxDetails 건 ×(350ms + fetch) 로 300초 내 수렴하도록 기본값을 잡는다.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { runConversionPollSweep } from "@/lib/server/conversion/pollSweep";
import { getCunoteDb } from "@/lib/server/db/client";
import { archiveKStartup } from "@/lib/server/ingestion/archiveKStartupCore";
import { runKStartupAttachmentArchiveBatch } from "@/lib/server/ingestion/kstartupAttachmentArchiveBatch";
import { createRemoteHwpMarkdownFromEnv } from "@/lib/server/ingestion/remoteHwpMarkdown";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

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
      // 인라인 다운로드는 여전히 끈다. 아래 bounded tail sweep이 신규/변경분 우선으로
      // 전역 grant/attachment/시간 예산 안에서 기존 backlog까지 함께 복구한다.
      archiveAttachments: false,
    });

    const priorityAttachmentSourceIds = result.pages.flatMap((page) => [
      ...page.plan.newSourceIds,
      ...page.plan.changedSourceIds,
    ]);
    const attachmentArchiveSweep = await runTailAttachmentArchiveSweep(
      db,
      priorityAttachmentSourceIds,
      startedAt,
    );

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
      attachmentArchiveSweep,
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
 * 수집 후 활성 K-Startup 첨부를 소량 복구한다. 새/변경 공고를 우선하되 persisted
 * active pool도 함께 보므로 unchanged backlog가 영구 정체되지 않는다.
 */
async function runTailAttachmentArchiveSweep(
  db: ReturnType<typeof getCunoteDb>,
  prioritySourceIds: string[],
  startedAt: number,
) {
  const deadlineAtMs = startedAt + 180_000;
  if (Date.now() >= deadlineAtMs) {
    return { skippedReason: "budget_exhausted", deadlineAtMs };
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) return { skippedReason: "storage_env_missing" };
  try {
    const result = await runKStartupAttachmentArchiveBatch({
      db,
      storage,
      scanLimit: 2_000,
      asOf: new Date(),
      write: true,
      // Vercel에는 로컬 pyhwp가 없으므로 변환 서버 env가 확인된 경우에만 원격 HWP
      // markdown 폴백을 켠다. env가 빠진 배포는 기존처럼 원본 아카이브만 수행한다.
      convertHwp: Boolean(createRemoteHwpMarkdownFromEnv()),
      allowFailures: true,
      maxGrants: 4,
      maxTotalAttachments: 6,
      maxAttachmentsPerGrant: 2,
      prioritySourceIds,
      fetchTimeoutMs: 20_000,
      maxAttachmentBytes: 50 * 1024 * 1024,
      deadlineAtMs,
    });
    return {
      skippedReason: null,
      totalCandidateCount: result.totalCandidateCount,
      batchCandidateCount: result.batchCandidateCount,
      selectedAttachmentCount: result.selectedAttachmentCount,
      succeededCount: result.succeededCount,
      failedCount: result.failedCount,
      deadlineReached: result.deadlineReached,
      sourceIds: result.results.map((item) => String(item.sourceId ?? "")).filter(Boolean),
    };
  } catch (error) {
    return {
      skippedReason: "archive_sweep_error",
      message: error instanceof Error ? error.message : String(error),
    };
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
