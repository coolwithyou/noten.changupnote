/**
 * "남은 N회" 환산 헬퍼 — 크레딧 잔액(원 단위)을 도우미 사용 횟수로 투영한다.
 *
 * 환산 규칙: 1회 = application_draft(지원서 초안 생성) 1회의 예상 크레딧.
 *   - 요율은 credit_pricing_rules(resolvePricingRule)로, 대표 토큰 규모는
 *     GET /api/web/credits/estimate · subscriptionDto.EXAMPLE_SCENARIOS 와 동일한
 *     정본 값(input 20k / output 8k, claude-sonnet-5)을 쓴다.
 *   - remaining = floor(available / 1회 비용). subscriptionDto.computeExampleUsages 의
 *     approxCount 계산과 같은 규약(4.13: 원시 요율 미노출, 파생 횟수만 노출).
 *
 * 표시 계약: null 이면 pill/칩을 렌더하지 않는다(현재 외관 유지).
 *   - 비로그인·demo 세션 → null
 *   - 지갑 미생성(가입 보너스 lazy grant 이전) → null — "0회" 오표기 방지
 *   - 요율 미시드/무료 룰/조회 실패 → null — 잔량 조회가 페이지를 죽이지 않게 한다
 */
import { PricingRuleMissingError, creditsFor, resolvePricingRule } from "@cunote/core";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { getServiceRepositories } from "@/lib/server/serviceData";

/** 도우미 1회의 정본 featureCode(사용처: 지원서 초안 생성 과금). */
const ASSISTANT_FEATURE_CODE = "application_draft";
/** estimate 라우트 FEATURE_ESTIMATE_DEFAULTS 와 동일한 대표 모델·토큰 규모. */
const ASSISTANT_MODEL = "claude-sonnet-5";
const ASSISTANT_REFERENCE_USAGE = {
  inputTokens: 20_000,
  outputTokens: 8_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

/**
 * 현재 세션 사용자의 남은 도우미 횟수. 세션 조회부터 자체 수행하므로
 * 서버 컴포넌트에서 인자 없이 호출한다. 어떤 실패도 던지지 않고 null 로 수렴한다.
 */
export async function getRemainingAssistantUses(): Promise<number | null> {
  try {
    const session = await getOptionalWebSession();
    if (!session) return null;
    const userId = session.user.id;

    const repositories = getServiceRepositories();
    const wallet = await repositories.credits.getWalletForUser(userId);
    if (!wallet) return null;

    const now = new Date();
    const [pendingHolds, rules] = await Promise.all([
      repositories.credits.sumPendingHolds(userId, wallet.id),
      repositories.creditsSystem.listEffectivePricingRules(now),
    ]);

    const rule = resolvePricingRule(rules, ASSISTANT_FEATURE_CODE, ASSISTANT_MODEL, now);
    const perUseCredits = creditsFor(ASSISTANT_REFERENCE_USAGE, rule);
    if (perUseCredits <= 0) return null;

    const available = Math.max(0, wallet.balanceCredits - pendingHolds);
    return Math.floor(available / perUseCredits);
  } catch (error) {
    if (!(error instanceof PricingRuleMissingError)) {
      console.warn(
        `remaining assistant uses lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}
