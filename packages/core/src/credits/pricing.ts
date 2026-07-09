/**
 * 요율(pricing) 해석과 크레딧 계산.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 5.5 요율 계산 공식 (creditsFor)
 *   - 6.3 요율 resolver 우선순위
 *   - 4.6 credit_pricing_rules 구조 / 요율 해석 순서
 *
 * 순수 함수만. DB 미의존 — 룰 목록은 호출측(리포지토리)이 조회해 넘긴다.
 */

import { PricingRuleMissingError } from "./errors.js";

export type PricingRuleType = "model_token" | "feature_flat" | "feature_free";

/** credit_pricing_rules 한 행의 도메인 표현(계산에 필요한 필드만). */
export interface PricingRule {
  id: string;
  ruleType: PricingRuleType;
  featureCode: string | null;
  model: string | null;
  /** millicredit 단위. 1 크레딧 = 1000 밀리크레딧 (0.3 표기 규칙). */
  inputMillicreditsPer1k: number | null;
  outputMillicreditsPer1k: number | null;
  cacheReadMillicreditsPer1k: number | null;
  cacheWriteMillicreditsPer1k: number | null;
  flatCredits: number | null;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

/** LLM 호출의 토큰 사용량(Anthropic usage 매핑). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 요율 계산 (5.5). 밀리크레딧으로 계산하고 크레딧 단위로 ceil 올림.
 *
 *   ceil( (in×inRate + out×outRate + cr×crRate + cw×cwRate) / 1000 / 1000 )
 *
 * 첫 /1000 은 per-1k(요율이 1k 토큰당 밀리크레딧), 둘째 /1000 은 밀리크레딧→크레딧.
 * feature_flat 룰은 flatCredits 고정(estimate 무시).
 */
export function creditsFor(usage: TokenUsage, rule: PricingRule): number {
  if (rule.ruleType === "feature_free") return 0;
  if (rule.ruleType === "feature_flat") {
    return Math.max(0, rule.flatCredits ?? 0);
  }
  const inRate = rule.inputMillicreditsPer1k ?? 0;
  const outRate = rule.outputMillicreditsPer1k ?? 0;
  const crRate = rule.cacheReadMillicreditsPer1k ?? 0;
  const cwRate = rule.cacheWriteMillicreditsPer1k ?? 0;
  const millicredits =
    usage.inputTokens * inRate +
    usage.outputTokens * outRate +
    usage.cacheReadTokens * crRate +
    usage.cacheWriteTokens * cwRate;
  // /1000 (per-1k) /1000 (milli→credit). ceil 로 호출당 올림(2.6).
  return Math.ceil(millicredits / 1000 / 1000);
}

/**
 * 요율 resolver (6.3). 우선순위:
 *   1. feature_free(featureCode 일치)      → 무과금
 *   2. feature_flat(featureCode 일치)       → flatCredits 고정
 *   3. model_token(model 정확 일치)         → 토큰 요율
 *   4. model_token(model IS NULL 기본값)    → 토큰 요율
 *   5. 없음                                 → PricingRuleMissingError ("없으면 불가")
 *
 * 유효기간 필터: effectiveFrom <= at < (effectiveUntil ?? +∞).
 * rules 는 후보 전체(활성/비활성 무관)를 넘겨도 되며, 여기서 유효기간을 거른다.
 */
export function resolvePricingRule(
  rules: readonly PricingRule[],
  featureCode: string,
  model: string | null,
  at: Date,
): PricingRule {
  const effective = rules.filter((r) => isEffective(r, at));

  const free = effective.find((r) => r.ruleType === "feature_free" && r.featureCode === featureCode);
  if (free) return free;

  const flat = effective.find((r) => r.ruleType === "feature_flat" && r.featureCode === featureCode);
  if (flat) return flat;

  if (model) {
    const exact = effective.find((r) => r.ruleType === "model_token" && r.model === model);
    if (exact) return exact;
  }

  const defaultRule = effective.find((r) => r.ruleType === "model_token" && r.model === null);
  if (defaultRule) return defaultRule;

  throw new PricingRuleMissingError({ featureCode, model });
}

function isEffective(rule: PricingRule, at: Date): boolean {
  if (rule.effectiveFrom.getTime() > at.getTime()) return false;
  if (rule.effectiveUntil && rule.effectiveUntil.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * ops 요율 산정 가이드 공식 (5.5) — millicredits_per_1k 계산기.
 * 11.3 화면에서 계산기로 제공. 여기서는 참조 구현.
 *   ceil( usd_per_1M / 1000 × fx_krw_usd × (1 + margin) / krw_per_credit × 1000 )
 */
export function millicreditsPer1kFromUsd(input: {
  usdPer1MTokens: number;
  fxKrwPerUsd: number;
  margin: number; // 1.0 = 마진 100%
  krwPerCredit: number; // 앵커 1
}): number {
  const { usdPer1MTokens, fxKrwPerUsd, margin, krwPerCredit } = input;
  return Math.ceil(
    (usdPer1MTokens / 1000) * fxKrwPerUsd * (1 + margin) / krwPerCredit * 1000,
  );
}
