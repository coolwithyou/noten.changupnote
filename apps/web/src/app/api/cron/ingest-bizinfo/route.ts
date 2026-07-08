// Vercel Cron: 기업마당(BizInfo) 증분 수집(래퍼). 로컬 CLI(archive:bizinfo)와 동일한 코어(archiveBizInfo)를
// live·write·compareDb·skipUnchanged 로 호출한다. env 는 Vercel 이 이미 주입하므로 loadMonorepoEnv 불필요.
//
// Vercel 제약: HWP→markdown 변환은 pyhwp(python 서브프로세스)라 Vercel 런타임에서 불가능하다. 그래서
// convertAttachments=false, autoInstallPyhwp=false 로 고정하고, 첨부는 다운로드·R2 아카이브만 수행한다.
// markdown 변환은 별도 변환 큐/서버 트랙(registerAttachmentConversions → 변환 서버)이 나중에 담당한다.
//
// LLM: bizinfo criteria 추출은 Anthropic API 호출이다(키는 프로덕션 env 의 ANTHROPIC_API_KEY). extractionMode="auto"
// 라 키가 있으면 Anthropic, 없으면 allowTextOnlyFallback=true 로 text-only 폴백(needs_review)으로 그레이스풀하게 진행한다.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { archiveBizInfo } from "@/lib/server/ingestion/archiveBizInfoCore";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 첨부 다운로드 + R2 업로드 + 건당 Anthropic 추출이 있어 kstartup(300)보다 길다. Pro 플랜은 800 까지 허용.
export const maxDuration = 800;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const limit = boundedIntParam(params.get("limit"), 20, 1, 50);

  const startedAt = Date.now();
  // getCunoteDb 는 모듈 캐시 풀을 재사용한다(warm invocation 간 공유). 라우트에서 close 하지 않는다.
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTROPHIC_API_KEY?.trim();
  const anthropicModel = process.env.ANTHROPIC_MODEL;

  try {
    const result = await archiveBizInfo({
      db,
      source: "live",
      limit,
      offset: 0,
      sourceId: undefined,
      write: true,
      compareDb: true,
      skipUnchanged: true,
      // 키가 없으면 text-only 폴백으로 criteria 추출을 그레이스풀하게 진행(엔트리 하드 실패 대신 needs_review 발행).
      allowTextOnlyFallback: true,
      extractionMode: "auto",
      archiveAttachments: true,
      // Vercel 제약: pyhwp 불가 → 변환 없이 다운로드·R2 아카이브만. markdown 은 변환 큐 트랙이 담당.
      convertAttachments: false,
      autoInstallPyhwp: false,
      // 첨부 1건 다운로드 실패가 공고 전체 발행을 떨어뜨리지 않도록 그레이스풀 처리(실패는 응답에 집계).
      allowAttachmentFailures: true,
      collectedAt: new Date(),
      anthropicApiKey,
      anthropicModel,
      storage,
    });

    return NextResponse.json({
      ok: true,
      params: { limit },
      llm: {
        mode: result.extractionMode,
        anthropicKeyPresent: Boolean(anthropicApiKey),
        model: anthropicModel ?? null,
        anthropicCount: result.extraction.anthropicCount,
        textOnlyFallbackCount: result.extraction.textOnlyFallbackCount,
      },
      totals: {
        fetchedCount: result.fetchedCount,
        selectedCount: result.selectedCount,
        extractionCandidateCount: result.extractionCandidateCount,
        publishedCount: result.publishedCount,
        newCount: result.plan.newCount,
        changedCount: result.plan.changedCount,
        unchangedCount: result.plan.unchangedCount,
        extractionFailureCount: result.extraction.failureCount,
      },
      attachments: {
        archivedCount: result.attachments.archivedCount,
        convertedCount: result.attachments.convertedCount,
        skippedConversionCount: result.attachments.skippedConversionCount,
        attachmentRefreshCount: result.attachments.attachmentRefreshCount,
        failureCount: result.attachments.failureCount,
      },
      collectedAt: result.collectedAt,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "ingest_failed",
          message: error instanceof Error ? error.message : "기업마당 수집에 실패했습니다.",
        },
        params: { limit },
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
