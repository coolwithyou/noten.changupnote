import type { GrantCriterion } from "@cunote/contracts";

const INDUSTRY_VALUE_KEYS = ["tags", "industries", "labels", "codes", "ksic_codes", "kics_codes"] as const;

/**
 * 공고가 지원하는 긍정 업종만 파생한다. 배제업종과 원문 확인 조건은 eligibility 전용이며
 * 관련성·f_industries projection에 섞지 않는다.
 */
export function projectGrantIndustryTags(criteria: GrantCriterion[]): string[] {
  return uniqueStrings(criteria
    .filter((criterion) =>
      criterion.dimension === "industry" &&
      criterion.kind !== "exclusion" &&
      criterion.operator !== "text_only")
    .flatMap((criterion) => listValueAliases(criterion.value, INDUSTRY_VALUE_KEYS)));
}

/** 기존 source-derived 값은 보존하고 criterion에서 복구한 값만 추가한다. */
export function mergeGrantIndustryTags(existing: string[], projected: string[]): string[] {
  return uniqueStrings([...existing, ...projected]);
}

function listValueAliases(value: unknown, keys: readonly string[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return keys.flatMap((key) => Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string")
    : []);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}
