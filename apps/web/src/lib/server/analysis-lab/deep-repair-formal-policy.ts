/** formal deep-primary repair experiment에만 쓰는 고정 통계/층화 계약. */
export const ACTIVE_DEEP_REPAIR_SERIES_ID = "deep-v21" as const;
export const ACTIVE_DEEP_REPAIR_STRATA_VERSION = "deep-repair-strata-v2" as const;
export const DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE = 15;
export const DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE = 30;
export const DEEP_REPAIR_FORMAL_SUPPORTED_STRATA = Object.freeze([
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
] as const);

/**
 * v2는 이미 실행한 비중복 표본에서 kstartup/thick 현행 재고가 소진된 상태를
 * 반영한다. 새 재고가 생기면 계획에 포함할 수 있지만 신규 실행의 필수 층으로는
 * 강제하지 않는다. v1 계획의 6층 의미는 아래 함수에서 그대로 보존한다.
 */
export const DEEP_REPAIR_FORMAL_REQUIRED_STRATA = Object.freeze([
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/medium",
  "kstartup/thin",
] as const);

export type DeepRepairStrataVersion =
  | "deep-repair-strata-v1"
  | typeof ACTIVE_DEEP_REPAIR_STRATA_VERSION;

export function deepRepairRequiredStrataForVersion(
  version: DeepRepairStrataVersion,
): readonly string[] {
  return version === "deep-repair-strata-v1"
    ? DEEP_REPAIR_FORMAL_SUPPORTED_STRATA
    : DEEP_REPAIR_FORMAL_REQUIRED_STRATA;
}
