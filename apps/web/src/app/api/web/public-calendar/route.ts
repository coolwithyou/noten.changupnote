/**
 * 공개 마감 캘린더 ICS 구독 피드 — GET /api/web/public-calendar
 *
 * 비로그인 공개 피드(토큰 없음). /calendar 페이지와 동일한 필터 파서를 재사용하고,
 * rolling window(오늘~+120일·상한 300)는 loadPublicCalendarFeed가 처리한다.
 * month 파라미터는 피드에 의미가 없어 무시한다(구독 피드는 월 개념이 없음).
 * 공개 데이터이므로 개인 피드(private)와 달리 public 캐시를 태운다.
 */

import { dateKey, monthKey } from "@/lib/calendar/dates";
import {
  parsePublicCalendarSearchParams,
  serializePublicCalendarQuery,
  type PublicCalendarFilters,
} from "@/lib/publicCalendar/query";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  renderIcsCalendar,
  stableId,
  type CalendarIcsEvent,
} from "@/lib/server/calendar/ics";
import type { PublicCalendarEvent } from "@/lib/server/publicCalendar/publicCalendarCore";
import { loadPublicCalendarFeed } from "@/lib/server/publicCalendar/publicCalendarData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CALENDAR_NAME = "창업노트 마감 캘린더";
const PRODUCT_ID = "-//Cunote//Public Deadline Calendar//KO";
const DOWNLOAD_FILENAME = "창업노트-마감캘린더.ics";
const DOWNLOAD_FALLBACK_FILENAME = "cunote-public-calendar.ics";
// 공개 피드 캐시: 브라우저 30분·CDN 1시간 + SWR 1시간(캘린더 앱 폴링·크롤 흡수).
const FEED_CACHE_CONTROL = "public, max-age=1800, s-maxage=3600, stale-while-revalidate=3600";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const now = new Date();
    // KST 기준 오늘 날짜 키 — rolling window·D-day·파생 상태의 기준점.
    const todayKey = dateKey(now.toISOString());

    // 페이지와 동일 파서 재사용. month는 넘기지 않아 항상 현재 월로 폴백된다(피드에선 미사용).
    const { filters } = parsePublicCalendarSearchParams(
      feedSearchParamsRecord(url.searchParams),
      monthKey(now),
    );

    const events = await loadPublicCalendarFeed({ filters, todayKey });
    const calendarPageUrl = buildCalendarPageUrl(url.origin, filters, monthKey(now));
    const ics = renderIcsCalendar(
      {
        productId: PRODUCT_ID,
        generatedAt: now,
        events: events.map((event) => toCalendarIcsEvent(event, calendarPageUrl)),
      },
      { calendarName: CALENDAR_NAME },
    );

    return new Response(ics, {
      status: 200,
      headers: {
        "cache-control": FEED_CACHE_CONTROL,
        "content-disposition":
          url.searchParams.get("download") === "1"
            ? attachmentContentDisposition(DOWNLOAD_FILENAME, DOWNLOAD_FALLBACK_FILENAME)
            : `inline; filename="${DOWNLOAD_FALLBACK_FILENAME}"`,
        "content-type": "text/calendar; charset=utf-8",
      },
    });
  } catch (error) {
    // PublicCalendarDataError(code·status 보유)는 해당 status의 JSON으로, 그 외는 500.
    // webActionError는 message만 내보내므로 스택은 노출되지 않는다.
    return webActionError<null>(error, {
      code: "public_calendar_feed_failed",
      message: "공개 마감 캘린더 feed를 불러오지 못했습니다.",
    });
  }
}

/**
 * 피드 이벤트 → ICS 이벤트 매핑 (순수 함수 — DB 없이 검증 가능).
 * UID는 기존 관례(`deadline-{stableId(grantId)}@cunote`)의 도메인부를 따르되
 * 공개 피드임을 `pub-` 접두로 구분한다. URL은 원문이 없으면 캘린더 페이지로 폴백.
 */
export function toCalendarIcsEvent(
  event: PublicCalendarEvent,
  calendarPageUrl: string,
): CalendarIcsEvent {
  return {
    uid: `pub-${event.kind}-${stableId(event.grantId)}@cunote`,
    date: event.date,
    summary: event.kind === "deadline" ? `마감: ${event.title}` : `접수 시작: ${event.title}`,
    description: buildPublicCalendarDescription(event, calendarPageUrl),
    url: event.url ?? calendarPageUrl,
  };
}

/**
 * DESCRIPTION 조립 — 기존 buildDescription 문체(`라벨: 값` 줄, 있는 항목만) 유지.
 * 기관·분야·지역·지원금 + 원문 링크 + 캘린더 페이지 링크 순.
 */
export function buildPublicCalendarDescription(
  event: PublicCalendarEvent,
  calendarPageUrl: string,
): string {
  return [
    event.title,
    event.agency ? `기관: ${event.agency}` : null,
    event.categoryL1 ? `분야: ${event.categoryL1}` : null,
    event.regionLabels.length > 0 ? `지역: ${event.regionLabels.join(", ")}` : null,
    event.supportAmountLabel ? `지원금: ${event.supportAmountLabel}` : null,
    event.url ? `원문 링크: ${event.url}` : null,
    `창업노트 마감 캘린더: ${calendarPageUrl}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

/**
 * 현재 필터가 반영된 /calendar 절대 URL. 정규형 직렬화를 재사용해 페이지 URL과
 * 항상 같은 형태가 되게 한다(month는 currentMonthKey와 같으므로 생략됨).
 */
export function buildCalendarPageUrl(
  origin: string,
  filters: PublicCalendarFilters,
  currentMonthKey: string,
): string {
  const query = serializePublicCalendarQuery(currentMonthKey, filters, { currentMonthKey });
  return query ? `${origin}/calendar?${query}` : `${origin}/calendar`;
}

// 피드가 소비하는 파라미터만 파서에 넘긴다. month는 의도적으로 제외(rolling window라 무의미).
function feedSearchParamsRecord(
  searchParams: URLSearchParams,
): Record<string, string | undefined> {
  return {
    region: searchParams.get("region") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    status: searchParams.get("status") ?? undefined,
  };
}

// downloadHeaders.ts의 contentDisposition 관례(RFC 5987, 한글 filename*)를 그대로 따른다.
// textDownloadResponse는 cache-control을 no-store로 고정해 공개 캐시와 충돌하므로
// disposition 문자열만 동일 형식으로 조립한다.
function attachmentContentDisposition(filename: string, fallback: string): string {
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}
