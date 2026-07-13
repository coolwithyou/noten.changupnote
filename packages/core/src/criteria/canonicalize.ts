import type {
  BizAgeCriterionValue,
  CriterionDimension,
  CriterionOperator,
  CriterionValue,
  FounderAgeCriterionValue,
  FounderAgeRange,
  GrantCriterion,
} from "@cunote/contracts";
import { expandRegionToken, isNationwideRegionToken } from "./regions.js";

/**
 * 저장 시점이 다른 공고 criterion을 evaluator가 소비하는 단일 value 계약으로 맞춘다.
 *
 * 이 함수는 의미를 새로 추론하지 않는다. 숫자/문자 코드, 동일 의미의 legacy key,
 * years→months처럼 손실 없는 변환만 수행한다. 시군구 label-only, 자유서술 임계,
 * 숫자 exclusion 방향처럼 원문 재해석이 필요한 값은 그대로 남겨 evaluator가 unknown으로 처리한다.
 */
export function canonicalizeGrantCriterion(criterion: GrantCriterion): GrantCriterion {
  const operator = criterion.kind === "exclusion" && criterion.operator === "not_in"
    ? "in"
    : criterion.operator;
  return {
    ...criterion,
    operator,
    value: canonicalizeCriterionValue(
      criterion.dimension,
      operator,
      criterion.value,
      criterion.kind,
    ),
  };
}

export function canonicalizeGrantCriteria(criteria: readonly GrantCriterion[]): GrantCriterion[] {
  return criteria.map(canonicalizeGrantCriterion);
}

export function canonicalizeCriterionValue(
  dimension: CriterionDimension,
  operator: CriterionOperator,
  input: CriterionValue,
  kind: GrantCriterion["kind"] = "required",
): CriterionValue {
  const value = recordValue(input);
  switch (dimension) {
    case "region":
      return canonicalRegion(value);
    case "biz_age":
      return canonicalBizAge(value, operator);
    case "founder_age":
      return canonicalFounderAge(value, operator);
    case "industry":
      return canonicalList(value, "tags", ["tags", "industries", "labels"], {
        codes: stringValues(value.codes, value.ksic_codes, value.kics_codes).map((item) => item.toUpperCase()),
      });
    case "size":
      return canonicalList(value, "sizes", ["sizes", "labels", "size"], {
        transform: canonicalSize,
      });
    case "founder_trait":
      return canonicalList(value, "traits", ["traits", "labels"]);
    case "certification":
      return canonicalList(value, "certs", ["certs", "certifications", "labels"]);
    case "ip":
      return canonicalList(value, "types", ["types", "ip", "labels"]);
    case "target_type":
      return canonicalList(value, "targets", ["targets", "types", "labels"]);
    case "revenue":
      return canonicalNumeric(value, operator, kind, {
        minKey: "min_krw",
        maxKey: "max_krw",
        minAliases: ["min_krw", "min_revenue_krw", "minimum_krw"],
        maxAliases: ["max_krw", "max_revenue_krw", "maximum_krw"],
        scalarAliases: ["amount_krw", "revenue_krw"],
      });
    case "employees":
      return canonicalNumeric(value, operator, kind, {
        minKey: "min",
        maxKey: "max",
        minAliases: ["min", "min_employees", "minimum"],
        maxAliases: ["max", "max_employees", "maximum"],
        scalarAliases: ["count", "employees_count"],
      });
    default:
      return value;
  }
}

function canonicalRegion(value: Record<string, unknown>): CriterionValue {
  const tokens = scalarValues(value.regions, value.codes)
    .flatMap((item) => typeof item === "string" || typeof item === "number" ? [String(item).trim()] : [])
    .filter(Boolean);
  const labels = stringValues(value.labels);

  let nationwide = value.nationwide === true;
  const codes: string[] = [];
  const unresolved: string[] = [];
  for (const token of tokens) {
    if (isNationwideRegionToken(token)) {
      nationwide = true;
      continue;
    }
    const expanded = expandRegionToken(token);
    if (expanded) codes.push(...expanded);
    else unresolved.push(token);
  }

  // 시도 코드로 환원 불가한 토큰('전남광주', '37' 같은 비표준 코드)이 하나라도 있으면
  // 코드 목록 전체를 신뢰하지 않는다. 잔여 코드만으로 required를 판정하면 미해석 지역의
  // 회사가 확정 탈락(false negative)하므로, regions를 비워 evaluator가 unknown으로
  // 보존하게 하고 원문 토큰은 labels에 남긴다.
  const regions = unresolved.length > 0 ? [] : unique(codes);
  const mergedLabels = unique([...labels, ...unresolved]);
  return compact({
    regions,
    ...(mergedLabels.length > 0 ? { labels: mergedLabels } : {}),
    ...(nationwide
      ? { nationwide: true }
      : typeof value.nationwide === "boolean" ? { nationwide: value.nationwide } : {}),
    ...(stringValue(value.region_group) ? { region_group: stringValue(value.region_group) } : {}),
  });
}

function canonicalBizAge(
  value: Record<string, unknown>,
  operator: CriterionOperator,
): BizAgeCriterionValue {
  let minMonths = finiteNumber(value.min_months);
  let maxMonths = finiteNumber(value.max_months);
  const unit = stringValue(value.unit)?.toLowerCase();
  const multiplier = unit === "year" || unit === "years" || unit === "년" ? 12 : 1;
  const legacyMin = finiteNumber(value.min);
  const legacyMax = finiteNumber(value.max);
  if (minMonths === null && legacyMin !== null) minMonths = legacyMin * multiplier;
  if (maxMonths === null && legacyMax !== null) maxMonths = legacyMax * multiplier;

  const years = finiteNumber(value.years);
  if (years !== null) {
    if (operator === "gte" && minMonths === null) minMonths = years * 12;
    if (operator === "lte" && maxMonths === null) maxMonths = years * 12;
  }

  const labels = stringValues(value.labels);
  const stages = stringValues(value.stages);
  const includePreliminary = typeof value.include_preliminary === "boolean"
    ? value.include_preliminary
    : [...labels, ...stages].some((item) => /예비/.test(item));
  return compact({
    ...(minMonths !== null ? { min_months: nonNegative(minMonths) } : {}),
    ...(maxMonths !== null ? { max_months: nonNegative(maxMonths) } : {}),
    ...(includePreliminary ? { include_preliminary: true } : {}),
    ...(stringValue(value.basis) ? { basis: stringValue(value.basis) } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  }) as BizAgeCriterionValue;
}

function canonicalFounderAge(
  value: Record<string, unknown>,
  operator: CriterionOperator,
): FounderAgeCriterionValue {
  const ranges = Array.isArray(value.ranges)
    ? value.ranges.flatMap(canonicalFounderAgeRange)
    : [];
  if (ranges.length === 0) {
    let min = finiteNumber(value.min);
    let max = finiteNumber(value.max);
    const age = finiteNumber(value.age);
    if (age !== null) {
      if (operator === "gte") min = age;
      if (operator === "lte") max = age;
      if (operator === "between" && min === null && max === null) {
        min = age;
        max = age;
      }
    }
    if (min !== null || max !== null) {
      ranges.push({
        ...(min !== null ? { min } : {}),
        ...(max !== null ? { max } : {}),
        label: stringValue(value.label) ?? boundsLabel(min, max),
      });
    }
  }
  const labels = unique([
    ...stringValues(value.labels),
    ...ranges.map((range) => range.label).filter(Boolean),
  ]);
  return {
    ranges,
    labels,
    ...(typeof value.youth_only === "boolean" ? { youth_only: value.youth_only } : {}),
  };
}

function canonicalFounderAgeRange(value: unknown): FounderAgeRange[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const min = finiteNumber(row.min);
  const max = finiteNumber(row.max);
  if (min === null && max === null) return [];
  return [{
    ...(min !== null ? { min } : {}),
    ...(max !== null ? { max } : {}),
    label: stringValue(row.label) ?? boundsLabel(min, max),
  }];
}

function canonicalList(
  value: Record<string, unknown>,
  canonicalKey: string,
  aliases: string[],
  options: {
    transform?: (value: string) => string | null;
    codes?: string[];
  } = {},
): CriterionValue {
  const transform = options.transform ?? ((item: string) => item);
  const entries = unique(aliases
    .flatMap((key) => stringValues(value[key]))
    .flatMap((item) => {
      const normalized = transform(item);
      return normalized ? [normalized] : [];
    }));
  return compact({
    [canonicalKey]: entries,
    ...(options.codes && options.codes.length > 0 ? { codes: unique(options.codes) } : {}),
  });
}

function canonicalNumeric(
  value: Record<string, unknown>,
  operator: CriterionOperator,
  kind: GrantCriterion["kind"],
  options: {
    minKey: string;
    maxKey: string;
    minAliases: string[];
    maxAliases: string[];
    scalarAliases: string[];
  },
): CriterionValue {
  let min = firstNumber(value, options.minAliases);
  let max = firstNumber(value, options.maxAliases);
  const scalar = firstNumber(value, options.scalarAliases);
  // legacy exclusion의 단일 scalar는 operator가 "허용 상한"인지 "제외 predicate"인지
  // 저장본마다 달랐다. 원문을 재해석해 탈락시키지 않고 canonical threshold가 있을 때만 평가한다.
  if (scalar !== null && kind !== "exclusion") {
    if (operator === "gte" && min === null) min = scalar;
    if (operator === "lte" && max === null) max = scalar;
  }
  return compact({
    ...(min !== null ? { [options.minKey]: min } : {}),
    ...(max !== null ? { [options.maxKey]: max } : {}),
  });
}

function canonicalSize(value: string): string | null {
  const normalized = value.replace(/\s+/g, "");
  if (normalized === "중소" || normalized === "소중기업") return "중소기업";
  if (normalized === "소상공") return "소상공인";
  if (["예비", "소상공인", "소기업", "중소기업", "중견기업", "대기업"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const result = finiteNumber(value[key]);
    if (result !== null) return result;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: number): number {
  return Math.max(0, value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function stringValues(...values: unknown[]): string[] {
  return unique(values.flatMap(scalarValues).flatMap((item) => {
    const normalized = stringValue(item);
    return normalized ? [normalized] : [];
  }));
}

function scalarValues(...values: unknown[]): unknown[] {
  return values.flatMap((value) => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
}

function recordValue(value: CriterionValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundsLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${min}~${max}세`;
  if (min !== null) return `${min}세 이상`;
  if (max !== null) return `${max}세 이하`;
  return "연령 확인";
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
