// POST /api/web/plans/billing-key (설계 8.5 / 9.1) — 빌링키 교체.
//
// no_subscription→409 / replaced→CreditBillingKeyResultDto{ok:true, cardBrand, cardLast4}.
import type { ActionResult, CreditBillingKeyResultDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { replaceBillingKey } from "@/lib/server/payments/subscriptionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;

    const portone = getPortoneClient();
    if (!portone.isConfigured()) {
      return NextResponse.json<ActionResult<CreditBillingKeyResultDto>>(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { billingKey?: unknown; cardSummary?: unknown }
      | null;
    const billingKey = typeof body?.billingKey === "string" ? body.billingKey.trim() : "";
    if (!billingKey) {
      return NextResponse.json<ActionResult<CreditBillingKeyResultDto>>(
        { ok: false, error: { code: "invalid_request", message: "billingKey 가 필요합니다.", field: "billingKey" } },
        { status: 400 },
      );
    }
    const cardSummary = parseCardSummary(body?.cardSummary);

    const repositories = getServiceRepositories();
    const outcome = await replaceBillingKey(
      { userId, newBillingKey: billingKey, cardSummary },
      {
        subscription: repositories.creditsSubscription,
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
      },
    );

    if (outcome.kind === "no_subscription") {
      return NextResponse.json<ActionResult<CreditBillingKeyResultDto>>(
        { ok: false, error: { code: "no_subscription", message: "빌링키를 교체할 활성 구독이 없습니다." } },
        { status: 409 },
      );
    }

    const data: CreditBillingKeyResultDto = {
      ok: true,
      cardBrand: outcome.cardBrand,
      cardLast4: outcome.cardLast4,
    };
    return NextResponse.json<ActionResult<CreditBillingKeyResultDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditBillingKeyResultDto>(error, {
      code: "plan_billing_key_failed",
      message: "빌링키를 교체하지 못했습니다.",
    });
  }
}

function parseCardSummary(raw: unknown): { brand?: string; last4?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { brand?: unknown; last4?: unknown };
  const summary: { brand?: string; last4?: string } = {};
  if (typeof r.brand === "string") summary.brand = r.brand;
  if (typeof r.last4 === "string") summary.last4 = r.last4;
  return summary.brand || summary.last4 ? summary : null;
}
