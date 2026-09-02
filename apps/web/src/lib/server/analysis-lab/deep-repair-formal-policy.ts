/** formal deep-primary repair experiment에만 쓰는 고정 통계/층화 계약. */
export const ACTIVE_DEEP_REPAIR_SERIES_ID = "deep-v31" as const;
export const ACTIVE_DEEP_REPAIR_STRATA_VERSION = "deep-repair-strata-v3" as const;
export const DEEP_REPAIR_PLANNING_PRIMARY_SEED = 20260907;
export const DEEP_REPAIR_PLANNING_SUPPLEMENTAL_SEED = 20260908;
export const DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE = 15;
/** deep-v30까지의 불변 formal plan 크기. 역사 plan 재검증을 위해 유지한다. */
export const DEEP_REPAIR_FORMAL_LEGACY_TARGET_COUNT = 30;
/** 현재 런칭 series가 한 manifest에 봉인하는 목표 공고 수. */
export const ACTIVE_DEEP_REPAIR_TARGET_COUNT = 50;
/** evaluator와 manifest parser가 허용하는 현재 최대 표본 수. */
export const DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE = ACTIVE_DEEP_REPAIR_TARGET_COUNT;
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

/**
 * formal plan의 target 수는 series 계약에 포함된다. deep-v30 이전 30건 plan을 계속
 * 재검증하면서 현재 deep-v31만 50건으로 확장한다.
 */
export function deepRepairTargetCountForSeries(seriesId: string): number {
  return seriesId === ACTIVE_DEEP_REPAIR_SERIES_ID
    ? ACTIVE_DEEP_REPAIR_TARGET_COUNT
    : DEEP_REPAIR_FORMAL_LEGACY_TARGET_COUNT;
}
