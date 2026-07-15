/**
 * 공개 마감 캘린더 "내 캘린더에 연동" 링크 빌더 — 순수 모듈(React/DOM 비의존).
 *
 * 피드 경로 계약: `GET /api/web/public-calendar` + serializePublicCalendarQuery의
 * 필터 파라미터(month 없음 — 피드는 rolling window라 월 개념이 없다). 페이지와 같은
 * 직렬화기를 재사용해 필터 인코딩(정렬·dedupe·불량 drop)이 URL과 피드에서 항상 일치한다.
 * origin은 클라이언트가 클릭/오픈 시점 window.location.origin으로 주입한다
 * (SSR에 origin을 싣지 않아 hydration 불일치를 피한다).
 */

import {
  serializePublicCalendarQuery,
  type PublicCalendarFilters,
} from "@/lib/publicCalendar/query";

/** 공개 ICS 피드 엔드포인트(같은 팀이 작업 중인 라우트와의 경로 계약). */
export const PUBLIC_CALENDAR_FEED_ENDPOINT = "/api/web/public-calendar";
/** 캘린더 앱에 표시될 구독 캘린더 이름(Outlook addfromweb의 name 파라미터). */
export const PUBLIC_CALENDAR_FEED_NAME = "창업노트 마감 캘린더";

export interface PublicCalendarConnectLinks {
  /** .ics 파일 다운로드(같은 오리진): 피드 경로 + download=1. */
  ics: string;
  /** Apple 캘린더 등 webcal 구독: webcal://{host}{path}. */
  webcal: string;
  /** Google 캘린더 구독 추가: cid={webcal URL 인코딩}. */
  google: string;
  /** Outlook 웹 구독 추가: url={webcal URL 인코딩}&name={캘린더 이름 인코딩}. */
  outlook: string;
}

/**
 * 현재 필터가 반영된 피드 경로(오리진 없는 상대 경로).
 * month 키로 빈 문자열을 넘겨 직렬화기가 month 축을 방출하지 않게 한다
 * (serializePublicCalendarQuery는 parseMonthKey 불량 키를 생략한다).
 */
export function publicCalendarFeedPath(filters: PublicCalendarFilters): string {
  const query = serializePublicCalendarQuery("", filters);
  return query ? `${PUBLIC_CALENDAR_FEED_ENDPOINT}?${query}` : PUBLIC_CALENDAR_FEED_ENDPOINT;
}

/**
 * origin + 필터 → 연동 드롭다운의 4개 링크.
 * webcal은 https/http 스킴만 webcal로 치환한다(applicationCalendarSubscription.toWebcalUrl 패턴).
 */
export function buildCalendarConnectLinks(
  origin: string,
  filters: PublicCalendarFilters,
): PublicCalendarConnectLinks {
  const feedPath = publicCalendarFeedPath(filters);
  const httpsUrl = `${normalizeOrigin(origin)}${feedPath}`;
  const webcalUrl = toWebcalUrl(httpsUrl);
  return {
    ics: withDownloadParam(httpsUrl),
    webcal: webcalUrl,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
    outlook:
      `https://outlook.live.com/calendar/0/addfromweb` +
      `?url=${encodeURIComponent(webcalUrl)}&name=${encodeURIComponent(PUBLIC_CALENDAR_FEED_NAME)}`,
  };
}

// origin에 경로·후행 슬래시가 섞여 들어와도 순수 오리진으로 정규화한다.
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

function toWebcalUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https?:/i, "webcal:");
}

function withDownloadParam(url: string): string {
  return url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
}
