// GET /api/web/credits/ledger?cursor&limit&type (설계 9.1)
// 분개 목록(커서 페이지네이션, 최신순). description 은 서버에서 한국어 조립.
import type { ActionResult, CreditLedgerListDto } from "@cunote/contracts";
import { ledgerEntryDescription } from "@cunote/core";
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
    const limit = boundedInt(params.get("limit"), 20, 1, 100);
    const cursor = params.get("cursor");
    const type = params.get("type")?.trim() || null;

    const repositories = getServiceRepositories();
    const wallet = await repositories.credits.getWalletForUser(userId);
    if (!wallet) {
      const empty: CreditLedgerListDto = { entries: [], cursor: null, hasMore: false };
      return NextResponse.json<ActionResult<CreditLedgerListDto>>({ ok: true, data: empty });
    }

    const result = await repositories.credits.listLedgerForUser(userId, {
      walletId: wallet.id,
      limit,
      cursor,
      entryType: type,
    });
    const data: CreditLedgerListDto = {
      entries: result.entries.map((e) => ({
        id: e.id,
        entryType: e.entryType,
        amount: e.amountCredits,
        balanceAfter: e.balanceAfter,
        createdAt: e.createdAt.toISOString(),
        description: ledgerEntryDescription({ entryType: e.entryType, amountCredits: e.amountCredits, reason: e.reason }),
      })),
      cursor: result.nextCursor,
      hasMore: result.hasMore,
    };
    return NextResponse.json<ActionResult<CreditLedgerListDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditLedgerListDto>(error, {
      code: "credit_ledger_failed",
      message: "크레딧 원장을 불러오지 못했습니다.",
    });
  }
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
