/** formal deep-primary repair experiment에만 쓰는 고정 통계/층화 계약. */
export const ACTIVE_DEEP_REPAIR_SERIES_ID = "deep-v20" as const;
export const DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE = 15;
export const DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE = 30;
export const DEEP_REPAIR_FORMAL_REQUIRED_STRATA = Object.freeze([
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
] as const);
