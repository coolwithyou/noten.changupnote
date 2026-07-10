// GET /api/web/credits/usage/export?from&to (설계 9.1)
// 사용 내역 CSV(text/csv). 기간 내 전체를 커서로 순회해 내보낸다(안전 상한 내).
import { featureLabel } from "@cunote/core";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 10000; // 안전 상한.
const PAGE = 100;

export async function GET(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;
    const params = new URL(request.url).searchParams;
    const from = parseDate(params.get("from"));
    const to = parseDate(params.get("to"));

    const repositories = getServiceRepositories();
    const wallet = await repositories.credits.getWalletForUser(userId);

    const header = ["일시", "기능", "차감 크레딧", "상태", "모델", "입력 토큰", "출력 토큰"];
    const lines: string[] = [header.map(csvCell).join(",")];

    if (wallet) {
      let cursor: string | null = null;
      let fetched = 0;
      for (;;) {
        const result = await repositories.credits.listUsageForUser(userId, {
          walletId: wallet.id,
          from,
          to,
          featureCode: null,
          limit: PAGE,
          cursor,
        });
        for (const e of result.events) {
          lines.push(
            [
              e.createdAt.toISOString(),
              featureLabel(e.featureCode),
              String(e.creditsCharged),
              e.status,
              e.model ?? "",
              String(e.inputTokens),
              String(e.outputTokens),
            ]
              .map(csvCell)
              .join(","),
          );
          fetched += 1;
        }
        if (!result.hasMore || !result.nextCursor || fetched >= MAX_ROWS) break;
        cursor = result.nextCursor;
      }
    }

    const csv = `﻿${lines.join("\r\n")}\r\n`; // BOM 으로 엑셀 한글 깨짐 방지.
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="credit-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    return webActionError(error, {
      code: "credit_usage_export_failed",
      message: "사용 내역을 내보내지 못했습니다.",
    });
  }
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function parseDate(raw: string | null): Date | null {
  if (!raw || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
