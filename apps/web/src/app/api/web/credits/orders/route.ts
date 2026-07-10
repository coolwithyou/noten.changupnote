// GET /api/web/credits/orders?cursor (설계 9.1) — 내 주문·결제 내역(최신순).
import type { ActionResult, CreditOrderDto, CreditOrderListDto } from "@cunote/contracts";
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
    const cursor = params.get("cursor");
    const limit = Number(params.get("limit")) || 20;

    const repositories = getServiceRepositories();
    const wallet = await repositories.credits.getWalletForUser(userId);
    if (!wallet) {
      const empty: CreditOrderListDto = { orders: [], cursor: null, hasMore: false };
      return NextResponse.json<ActionResult<CreditOrderListDto>>({ ok: true, data: empty });
    }

    const { orders, nextCursor, hasMore } = await repositories.creditsPayment.listOrdersForWallet({
      walletId: wallet.id,
      limit,
      cursor,
    });

    const data: CreditOrderListDto = {
      orders: orders.map(
        (o): CreditOrderDto => ({
          paymentId: o.paymentId,
          orderType: o.orderType,
          amountKrw: o.amountKrw,
          creditsToGrant: o.creditsToGrant,
          status: o.status,
          payMethod: o.payMethod,
          paidAt: o.paidAt ? o.paidAt.toISOString() : null,
          refundedAmountKrw: o.refundedAmountKrw,
          createdAt: o.createdAt.toISOString(),
        }),
      ),
      cursor: nextCursor,
      hasMore,
    };
    return NextResponse.json<ActionResult<CreditOrderListDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditOrderListDto>(error, {
      code: "credit_orders_failed",
      message: "주문 내역을 불러오지 못했습니다.",
    });
  }
}
