/**
 * 공개 전체-공고 마감 캘린더의 DB 로더 — grants 단독 얕은 쿼리 + 모듈 스코프 promise 캐시.
 *
 * grantArchiveData(criteria JOIN + 20k 스캔)를 쓰지 않고, 월 범위에 걸치는 grants 행만
 * DTO 필드 컬럼으로 얕게 읽는다. status/활성 조건을 SQL에 걸지 않아(백필 잡이 없어 stale)
 * 읽기 시점 deriveCalendarStatus로 교정하고, 조건 없는 월 쿼리로 캐시 재사용성을 최대화한다.
 * 필터·facet은 캐시된 rows에서 in-memory로 돌린다(히트율 보존).
 */

import { and, gte, lt, or } from "drizzle-orm";
import type { GrantSource, GrantStatus } from "@cunote/contracts";
import { dateKeyToUtcDate, parseMonthKey } from "@/lib/calendar/dates";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { getRepositoryAdapterName } from "@/lib/server/repositories/factory";
import type { PublicCalendarFilters } from "@/lib/publicCalendar/query";
import {
  applyPublicCalendarFilters,
  buildPublicCalendarEvents,
  type PublicCalendarEvent,
  type PublicCalendarRow,
} from "./publicCalendarCore";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 한 달 행 상한 sentinel. 초과 시 부분 결과를 조용히 반환하지 않고 명시적으로 실패한다.
const PUBLIC_CALENDAR_MONTH_SCAN_LIMIT = 5_000;
const MONTH_CACHE_TTL_MS = 5 * 60 * 1000;
// 과거 월 크롤(SEO)로 키가 무한히 늘지 않도록 엔트리 상한을 두고 가장 오래된 것을 축출한다.
const MONTH_CACHE_MAX_ENTRIES = 24;
// 피드 rolling window: 오늘~+120일. 현재 월 포함 연속 5개 월을 병합하면 이 창을 항상 덮는다.
const FEED_WINDOW_DAYS = 120;
const FEED_WINDOW_MONTHS = 5;
const FEED_MAX_EVENTS = 300;

/** 월 로더/피드에서 던지는 도메인 에러(status는 응답 코드 성격). */
export class PublicCalendarDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicCalendarDataError";
  }
}

interface MonthCacheEntry {
  cachedAtMs: number;
  task: Promise<PublicCalendarRow[]>;
}

// 키 = monthKey만(필터·facet은 캐시 밖 in-memory). promise를 캐시해 동시 요청도 조회 1회에 합류시킨다.
const monthCache = new Map<string, MonthCacheEntry>();

export function resetPublicCalendarMonthCacheForTests(): void {
  monthCache.clear();
}

/**
 * 한 달(KST 기준)에 applyEnd 또는 applyStart가 걸치는 grants 행을 얕게 읽는다.
 * drizzle 어댑터일 때만 TTL 5분 promise 캐시를 태운다(in-memory 어댑터는 조회가 싸고 테스트가 저장소를 갱신).
 */
export async function loadPublicCalendarMonth({
  monthKey,
}: {
  monthKey: string;
}): Promise<PublicCalendarRow[]> {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) {
    throw new PublicCalendarDataError("invalid_month", `월 키가 올바르지 않습니다: ${monthKey}`, 400);
  }

  if (getRepositoryAdapterName() !== "drizzle") {
    return loadPublicCalendarMonthUncached(parsed);
  }

  const nowMs = Date.now();
  const cached = monthCache.get(monthKey);
  if (cached && nowMs - cached.cachedAtMs < MONTH_CACHE_TTL_MS) {
    return cached.task;
  }

  const task = loadPublicCalendarMonthUncached(parsed);
  monthCache.set(monthKey, { cachedAtMs: nowMs, task });
  // 실패 시 엔트리를 비워 다음 요청이 재시도하게 한다.
  task.catch(() => {
    if (monthCache.get(monthKey)?.task === task) monthCache.delete(monthKey);
  });
  evictOldestEntries();
  return task;
}

/**
 * 피드용: 오늘~+120일 창을 덮는 연속 5개 월을 병합한다.
 * 한 공고가 applyStart·applyEnd로 두 월 캐시에 걸치면 이벤트가 중복 생성되므로 id 기준 dedup.
 * 창 밖 날짜 제외 → 필터 적용 → 날짜순 정렬 → 300 이벤트 상한.
 */
export async function loadPublicCalendarFeed({
  filters,
  todayKey,
}: {
  filters: PublicCalendarFilters;
  todayKey: string;
}): Promise<PublicCalendarEvent[]> {
  const startMonth = parseMonthKey(todayKey.slice(0, 7));
  if (!startMonth) {
    throw new PublicCalendarDataError("invalid_today", `오늘 날짜 키가 올바르지 않습니다: ${todayKey}`, 400);
  }

  const months = feedMonthKeys(startMonth, FEED_WINDOW_MONTHS);
  const monthRows = await Promise.all(
    months.map((month) => loadPublicCalendarMonth({ monthKey: month })),
  );

  const byId = new Map<string, PublicCalendarEvent>();
  for (const rows of monthRows) {
    for (const event of buildPublicCalendarEvents(rows, todayKey)) {
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
  }

  const windowEndKey = addDaysToKey(todayKey, FEED_WINDOW_DAYS);
  const windowed = [...byId.values()].filter(
    (event) => event.date >= todayKey && event.date <= windowEndKey,
  );
  const filtered = applyPublicCalendarFilters(windowed, filters);
  filtered.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title, "ko-KR")));
  return filtered.slice(0, FEED_MAX_EVENTS);
}

async function loadPublicCalendarMonthUncached(parsed: {
  year: number;
  month: number;
}): Promise<PublicCalendarRow[]> {
  const monthStart = kstMonthBoundary(parsed.year, parsed.month - 1);
  const nextMonthStart = kstMonthBoundary(parsed.year, parsed.month);
  const db = getCunoteDb();

  const rows = await db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      url: schema.grants.url,
      agencyOperator: schema.grants.agencyOperator,
      agencyJurisdiction: schema.grants.agencyJurisdiction,
      agencyPrimary: schema.grants.agencyPrimary,
      categoryL1: schema.grants.categoryL1,
      applyStart: schema.grants.applyStart,
      applyEnd: schema.grants.applyEnd,
      status: schema.grants.status,
      fRegions: schema.grants.fRegions,
      supportAmount: schema.grants.supportAmount,
    })
    .from(schema.grants)
    .where(
      or(
        and(gte(schema.grants.applyEnd, monthStart), lt(schema.grants.applyEnd, nextMonthStart)),
        and(gte(schema.grants.applyStart, monthStart), lt(schema.grants.applyStart, nextMonthStart)),
      ),
    )
    .limit(PUBLIC_CALENDAR_MONTH_SCAN_LIMIT + 1);

  if (rows.length > PUBLIC_CALENDAR_MONTH_SCAN_LIMIT) {
    throw new PublicCalendarDataError(
      "public_calendar_month_scan_incomplete",
      `한 달 공고가 ${PUBLIC_CALENDAR_MONTH_SCAN_LIMIT.toLocaleString("ko-KR")}건을 초과해 캘린더를 완전히 표시할 수 없습니다.`,
      503,
    );
  }

  return rows.map(toPublicCalendarRow);
}

function toPublicCalendarRow(row: {
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
  fRegions: string[];
  supportAmount: Record<string, unknown> | null;
}): PublicCalendarRow {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.sourceId,
    title: row.title,
    url: row.url,
    agencyOperator: row.agencyOperator,
    agencyJurisdiction: row.agencyJurisdiction,
    agencyPrimary: row.agencyPrimary,
    categoryL1: row.categoryL1,
    applyStart: row.applyStart,
    applyEnd: row.applyEnd,
    status: row.status,
    fRegions: row.fRegions,
    supportAmount: row.supportAmount,
  };
}

// KST 자정 경계를 UTC Date로. Asia/Seoul(UTC+9)이므로 KST 자정 = UTC 기준 -9h.
function kstMonthBoundary(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1) - KST_OFFSET_MS);
}

function feedMonthKeys(start: { year: number; month: number }, count: number): string[] {
  const base = start.year * 12 + (start.month - 1);
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = base + index;
    const year = Math.floor(value / 12);
    const month = (value % 12) + 1;
    keys.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
  }
  return keys;
}

function addDaysToKey(monthDayKey: string, days: number): string {
  const date = dateKeyToUtcDate(monthDayKey);
  if (!date) return monthDayKey;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function evictOldestEntries(): void {
  while (monthCache.size > MONTH_CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of monthCache) {
      if (entry.cachedAtMs < oldestAt) {
        oldestAt = entry.cachedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    monthCache.delete(oldestKey);
  }
}
