export type LabCostPolicy =
  | { kind: "subscription-telemetry-only" }
  | { kind: "api-settled-usd-stop"; maxUsd: number };

type ApiSettledUsdStopPolicy = Extract<LabCostPolicy, { kind: "api-settled-usd-stop" }>;

export function resolveLabCostPolicy(input: {
  transport: "api" | "claude-cli";
  apiMaxCostUsd?: number;
}): LabCostPolicy {
  if (input.transport === "claude-cli") {
    return { kind: "subscription-telemetry-only" };
  }
  if (
    typeof input.apiMaxCostUsd !== "number"
    || !Number.isFinite(input.apiMaxCostUsd)
    || input.apiMaxCostUsd <= 0
  ) {
    throw new Error("apiMaxCostUsd 는 0보다 큰 유한한 숫자여야 합니다.");
  }
  return { kind: "api-settled-usd-stop", maxUsd: input.apiMaxCostUsd };
}

/**
 * API도 현재는 완료된 작업의 비용을 합산한 뒤 다음 착수를 막는 soft stop이다.
 * 구독의 API 환산 USD는 관측값이므로 이 함수가 중단을 지시하지 않는다.
 */
export function shouldStopForSettledCost(
  policy: LabCostPolicy,
  totalUsd: number,
): policy is ApiSettledUsdStopPolicy {
  return policy.kind === "api-settled-usd-stop" && totalUsd >= policy.maxUsd;
}
