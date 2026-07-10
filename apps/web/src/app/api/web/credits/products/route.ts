// GET /api/web/credits/products (설계 9.1) — 활성 충전 상품 목록(공개).
import type { ActionResult, CreditProductDto, CreditProductListDto } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const repositories = getServiceRepositories();
    const products = await repositories.creditsPayment.listActiveProducts();
    const data: CreditProductListDto = {
      products: products.map(
        (p): CreditProductDto => ({
          code: p.code,
          name: p.name,
          amountKrw: p.amountKrw,
          credits: p.credits,
          bonusCredits: p.bonusCredits,
          totalCredits: p.credits + p.bonusCredits,
        }),
      ),
    };
    return NextResponse.json<ActionResult<CreditProductListDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditProductListDto>(error, {
      code: "credit_products_failed",
      message: "충전 상품을 불러오지 못했습니다.",
    });
  }
}
