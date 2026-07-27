import type { DeepAnalysisQualityPreflightReceipt } from "./qualityPreflight";

export const DEEP_ANALYSIS_QUALITY_INPUT_RECOVERY_CONFIRMATION =
  "RECOVER_DEEP_ANALYSIS_QUALITY_INPUTS" as const;

type PreflightItem = DeepAnalysisQualityPreflightReceipt["items"][number];

/**
 * 원문 identity가 유지된 채 production input만 미봉인인 frozen item만 복구 대상으로 연다.
 * 품질 실행 가능 여부나 다른 hard blocker를 이 경로에서 우회하지 않는다.
 */
export function selectDeepAnalysisQualityInputRecoveryItems(
  receipt: Pick<DeepAnalysisQualityPreflightReceipt, "items">,
): PreflightItem[] {
  return receipt.items.filter((item) => {
    if (item.readyForExecution) return false;
    if (!item.sourceContentMatched) {
      throw new Error("Quality input recovery refuses frozen source content drift.");
    }
    if (
      item.blockerCodes.length !== 1
      || item.blockerCodes[0] !== "production_input_not_sealed"
      || item.currentInputSealed
      || item.productionBlockerCodes.length === 0
      || item.productionBlockerCodes.some(
        (code) => code !== "blocked_fetch" && code !== "blocked_conversion",
      )
    ) {
      throw new Error("Quality input recovery found an unsupported preflight blocker.");
    }
    return true;
  });
}

export function selectDeepAnalysisQualityInputRecoveryRound<
  T extends { source: "kstartup" | "bizinfo" },
>(
  items: readonly T[],
  maxPerSource: number,
): T[] {
  if (!Number.isInteger(maxPerSource) || maxPerSource < 1) {
    throw new Error("Quality input recovery round limit must be positive.");
  }
  return (["kstartup", "bizinfo"] as const).flatMap((source) =>
    items.filter((item) => item.source === source).slice(0, maxPerSource));
}
