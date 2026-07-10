/**
 * withCreditMetering — LLM 호출 래퍼 (구현, P2).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md 6.2 / 6.3 / 13.1.
 *
 * 세 갈래 경로:
 *   1. feature_free 룰    → usage_events(free) 기록 + run(). hold 없음. (팝빌·의도된 무과금)
 *   2. 운영 배치(userId=null, 지갑 없음) → recordOpsUsageEvent(무과금·원가수집). hold 없음.
 *   3. 과금 경로          → createPendingUsageEvent → acquireHold → run → (d-2 선기록) → captureHold.
 *      실패 시 releaseHold + markUsageEventFailed.
 *
 * ★ estimate.maxOutputTokens 는 run 콜백의 maxTokens 로 주입돼 실제 LLM max_tokens 에 바인딩된다(레드팀 M8).
 *   과소 estimate 가 hold 를 뚫고 다른 hold 예약분을 잠식하는 것을 구조적으로 막는다.
 */

import { PricingRuleMissingError } from "./errors.js";
import type { CreditRepository, CreditSystemRepository } from "./ports.js";
import { creditsFor, resolvePricingRule, type PricingRule, type TokenUsage } from "./pricing.js";

export interface MeteringContext {
  /** 운영 배치는 null. */
  userId: string | null;
  companyId: string | null;
  /** 3.2 featureCode 사전. */
  featureCode: string;
  model: string;
  /** hold 산정용. maxOutputTokens 는 실제 LLM max_tokens 에 바인딩(6.2 M8). */
  estimate: { inputTokens: number; maxOutputTokens: number };
  requestId: string;
  contextRef?: Record<string, unknown>;
  /** 미터링 provider 라벨(usage_events.provider). 기본 "anthropic". */
  provider?: string;
}

export interface MeteredUsageEvent {
  id: string;
  featureCode: string;
  status: "pending" | "settled" | "failed" | "free";
  creditsCharged: number;
}

/** run 콜백이 받는 리포터·주입값. maxTokens 는 estimate.maxOutputTokens 와 결속(6.2 M8). */
export interface MeteringRunArgs {
  report: (usage: TokenUsage) => void;
  maxTokens: number;
}

export type MeteringRun<T> = (args: MeteringRunArgs) => Promise<T>;

export interface MeteringDeps {
  credits: CreditRepository;
  creditsSystem: CreditSystemRepository;
  now?: () => Date;
}

export type WithCreditMetering = <T>(
  ctx: MeteringContext,
  run: MeteringRun<T>,
) => Promise<{ result: T; usageEvent: MeteredUsageEvent }>;

/**
 * 6.2 흐름을 오케스트레이션한다. 원가 계산(provider USD micros)은 호출측이 report 로 넘기지 않는다면
 * null 로 둔다 — usage_events 에는 토큰만 남고 원가는 후속 대사에서 요율로 역산 가능.
 */
export async function withCreditMetering<T>(
  deps: MeteringDeps,
  ctx: MeteringContext,
  run: MeteringRun<T>,
): Promise<{ result: T; usageEvent: MeteredUsageEvent }> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const provider = ctx.provider ?? "anthropic";
  const maxTokens = ctx.estimate.maxOutputTokens;

  // 1. 요율 resolve. 없으면 PricingRuleMissingError — 호출 자체 거부(6.3 "요율 없으면 불가").
  const rules = await deps.creditsSystem.listEffectivePricingRules(at);
  const rule = resolvePricingRule(rules, ctx.featureCode, ctx.model, at);

  // 2. feature_free 경로: 지갑 유무와 무관하게 무과금. hold 없음.
  if (rule.ruleType === "feature_free") {
    let reported: TokenUsage | null = null;
    const report = (usage: TokenUsage) => {
      reported = usage;
    };
    const result = await run({ report, maxTokens });
    const usageEventId = await recordFreeOrOps(deps, ctx, provider, reported);
    return {
      result,
      usageEvent: { id: usageEventId, featureCode: ctx.featureCode, status: "free", creditsCharged: 0 },
    };
  }

  // 3. 운영 배치(지갑 없음) 경로: 무과금·원가수집. hold·capture 없음.
  //    userId=null 이면 지갑이 없다 — feature_free 가 아니어도 과금 대상이 아니다(ops_batch_*).
  if (ctx.userId === null) {
    let reported: TokenUsage | null = null;
    const report = (usage: TokenUsage) => {
      reported = usage;
    };
    const result = await run({ report, maxTokens });
    const { id } = await deps.creditsSystem.recordOpsUsageEvent({
      featureCode: ctx.featureCode,
      provider,
      model: ctx.model,
      usage: reported,
      requestId: ctx.requestId,
      contextRef: ctx.contextRef ?? {},
    });
    return {
      result,
      usageEvent: { id, featureCode: ctx.featureCode, status: "free", creditsCharged: 0 },
    };
  }

  // 4. 과금 경로. 지갑 확보(6.6 안전망 — 지갑 없으면 보너스 지급 후 진행).
  const userId = ctx.userId;
  const wallet = await deps.credits.ensureWalletWithSignupBonus(userId);

  // 13.1 회사 스코프 보너스 소모 상한: 이 companyId 에서 signup_bonus lot 으로 소모된 누적이 상한 초과면
  //      보너스 lot 을 소진에서 제외한다(유료 lot 부터 소진하거나 402). acquire/capture 모두 동일 필터.
  let excludeBonusLots = false;
  if (ctx.companyId) {
    const cap = await deps.creditsSystem.readNumericSetting("company_bonus_consumption_cap", 3000);
    const consumed = await deps.credits.sumCompanyBonusConsumption(userId, ctx.companyId);
    excludeBonusLots = consumed >= cap;
  }

  const estimatedCredits = creditsForEstimate(ctx.estimate, rule);

  // (a) usage_events INSERT(pending)
  const { id: usageEventId } = await deps.credits.createPendingUsageEvent(userId, {
    walletId: wallet.id,
    companyId: ctx.companyId,
    featureCode: ctx.featureCode,
    provider,
    model: ctx.model,
    pricingRuleId: rule.id,
    requestId: ctx.requestId,
    contextRef: ctx.contextRef ?? {},
  });

  // (c) acquireHold — 402 여기서 발생(잔액 부족).
  const hold = await deps.credits.acquireHold(userId, {
    walletId: wallet.id,
    usageEventId,
    estimatedCredits,
    excludeBonusLots,
  });

  // (d) run() — report 로 실측 토큰 수신.
  let reported: TokenUsage | null = null;
  const report = (usage: TokenUsage) => {
    reported = usage;
  };
  let result: T;
  try {
    result = await run({ report, maxTokens });
  } catch (error) {
    // 실패: releaseHold(llm_error) + usage_events failed. rethrow.
    await deps.credits.releaseHold(userId, { holdId: hold.id, reason: "llm_error" }).catch(() => {});
    await deps.credits
      .markUsageEventFailed(userId, { usageEventId, errorCode: "llm_error" })
      .catch(() => {});
    throw error;
  }

  // (d-2) 토큰 선기록 — capture 전(프로세스 사망 대비, 레드팀 m2).
  const finalUsage: TokenUsage = reported ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  await deps.credits.recordUsageTokens(userId, { usageEventId, usage: finalUsage });

  // (e)(f) actualCredits 계산 후 captureHold(분개 발생, pricingSnapshot 저장).
  const actualCredits = creditsFor(finalUsage, rule);
  const capture = await deps.credits.captureHold(userId, {
    holdId: hold.id,
    actualCredits,
    pricingSnapshot: pricingSnapshotOf(rule),
    excludeBonusLots,
  });

  return {
    result,
    usageEvent: {
      id: usageEventId,
      featureCode: ctx.featureCode,
      status: "settled",
      creditsCharged: capture.creditsCharged,
    },
  };
}

/** feature_free 룰 경로: 지갑 있으면 user 미터링, 없으면 ops 미터링으로 기록. */
async function recordFreeOrOps(
  deps: MeteringDeps,
  ctx: MeteringContext,
  provider: string,
  usage: TokenUsage | null,
): Promise<string> {
  // feature_free 는 팝빌·의도된 무과금. 원가 수집을 위해 ops 이벤트로 기록(walletId 무관).
  const { id } = await deps.creditsSystem.recordOpsUsageEvent({
    featureCode: ctx.featureCode,
    provider,
    model: ctx.model,
    usage,
    requestId: ctx.requestId,
    contextRef: ctx.contextRef ?? {},
  });
  return id;
}

/** estimate(토큰 상한)를 요율로 환산(6.2 b). feature_flat 은 flatCredits 고정. */
function creditsForEstimate(
  estimate: { inputTokens: number; maxOutputTokens: number },
  rule: PricingRule,
): number {
  if (rule.ruleType === "feature_flat") return Math.max(0, rule.flatCredits ?? 0);
  return creditsFor(
    {
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.maxOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    rule,
  );
}

/** capture 분개에 저장할 요율 스냅샷(4.3 pricingSnapshot). */
function pricingSnapshotOf(rule: PricingRule): Record<string, unknown> {
  return {
    ruleId: rule.id,
    ruleType: rule.ruleType,
    featureCode: rule.featureCode,
    model: rule.model,
    inputMillicreditsPer1k: rule.inputMillicreditsPer1k,
    outputMillicreditsPer1k: rule.outputMillicreditsPer1k,
    cacheReadMillicreditsPer1k: rule.cacheReadMillicreditsPer1k,
    cacheWriteMillicreditsPer1k: rule.cacheWriteMillicreditsPer1k,
    flatCredits: rule.flatCredits,
    effectiveFrom: rule.effectiveFrom.toISOString(),
  };
}

export { PricingRuleMissingError };
