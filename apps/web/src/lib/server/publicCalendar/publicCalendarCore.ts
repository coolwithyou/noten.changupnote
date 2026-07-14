/**
 * 공개 전체-공고 마감 캘린더의 순수 도메인 로직 — DB 비의존.
 *
 * DB에서 읽은 얕은 grants 행(PublicCalendarRow)을 직렬화 가능한 DTO(PublicCalendarEvent)로
 * 투영하고, 읽기 시점 상태 파생·지역 버킷·필터·facet을 계산한다. f_* 자격 필드·confidence·
 * embedding·criteria는 노출하지 않는다(과노출 방지 — 발견 표면일 뿐 자격 판정이 아님).
 * asOf 민감값(dDay·파생 상태)은 캐시 밖에서 매 요청 todayKey로 다시 계산한다.
 */

import type { Grant, GrantSource, GrantStatus } from "@cunote/contracts";
import { REGION_CODES, REGION_LABELS, expandRegionToken } from "@cunote/core";
import { calendarDday, dateKey } from "@/lib/calendar/dates";
import {
  sourceLabel,
  statusLabel,
  supportAmountLabel,
} from "@/lib/server/archive/grantArchiveSearch";
import type { PublicCalendarFilters } from "@/lib/publicCalendar/query";

/** DB에서 select하는 원시 행. timestamp 컬럼은 Date로 온다. */
export interface PublicCalendarRow {
  id: string;
  source: GrantSource;
  sourceId: string;
  title: string;
  url: string | null;
  agencyOperator: string | null;
  agencyJurisdiction: string | null;
  agencyPrimary: string | null;
  categoryL1: string | null;
  applyStart: Date | null;
  applyEnd: Date | null;
  status: GrantStatus;
  fRegions: string[] | null;
  supportAmount: Grant["support_amount"];
}

export type PublicCalendarEventKind = "deadline" | "start";
/** 읽기 시점 파생 상태. 필터는 open/upcoming만 쓰고 closed는 과거 월 표시에만 쓴다. */
export type PublicCalendarEventStatus = "open" | "upcoming" | "closed";

/** 공개 DTO — 내부 상세 링크 없음, 원문(url)만 노출. */
export interface PublicCalendarEvent {
  /** `${grantId}:deadline` | `${grantId}:start` */
  id: string;
  grantId: string;
  kind: PublicCalendarEventKind;
  /** KST 기준 "YYYY-MM-DD". */
  date: string;
  /** deadline 이벤트만 D-day, start는 null. */
  dDay: number | null;
  title: string;
  source: GrantSource;
  sourceLabel: string;
  agency: string | null;
  categoryL1: string | null;
  /** "전국" 또는 시도 한글 라벨 목록. */
  regionLabels: string[];
  status: PublicCalendarEventStatus;
  supportAmountLabel: string | null;
  url: string | null;
}

export interface PublicCalendarFacetOption {
  value: string;
  label: string;
  count: number;
  selected: boolean;
}

export interface PublicCalendarFacets {
  regions: PublicCalendarFacetOption[];
  categories: PublicCalendarFacetOption[];
  sources: PublicCalendarFacetOption[];
  statuses: PublicCalendarFacetOption[];
}

// 지역 facet에서 "전국"을 나타내는 값. 시도 코드가 아니라 필터로는 선택되지 않는다(정보용 옵션).
const NATIONWIDE_FACET_VALUE = "nationwide";
const NATIONWIDE_LABEL = "전국";

/**
 * 읽기 시점 상태 파생. status 백필 잡이 없어 DB status는 stale하므로 날짜로 교정한다.
 * - applyEnd < 오늘 → closed (stale open 교정)
 * - applyStart > 오늘 → upcoming
 * - applyStart ≤ 오늘 ≤ applyEnd → open
 * - 날짜가 한쪽만 있거나 없어 확정 불가 → DB status 폴백(closed는 closed 유지).
 */
export function deriveCalendarStatus(
  row: Pick<PublicCalendarRow, "applyStart" | "applyEnd" | "status">,
  todayKey: string,
): PublicCalendarEventStatus {
  const startKey = dateKeyOrNull(row.applyStart);
  const endKey = dateKeyOrNull(row.applyEnd);

  if (endKey && endKey < todayKey) return "closed";
  if (startKey && startKey > todayKey) return "upcoming";
  if (startKey && endKey && startKey <= todayKey && todayKey <= endKey) return "open";

  return fallbackStatus(row.status);
}

/**
 * f_regions 토큰을 시도 코드 버킷으로 정규화한다.
 * - 토큰별 expandRegionToken(수도권 → 서울·인천·경기 3코드 확장).
 * - 유효 코드가 0개(빈 배열·전국/오염 토큰만)면 전국 취급(발견 표면이라 포용).
 */
export function normalizeRegionBuckets(
  fRegions: string[] | null,
): { codes: Set<string>; nationwide: boolean } {
  if (!fRegions || fRegions.length === 0) {
    return { codes: new Set<string>(), nationwide: true };
  }
  const codes = new Set<string>();
  for (const token of fRegions) {
    const expanded = expandRegionToken(token);
    if (!expanded) continue;
    for (const code of expanded) codes.add(code);
  }
  if (codes.size === 0) {
    return { codes: new Set<string>(), nationwide: true };
  }
  return { codes, nationwide: false };
}

/**
 * 행 목록 → 이벤트 DTO 목록.
 * - applyEnd 있으면 deadline 이벤트(dDay = calendarDday).
 * - applyStart 있으면 start 이벤트(dDay null).
 * - 정렬: date asc → title(ko-KR).
 */
export function buildPublicCalendarEvents(
  rows: PublicCalendarRow[],
  todayKey: string,
): PublicCalendarEvent[] {
  const events: PublicCalendarEvent[] = [];
  for (const row of rows) {
    const buckets = normalizeRegionBuckets(row.fRegions);
    const base = {
      grantId: row.id,
      title: row.title,
      source: row.source,
      sourceLabel: sourceLabel(row.source),
      agency: row.agencyOperator ?? row.agencyJurisdiction ?? row.agencyPrimary ?? null,
      categoryL1: row.categoryL1,
      regionLabels: regionLabelsFromBuckets(buckets),
      status: deriveCalendarStatus(row, todayKey),
      supportAmountLabel: supportAmountLabel(row.supportAmount),
      url: row.url,
    };

    if (row.applyEnd) {
      const date = dateKey(row.applyEnd.toISOString());
      events.push({
        ...base,
        id: `${row.id}:deadline`,
        kind: "deadline",
        date,
        dDay: calendarDday(date, todayKey),
      });
    }
    if (row.applyStart) {
      const date = dateKey(row.applyStart.toISOString());
      events.push({ ...base, id: `${row.id}:start`, kind: "start", date, dDay: null });
    }
  }
  return events.sort(compareEvents);
}

/**
 * 필터 적용. 미선택 축은 통과.
 * - 지역: nationwide || 선택 코드와 교집합.
 * - 분야: categoryL1 완전 일치.
 * - 소스: 정확 일치.
 * - 상태: 파생 status가 선택값에 포함(closed 이벤트는 open/upcoming 선택 시 제외).
 */
export function applyPublicCalendarFilters(
  events: PublicCalendarEvent[],
  filters: PublicCalendarFilters,
): PublicCalendarEvent[] {
  return events.filter(
    (event) =>
      matchesRegion(event, filters.regions) &&
      matchesCategory(event, filters.categories) &&
      matchesSource(event, filters.sources) &&
      matchesStatus(event, filters.statuses),
  );
}

/**
 * 각 축의 옵션 + count facet. count는 "해당 축을 제외한 나머지 필터를 적용한 집합" 기준이라
 * 자기 축 선택이 자기 옵션을 0으로 만들지 않는다(일반 facet 관례). 선택 옵션은 count 0이어도 포함.
 */
export function buildPublicCalendarFacets(
  events: PublicCalendarEvent[],
  filters: PublicCalendarFilters,
): PublicCalendarFacets {
  return {
    regions: buildRegionFacet(
      applyPublicCalendarFilters(events, { ...filters, regions: [] }),
      filters.regions,
    ),
    categories: buildCategoryFacet(
      applyPublicCalendarFilters(events, { ...filters, categories: [] }),
      filters.categories,
    ),
    sources: buildSourceFacet(
      applyPublicCalendarFilters(events, { ...filters, sources: [] }),
      filters.sources,
    ),
    statuses: buildStatusFacet(
      applyPublicCalendarFilters(events, { ...filters, statuses: [] }),
      filters.statuses,
    ),
  };
}

function buildRegionFacet(
  subset: PublicCalendarEvent[],
  selected: string[],
): PublicCalendarFacetOption[] {
  const projections = subset.map(regionProjection);
  const candidateCodes = new Set<string>(selected);
  let nationwideCount = 0;
  for (const projection of projections) {
    if (projection.nationwide) nationwideCount += 1;
    for (const code of projection.codes) candidateCodes.add(code);
  }

  const counts = new Map<string, number>();
  for (const code of candidateCodes) {
    // region=code로 추가 필터 시 남을 이벤트 수(전국 이벤트도 매칭되므로 포함).
    let count = 0;
    for (const projection of projections) {
      if (projection.nationwide || projection.codes.has(code)) count += 1;
    }
    counts.set(code, count);
  }
  if (nationwideCount > 0) counts.set(NATIONWIDE_FACET_VALUE, nationwideCount);

  return facetOptions(counts, new Set(selected), (value) =>
    value === NATIONWIDE_FACET_VALUE ? NATIONWIDE_LABEL : REGION_LABELS[value] ?? value,
  );
}

function buildCategoryFacet(
  subset: PublicCalendarEvent[],
  selected: string[],
): PublicCalendarFacetOption[] {
  const counts = new Map<string, number>();
  for (const event of subset) {
    if (event.categoryL1) increment(counts, event.categoryL1);
  }
  return facetOptions(counts, new Set(selected), (value) => value);
}

function buildSourceFacet(
  subset: PublicCalendarEvent[],
  selected: string[],
): PublicCalendarFacetOption[] {
  const counts = new Map<string, number>();
  for (const event of subset) increment(counts, event.source);
  return facetOptions(counts, new Set(selected), (value) => sourceLabel(value as GrantSource));
}

function buildStatusFacet(
  subset: PublicCalendarEvent[],
  selected: string[],
): PublicCalendarFacetOption[] {
  const counts = new Map<string, number>();
  for (const event of subset) {
    if (event.status === "open" || event.status === "upcoming") increment(counts, event.status);
  }
  return facetOptions(counts, new Set(selected), (value) => statusLabel(value as GrantStatus));
}

function facetOptions(
  counts: Map<string, number>,
  selected: Set<string>,
  labelFor: (value: string) => string,
): PublicCalendarFacetOption[] {
  const values = new Set<string>([...counts.keys(), ...selected]);
  return [...values]
    .map((value) => ({
      value,
      label: labelFor(value),
      count: counts.get(value) ?? 0,
      selected: selected.has(value),
    }))
    .sort(
      (a, b) =>
        Number(b.selected) - Number(a.selected) ||
        b.count - a.count ||
        a.label.localeCompare(b.label, "ko-KR"),
    );
}

function matchesRegion(event: PublicCalendarEvent, regions: string[]): boolean {
  if (regions.length === 0) return true;
  const { codes, nationwide } = regionProjection(event);
  if (nationwide) return true;
  return regions.some((code) => codes.has(code));
}

function matchesCategory(event: PublicCalendarEvent, categories: string[]): boolean {
  if (categories.length === 0) return true;
  return event.categoryL1 !== null && categories.includes(event.categoryL1);
}

function matchesSource(event: PublicCalendarEvent, sources: GrantSource[]): boolean {
  if (sources.length === 0) return true;
  return sources.includes(event.source);
}

function matchesStatus(event: PublicCalendarEvent, statuses: string[]): boolean {
  if (statuses.length === 0) return true;
  return statuses.includes(event.status);
}

// regionLabels(한글) → 시도 코드/전국 여부로 되돌린다. DTO에 코드를 노출하지 않고도 필터·facet이 가능하다.
function regionProjection(event: PublicCalendarEvent): { codes: Set<string>; nationwide: boolean } {
  const nationwide = event.regionLabels.includes(NATIONWIDE_LABEL);
  const codes = new Set<string>();
  for (const label of event.regionLabels) {
    if (label === NATIONWIDE_LABEL) continue;
    const code = REGION_CODES[label];
    if (code) codes.add(code);
  }
  return { codes, nationwide };
}

function regionLabelsFromBuckets(buckets: { codes: Set<string>; nationwide: boolean }): string[] {
  if (buckets.nationwide) return [NATIONWIDE_LABEL];
  return [...buckets.codes].sort().map((code) => REGION_LABELS[code] ?? code);
}

function compareEvents(a: PublicCalendarEvent, b: PublicCalendarEvent): number {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  return a.title.localeCompare(b.title, "ko-KR");
}

function fallbackStatus(status: GrantStatus): PublicCalendarEventStatus {
  if (status === "closed") return "closed";
  if (status === "upcoming") return "upcoming";
  // open·unknown → 발견 표면이므로 노출(open).
  return "open";
}

function dateKeyOrNull(value: Date | null): string | null {
  return value ? dateKey(value.toISOString()) : null;
}

function increment(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}
