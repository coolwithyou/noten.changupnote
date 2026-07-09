// GET /api/web/credits/estimate?feature&inputHint (설계 9.1 / 10.5 사전 견적)
// 작업 시작 버튼 옆 사전 견적용 — 402 를 사후에 만나기 전에 부족을 안다.
// ★ 요율 원시값은 노출하지 않는다(4.13). 계산 결과(estimatedCredits)만 반환.
import type { ActionResult, CreditEstimateDto } from "@cunote/contracts";
import { PricingRuleMissingError, creditsFor, resolvePricingRule } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 기능별 대표 토큰 규모(사전 견적용 기본값). inputHint 로 입력 토큰만 조정 가능.
// 5.5 예시(지원서 초안 input 20k + output 8k)를 초기값으로 둔다. 정밀 산정은 P5 이후.
const FEATURE_ESTIMATE_DEFAULTS: Record<string, { inputTokens: number; maxOutputTokens: number; model: string }> = {
  application_draft: { inputTokens: 20000, maxOutputTokens: 8000, model: "claude-sonnet-5" },
  application_review: { inputTokens: 12000, maxOutputTokens: 4000, model: "claude-sonnet-5" },
  business_plan_section: { inputTokens: 15000, maxOutputTokens: 6000, model: "claude-sonnet-5" },
  writing_guide_chat: { inputTokens: 4000, maxOutputTokens: 2000, model: "claude-sonnet-5" },
  expert_field_answer: { inputTokens: 8000, maxOutputTokens: 3000, model: "claude-sonnet-5" },
};

export async function GET(request: Request) {
  try {
    const session = await requireWebSession();
    const userId = session.user.id;
    const params = new URL(request.url).searchParams;
    const feature = params.get("feature")?.trim();
    if (!feature) {
      return NextResponse.json<ActionResult<CreditEstimateDto>>(
        { ok: false, error: { code: "invalid_request", message: "feature 파라미터가 필요합니다.", field: "feature" } },
        { status: 400 },
      );
    }
    const defaults = FEATURE_ESTIMATE_DEFAULTS[feature] ?? { inputTokens: 8000, maxOutputTokens: 4000, model: "claude-sonnet-5" };
    const inputHint = Number(params.get("inputHint"));
    const inputTokens = Number.isFinite(inputHint) && inputHint > 0 ? Math.trunc(inputHint) : defaults.inputTokens;

    const repositories = getServiceRepositories();
    const now = new Date();
    const rules = await repositories.creditsSystem.listEffectivePricingRules(now);

    let estimatedCredits: number;
    try {
      const rule = resolvePricingRule(rules, feature, defaults.model, now);
      estimatedCredits = rule.ruleType === "feature_flat"
        ? Math.max(0, rule.flatCredits ?? 0)
        : creditsFor(
            { inputTokens, outputTokens: defaults.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
            rule,
          );
    } catch (error) {
      if (error instanceof PricingRuleMissingError) {
        return NextResponse.json<ActionResult<CreditEstimateDto>>(
          { ok: false, error: { code: "pricing_unavailable", message: "적용 가능한 요율이 없습니다.", meta: { feature } } },
          { status: 503 },
        );
      }
      throw error;
    }

    const wallet = await repositories.credits.getWalletForUser(userId);
    const pendingHolds = wallet ? await repositories.credits.sumPendingHolds(userId, wallet.id) : 0;
    const available = wallet ? Math.max(0, wallet.balanceCredits - pendingHolds) : 0;

    const data: CreditEstimateDto = {
      estimatedCredits,
      available,
      sufficient: available >= estimatedCredits,
    };
    return NextResponse.json<ActionResult<CreditEstimateDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<CreditEstimateDto>(error, {
      code: "credit_estimate_failed",
      message: "예상 크레딧을 계산하지 못했습니다.",
    });
  }
}
