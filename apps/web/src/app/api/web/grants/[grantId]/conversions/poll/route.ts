// on-demand 변환 폴링 (계획 2026-07-08 슬라이스 A3). 공고 상세 진입 시 클라이언트가 백그라운드로
// 호출해 해당 공고의 pending surface 만 즉석 변환한다 — 사용자가 보는 공고가 먼저 살아나는 경로.
//
// 가드:
//   - 인증: requireCompanyAccess (page-image 프록시와 동일 정책).
//   - 예산: surface ≤3, 전체 45초 — 못 끝내면 pending 으로 남고 다음 방문/스윕이 회복한다.
//   - 변환 서버 env 미설정이면 no-op (ok:false, skippedReason) — 페이지 동작에 영향 없음.
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { AuthRequiredError } from "@/lib/server/auth/session";
import { CompanyAccessForbiddenError } from "@/lib/server/auth/companyAccessPolicy";
import { getCunoteDb } from "@/lib/server/db/client";
import { runConversionPollSweep } from "@/lib/server/conversion/pollSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ grantId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    await requireCompanyAccess();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: { code: "unauthorized" } }, { status: 401 });
    }
    if (error instanceof CompanyAccessForbiddenError) {
      return NextResponse.json({ ok: false, error: { code: "forbidden" } }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: { code: "not_found" } }, { status: 404 });
  }

  const { grantId } = await context.params;
  if (!isUuid(grantId)) {
    return NextResponse.json({ ok: false, error: { code: "invalid_grant_id" } }, { status: 400 });
  }

  try {
    const summary = await runConversionPollSweep(getCunoteDb(), {
      grantId,
      limit: 3,
      maxAttempts: 25,
      intervalMs: 1200,
      budgetMs: 45_000,
    });

    return NextResponse.json({
      ok: summary.ok,
      skippedReason: summary.skippedReason ?? null,
      pendingCount: summary.pendingCount,
      previewReady: summary.previewReady,
      failed: summary.failed,
      stillPending: summary.stillPending,
      elapsedMs: summary.elapsedMs,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "conversion_poll_failed",
          message: error instanceof Error ? error.message : "변환 폴링에 실패했습니다.",
        },
      },
      { status: 500 },
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
