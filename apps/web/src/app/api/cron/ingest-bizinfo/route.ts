// Vercel Cron: 기업마당(BizInfo) 증분 수집(래퍼). 로컬 CLI(archive:bizinfo)와 동일한 코어(archiveBizInfo)를
// live·write·compareDb·skipUnchanged 로 호출한다. env 는 Vercel 이 이미 주입하므로 loadMonorepoEnv 불필요.
//
// Vercel 제약: 로컬 pyhwp는 사용할 수 없다. CONVERSION_SERVER_URL/SHARED_SECRET이 모두
// 있는 배포에서는 R2 원본을 Cloud Run /v1/hwp-markdown으로 보내 동기 변환하고, env가
// 빠진 배포에서는 원본 다운로드·R2 아카이브만 수행한다.
//
// LLM: bizinfo criteria 추출은 Anthropic API 호출이다(키는 프로덕션 env 의 ANTHROPIC_API_KEY). extractionMode="auto"
// 라 키가 있으면 Anthropic, 없으면 allowTextOnlyFallback=true 로 text-only 폴백(needs_review)으로 그레이스풀하게 진행한다.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { archiveBizInfo } from "@/lib/server/ingestion/archiveBizInfoCore";
import { createRemoteHwpMarkdownFromEnv } from "@/lib/server/ingestion/remoteHwpMarkdown";
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
      // 증분 크론은 강제 재발행 안 함(변경분만). 전량 재추출 백필은 CLI --force-republish 로 별도 실행.
      forceRepublish: false,
      // 키가 없으면 text-only 폴백으로 criteria 추출을 그레이스풀하게 진행(엔트리 하드 실패 대신 needs_review 발행).
      allowTextOnlyFallback: true,
      extractionMode: "auto",
      archiveAttachments: true,
      // 로컬 pyhwp 대신 배포된 Cloud Run 변환 서버가 준비된 경우에만 markdown까지 만든다.
      // archiveBizInfoCore는 생성된 attachmentMarkdowns를 같은 Anthropic 추출 입력에 포함한다.
      convertAttachments: Boolean(createRemoteHwpMarkdownFromEnv()),
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
      revisionRefresh: result.revisionRefresh,
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
