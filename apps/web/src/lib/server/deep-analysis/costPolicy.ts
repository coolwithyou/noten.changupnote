import type {
  DeepAnalysisAdjudicationModel,
  DeepAnalysisAuditModel,
  DeepAnalysisPrimaryModel,
  DeepAnalysisUsage,
} from "@cunote/contracts";

export const DEEP_ANALYSIS_COST_POLICY_VERSION =
  "deep-analysis-cost-policy-v2" as const;

// Adjudication은 sealed source와 primary/audit의 최종 구조화 결과만 비교한다. 사전
// gate에서는 primary 실측 usage를 기준으로 양쪽 결과 입력분을 더하되, 이 보조 호출이
// 예약 전체를 무한히 키우지 않도록 input 50k/output 8k tokens로 제한한다. 실제 비용은
// 호출 후 별도로 fail-closed 합산한다.
export const DEEP_ANALYSIS_ADJUDICATION_INPUT_RESERVE_TOKENS = 50_000;
export const DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS = 8_000;

const SONNET_5_STANDARD_PRICING_START_MS = Date.parse("2026-09-01T00:00:00.000Z");

type DeepAnalysisPricedModel =
  | DeepAnalysisPrimaryModel
  | DeepAnalysisAuditModel
  | DeepAnalysisAdjudicationModel;
type FixedPriceModel = Exclude<DeepAnalysisPricedModel, "claude-sonnet-5">;

interface ModelPricePerMillionTokens {
  input: number;
  output: number;
  cacheRead: number;
}

const FIXED_MODEL_PRICES: Record<FixedPriceModel, ModelPricePerMillionTokens> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
};

const SONNET_5_INTRO_PRICE: ModelPricePerMillionTokens = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
};
const SONNET_5_STANDARD_PRICE: ModelPricePerMillionTokens = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
};

export interface DeepAnalysisPreAuditCostReservation {
  costPolicyVersion: typeof DEEP_ANALYSIS_COST_POLICY_VERSION;
  pricedAt: string;
  primaryCostUsd: number;
  auditExecutionReserveUsd: number;
  adjudicationReserveUsd: number;
  adjudicationModel: DeepAnalysisAdjudicationModel;
  projectedTotalCostUsd: number;
  adjudicationInputReserveTokens: number;
  adjudicationOutputReserveTokens: number;
}

/**
 * Claude first-party global Messages API의 모델별 token 비용을 계산한다.
 * 알 수 없는 모델·usage·가격 시점은 Opus 가격으로 추정하지 않고 null로 닫는다.
 */
export function priceDeepAnalysisUsage(input: {
  model: string;
  usage: Pick<DeepAnalysisUsage, "inputTokens" | "outputTokens">
    & Partial<Pick<DeepAnalysisUsage, "cacheReadTokens">>;
  pricedAt?: Date;
}): number | null {
  const price = resolveModelPrice(input.model, input.pricedAt ?? new Date());
  if (!price || !isValidUsage(input.usage)) return null;
  return (
    input.usage.inputTokens * price.input
    + input.usage.outputTokens * price.output
    + (input.usage.cacheReadTokens ?? 0) * price.cacheRead
  ) / 1_000_000;
}

/**
 * primary 실제 usage를 audit 모델 단가로 다시 가격화한다. audit 결과가 달라지거나 repair가
 * 필요한 경우의 초과분은 호출 후 실제 총비용 gate가 차단한다.
 */
export function reserveDeepAnalysisPreAuditCost(input: {
  primaryModel: DeepAnalysisPrimaryModel;
  auditModel: DeepAnalysisAuditModel;
  adjudicationModel: DeepAnalysisAdjudicationModel;
  primaryUsage: DeepAnalysisUsage | null;
  pricedAt?: Date;
}): DeepAnalysisPreAuditCostReservation | null {
  if (!input.primaryUsage) return null;
  const pricedAt = input.pricedAt ?? new Date();
  const primaryCostUsd = priceDeepAnalysisUsage({
    model: input.primaryModel,
    usage: input.primaryUsage,
    pricedAt,
  });
  const auditExecutionReserveUsd = priceDeepAnalysisUsage({
    model: input.auditModel,
    // 모델이 바뀌면 primary cache hit를 audit에서 재사용할 수 없으므로 base input으로
    // 보수 예약한다. 현재 deep-analysis 요청은 cache_control을 보내지 않는다.
    usage: {
      inputTokens:
        input.primaryUsage.inputTokens + (input.primaryUsage.cacheReadTokens ?? 0),
      outputTokens: input.primaryUsage.outputTokens,
      cacheReadTokens: 0,
    },
    pricedAt,
  });
  const adjudicationInputReserveTokens = Math.min(
    input.primaryUsage.inputTokens + input.primaryUsage.outputTokens * 2,
    DEEP_ANALYSIS_ADJUDICATION_INPUT_RESERVE_TOKENS,
  );
  const adjudicationReserveUsd = priceDeepAnalysisUsage({
    model: input.adjudicationModel,
    usage: {
      inputTokens: adjudicationInputReserveTokens,
      outputTokens: DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
      cacheReadTokens: 0,
    },
    pricedAt,
  });
  if (
    primaryCostUsd === null
    || auditExecutionReserveUsd === null
    || adjudicationReserveUsd === null
  ) {
    return null;
  }
  return {
    costPolicyVersion: DEEP_ANALYSIS_COST_POLICY_VERSION,
    pricedAt: pricedAt.toISOString(),
    primaryCostUsd,
    auditExecutionReserveUsd,
    adjudicationReserveUsd,
    adjudicationModel: input.adjudicationModel,
    projectedTotalCostUsd:
      primaryCostUsd + auditExecutionReserveUsd + adjudicationReserveUsd,
    adjudicationInputReserveTokens,
    adjudicationOutputReserveTokens: DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
  };
}

/** 실제 호출 하나라도 비용이 없거나 유효하지 않으면 합계를 만들지 않는다. */
export function sumDeepAnalysisActualCosts(
  costs: readonly (number | null)[],
): number | null {
  if (costs.some((cost) => cost === null || !Number.isFinite(cost) || cost < 0)) {
    return null;
  }
  return (costs as number[]).reduce((sum, cost) => sum + cost, 0);
}

function resolveModelPrice(
  model: string,
  pricedAt: Date,
): ModelPricePerMillionTokens | null {
  const pricedAtMs = pricedAt.getTime();
  if (!Number.isFinite(pricedAtMs)) return null;
  if (model === "claude-sonnet-5") {
    return pricedAtMs < SONNET_5_STANDARD_PRICING_START_MS
      ? SONNET_5_INTRO_PRICE
      : SONNET_5_STANDARD_PRICE;
  }
  return FIXED_MODEL_PRICES[model as FixedPriceModel] ?? null;
}

function isValidUsage(
  usage: Pick<DeepAnalysisUsage, "inputTokens" | "outputTokens">
    & Partial<Pick<DeepAnalysisUsage, "cacheReadTokens">>,
): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens ?? 0,
  ].every((tokens) => Number.isInteger(tokens) && tokens >= 0);
}
