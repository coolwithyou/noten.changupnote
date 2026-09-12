export interface ExclusiveBizAgeUpperBound {
  years: number;
  expectedMaxMonths: number;
  observedMaxMonths: number;
}

const DURATION_PATTERN = /\d+(?:\.\d+)?\s*(?:년|개월|월)\s*(?:이상|이하|초과|미만|이내|경과)?/gu;
const COMPOUND_OR_EXCEPTION_PATTERN = /(?:또는|혹은|이거나|거나\s|단[,，:]|다만|예외)/u;
const EXCLUSIVE_BIZ_AGE_PATTERN =
  /(?:업력(?:\s*조건)?|창업(?:기업|\s*후)?|설립(?:\s*후)?|개업(?:\s*후)?)\s*(?:은|이|가)?\s*[:：]?\s*(\d{1,2})(?![.\d])\s*년\s*미만/u;

/**
 * matcher가 정수 개월을 inclusive 상한으로 소비하므로, 검증된 단일 `N년 미만`
 * 업력 문장의 구조 상한은 `N * 12 - 1`이어야 한다. `이내`·`이하`, 소수 연수,
 * 복합 기간 문장은 이 좁은 결정 규칙에서 제외한다.
 */
export function resolveExclusiveBizAgeUpperBound(input: {
  dimension: string;
  operator: string;
  sourceSpan: string | null;
  spanVerified: boolean;
  maxMonths: unknown;
}): ExclusiveBizAgeUpperBound | null {
  if (
    input.dimension !== "biz_age"
    || input.operator !== "lte"
    || !input.spanVerified
    || !input.sourceSpan
    || typeof input.maxMonths !== "number"
    || !Number.isSafeInteger(input.maxMonths)
  ) return null;
  const normalized = input.sourceSpan.normalize("NFKC");
  if (
    [...normalized.matchAll(DURATION_PATTERN)].length !== 1
    || COMPOUND_OR_EXCEPTION_PATTERN.test(normalized)
  ) return null;
  const match = EXCLUSIVE_BIZ_AGE_PATTERN.exec(normalized);
  if (!match?.[1]) return null;
  const years = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(years) || years <= 0) return null;
  return {
    years,
    expectedMaxMonths: years * 12 - 1,
    observedMaxMonths: input.maxMonths,
  };
}
