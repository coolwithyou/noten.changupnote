/** formal deep-primary repair experiment에만 쓰는 고정 통계/층화 계약. */
export const ACTIVE_DEEP_REPAIR_SERIES_ID = "deep-v29" as const;
export const ACTIVE_DEEP_REPAIR_STRATA_VERSION = "deep-repair-strata-v3" as const;
export const DEEP_REPAIR_PLANNING_PRIMARY_SEED = 20260903;
export const DEEP_REPAIR_PLANNING_SUPPLEMENTAL_SEED = 20260904;
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

/** v2는 kstartup/thick 재고 소진 뒤 나머지 5층을 필수로 유지한 역사 계약이다. */
export const DEEP_REPAIR_FORMAL_REQUIRED_STRATA_V2 = Object.freeze([
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/medium",
  "kstartup/thin",
] as const);

/**
 * v3는 전체 과거 이력을 제외한 deep-v23 이후 모집단에서 bizinfo/thick과 kstartup/thick이
 * 모두 소진된 상태를 반영한다. 두 층은 새 비중복 재고가 생기면 선택할 수 있지만
 * 첫 15건의 필수 커버리지에는 포함하지 않는다. v1/v2의 역사 의미는 아래 함수에서 보존한다.
 */
export const DEEP_REPAIR_FORMAL_REQUIRED_STRATA = Object.freeze([
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/medium",
  "kstartup/thin",
] as const);

export type DeepRepairStrataVersion =
  | "deep-repair-strata-v1"
  | "deep-repair-strata-v2"
  | typeof ACTIVE_DEEP_REPAIR_STRATA_VERSION;

export function deepRepairRequiredStrataForVersion(
  version: DeepRepairStrataVersion,
): readonly string[] {
  if (version === "deep-repair-strata-v1") return DEEP_REPAIR_FORMAL_SUPPORTED_STRATA;
  if (version === "deep-repair-strata-v2") return DEEP_REPAIR_FORMAL_REQUIRED_STRATA_V2;
  return DEEP_REPAIR_FORMAL_REQUIRED_STRATA;
}
