// GET /api/web/credits/usage?from&to&feature&cursor (설계 9.1 / 10.3)
// usage_events 목록 + 기간 합계(byFeature). 토큰/모델은 상세 토글용으로 함께 내리되 기본 표시는 기능명·크레딧.
import type { ActionResult, CreditUsageListDto } from "@cunote/contracts";
import { featureLabel } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;
    const params = new URL(request.url).searchParams;
    const from = parseDate(params.get("from"));
    const to = parseDate(params.get("to"));
    const feature = params.get("feature")?.trim() || null;
    const cursor = params.get("cursor");
    const limit = boundedInt(params.get("limit"), 20, 1, 100);

    const repositories = getServiceRepositories();
    const wallet = await repositories.credits.getWalletForUser(userId);
    if (!wallet) {
      const empty: CreditUsageListDto = {
        events: [],
        summary: { totalCredits: 0, byFeature: [] },
        cursor: null,
        hasMore: false,
      };
      return NextResponse.json<ActionResult<CreditUsageListDto>>({ ok: true, data: empty });
    }

    const result = await repositories.credits.listUsageForUser(userId, {
      walletId: wallet.id,
      from,
      to,
      featureCode: feature,
      limit,
      cursor,
    });
    const data: CreditUsageListDto = {
      events: result.events.map((e) => ({
        id: e.id,
        featureCode: e.featureCode,
        featureLabel: featureLabel(e.featureCode),
        creditsCharged: e.creditsCharged,
        status: e.status,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        createdAt: e.createdAt.toISOString(),
        contextRef: e.contextRef,
      })),
      summary: {
        totalCredits: result.summary.totalCredits,
        byFeature: result.summary.byFeature.map((f) => ({
          featureCode: f.featureCode,
          featureLabel: featureLabel(f.featureCode),
          credits: f.credits,
          count: f.count,
        })),
      },
      cursor: result.nextCursor,
      hasMore: result.hasMore,
    };
    return NextResponse.json<ActionResult<CreditUsageListDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditUsageListDto>(error, {
      code: "credit_usage_failed",
      message: "사용 내역을 불러오지 못했습니다.",
    });
  }
}

function parseDate(raw: string | null): Date | null {
  if (!raw || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
