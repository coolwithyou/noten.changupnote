// GET /api/web/credits/balance (설계 9.1)
// 표시 잔액은 available(balance − pending holds)로 통일해 "잔액은 있는데 402" 착시를 없앤다.
// 6.6 안전망: ensureWalletWithSignupBonus 로 지갑·보너스를 지연 지급(lazy grant)한 뒤 조회한다.
import type { ActionResult, CreditBalanceDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOW_BALANCE_FALLBACK = 200;
const EXPIRING_SOON_DAYS = 14;

export async function GET() {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;
    const repositories = getServiceRepositories();

    // 6.6: 지갑 없으면 생성 + 가입 보너스 지급(멱등). 있으면 지갑만 반환.
    const wallet = await repositories.credits.ensureWalletWithSignupBonus(userId);
    const pendingHolds = await repositories.credits.sumPendingHolds(userId, wallet.id);
    const lots = await repositories.credits.listActiveLotsForUser(userId);
    const lowThreshold = await repositories.creditsSystem.readNumericSetting(
      "low_balance_warn_credits",
      LOW_BALANCE_FALLBACK,
    );

    const available = Math.max(0, wallet.balanceCredits - pendingHolds);
    const soonCutoff = Date.now() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
    const expiringSoon = lots
      .filter((l) => l.expiresAt !== null && l.expiresAt.getTime() <= soonCutoff && l.remainingCredits > 0)
      .map((l) => ({ lotId: l.id, remaining: l.remainingCredits, expiresAt: l.expiresAt!.toISOString() }));

    const data: CreditBalanceDto = {
      balance: wallet.balanceCredits,
      pendingHolds,
      available,
      lowBalance: available <= lowThreshold,
      expiringSoon,
    };
    return NextResponse.json<ActionResult<CreditBalanceDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditBalanceDto>(error, {
      code: "credit_balance_failed",
      message: "크레딧 잔액을 불러오지 못했습니다.",
    });
  }
}
