/**
 * 공개 전체-공고 마감 캘린더의 URL 쿼리 계약 — 서버·클라이언트 공용 순수 모듈.
 *
 * 서버 페이지(searchParams 파싱)와 클라이언트 뷰(router.push용 직렬화)가 같은 규칙을
 * 공유해 공유 URL이 항상 같은 정규형(정렬·dedupe)으로 안정되게 한다. React/DOM/서버
 * 의존이 없는 순수 함수만 둔다. "현재 월"은 인자로 주입받아(월 폴백/clamp) 순수성을 유지한다.
 */

import type { GrantSource } from "@cunote/contracts";
import { VALID_SIDO_CODES } from "@cunote/core";
import { parseMonthKey } from "@/lib/calendar/dates";

export type PublicCalendarStatus = "open" | "upcoming";

export interface PublicCalendarFilters {
  /** 시도 2자리 행정코드 목록(검증·dedupe·정렬됨). */
  regions: string[];
  /** categoryL1 자유 텍스트 목록(trim·dedupe·정렬됨). */
  categories: string[];
  sources: GrantSource[];
  statuses: PublicCalendarStatus[];
}

// 하한 월. 아카이브 롱테일 SEO를 위해 과거 월도 허용한다.
// TODO(5단계): grants.apply_end DB min 실측으로 조정한다.
export const CALENDAR_MIN_MONTH = "2024-01";
// 현재 월 기준 미래 허용 폭(개월). 이 범위 밖 month는 폴백/clamp된다.
export const CALENDAR_MAX_FUTURE_MONTHS = 12;

const GRANT_SOURCES: readonly GrantSource[] = ["kstartup", "bizinfo", "bizinfo_event"];
const CALENDAR_STATUSES: readonly PublicCalendarStatus[] = ["open", "upcoming"];

export type PublicCalendarSearchParams = Record<string, string | string[] | undefined>;

/**
 * Next.js searchParams → 정규화된 월 키 + 필터.
 * - month: parseMonthKey로 형식 검증 + [MIN, 현재+12개월] 범위 검증. 불량/범위 밖 → 현재 월.
 * - region: 콤마 구분, VALID_SIDO_CODES로 검증, 불량 drop·dedupe·정렬.
 * - category: 콤마 구분 자유 텍스트, trim·빈 값 drop·dedupe·정렬.
 * - source/status: enum 검증, dedupe·정렬.
 */
export function parsePublicCalendarSearchParams(
  searchParams: PublicCalendarSearchParams,
  currentMonthKey: string,
): { month: string; filters: PublicCalendarFilters } {
  const month = resolveMonthParam(firstValue(searchParams.month), currentMonthKey);
  const regions = uniqueSorted(
    splitTokens(firstValue(searchParams.region)).filter((token) => VALID_SIDO_CODES.has(token)),
  );
  const categories = uniqueSorted(splitTokens(firstValue(searchParams.category)));
  const sources = uniqueSorted(
    splitTokens(firstValue(searchParams.source)).filter(isGrantSource),
  ) as GrantSource[];
  const statuses = uniqueSorted(
    splitTokens(firstValue(searchParams.status)).filter(isCalendarStatus),
  ) as PublicCalendarStatus[];

  return { month, filters: { regions, categories, sources, statuses } };
}

/**
 * 월 키 + 필터를 정규형 쿼리 문자열로 직렬화한다(공유 URL 안정).
 * - 항상 같은 순서(month → region → category → source → status)·정렬로 방출.
 * - 필터는 방어적으로 재검증·dedupe·정렬한다(호출자가 정렬 안 된 값을 넘겨도 정규형 보장).
 * - 빈 필터 축은 생략. options.currentMonthKey와 month가 같으면 month도 생략(기본값 최소 URL).
 * 반환: 선행 "?" 없는 쿼리 문자열(아무것도 없으면 빈 문자열).
 */
export function serializePublicCalendarQuery(
  monthKey: string,
  filters: PublicCalendarFilters,
  options?: { currentMonthKey?: string },
): string {
  const params = new URLSearchParams();

  const currentMonthKey = options?.currentMonthKey;
  const omitMonth = currentMonthKey !== undefined && monthKey === currentMonthKey;
  if (!omitMonth && parseMonthKey(monthKey)) {
    params.set("month", monthKey);
  }

  const regions = uniqueSorted(filters.regions.filter((token) => VALID_SIDO_CODES.has(token)));
  const categories = uniqueSorted(filters.categories.map((token) => token.trim()).filter(Boolean));
  const sources = uniqueSorted(filters.sources.filter(isGrantSource));
  const statuses = uniqueSorted(filters.statuses.filter(isCalendarStatus));

  if (regions.length > 0) params.set("region", regions.join(","));
  if (categories.length > 0) params.set("category", categories.join(","));
  if (sources.length > 0) params.set("source", sources.join(","));
  if (statuses.length > 0) params.set("status", statuses.join(","));

  return params.toString();
}

/** 월 키를 [MIN, 현재+12개월] 범위로 clamp한다(월 이동 네비게이션용). 불량 입력은 현재 월로. */
export function clampCalendarMonth(monthKey: string, currentMonthKey: string): string {
  if (!parseMonthKey(monthKey)) return currentMonthKey;
  const max = addMonthsToKey(currentMonthKey, CALENDAR_MAX_FUTURE_MONTHS);
  if (monthKey < CALENDAR_MIN_MONTH) return CALENDAR_MIN_MONTH;
  if (max !== null && monthKey > max) return max;
  return monthKey;
}

function resolveMonthParam(raw: string | undefined, currentMonthKey: string): string {
  if (!raw) return currentMonthKey;
  if (!parseMonthKey(raw)) return currentMonthKey;
  return isMonthWithinRange(raw, currentMonthKey) ? raw : currentMonthKey;
}

function isMonthWithinRange(monthKey: string, currentMonthKey: string): boolean {
  if (monthKey < CALENDAR_MIN_MONTH) return false;
  const max = addMonthsToKey(currentMonthKey, CALENDAR_MAX_FUTURE_MONTHS);
  return max === null || monthKey <= max;
}

// "YYYY-MM" 키에 개월을 더한다. 형식 불량이면 null. 문자열이 항상 zero-pad라 사전식 비교가 성립한다.
function addMonthsToKey(monthKey: string, amount: number): string | null {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return null;
  const zeroBased = parsed.year * 12 + (parsed.month - 1) + amount;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function splitTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

// 사전식(UTF-16 코드유닛) 정렬 — ICU/로케일 비의존이라 환경 간 정규 URL이 결정적으로 재현된다.
function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isGrantSource(value: string): value is GrantSource {
  return (GRANT_SOURCES as readonly string[]).includes(value);
}

function isCalendarStatus(value: string): value is PublicCalendarStatus {
  return (CALENDAR_STATUSES as readonly string[]).includes(value);
}
