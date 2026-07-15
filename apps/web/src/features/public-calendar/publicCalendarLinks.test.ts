import assert from "node:assert/strict";
import type { PublicCalendarFilters } from "@/lib/publicCalendar/query";
import {
  PUBLIC_CALENDAR_FEED_ENDPOINT,
  PUBLIC_CALENDAR_FEED_NAME,
  buildCalendarConnectLinks,
  publicCalendarFeedPath,
} from "./publicCalendarLinks";

function emptyFilters(): PublicCalendarFilters {
  return { regions: [], categories: [], sources: [], statuses: [] };
}

const FILTERS: PublicCalendarFilters = {
  regions: ["41", "11"],
  categories: ["창업교육"],
  sources: ["kstartup"],
  statuses: ["open"],
};

// ── 피드 경로: 필터 없으면 쿼리 없음, month 축은 절대 방출되지 않음 ──
assert.equal(publicCalendarFeedPath(emptyFilters()), PUBLIC_CALENDAR_FEED_ENDPOINT, "빈 필터 → 쿼리 없음");

const path = publicCalendarFeedPath(FILTERS);
assert.ok(path.startsWith(`${PUBLIC_CALENDAR_FEED_ENDPOINT}?`), "필터 있으면 쿼리 부착");
const pathParams = new URLSearchParams(path.slice(path.indexOf("?") + 1));
assert.equal(pathParams.has("month"), false, "피드 경로에 month 없음");
assert.equal(pathParams.get("region"), "11,41", "지역 코드는 정렬된 정규형");
assert.equal(pathParams.get("category"), "창업교육");
assert.equal(pathParams.get("source"), "kstartup");
assert.equal(pathParams.get("status"), "open");
// 한글 category는 percent-encoding으로 직렬화된다(원시 문자열에 한글 미포함).
assert.ok(path.includes("category=%EC%B0%BD%EC%97%85%EA%B5%90%EC%9C%A1"), "한글 카테고리 인코딩");

// 직렬화기 재사용 계약: 불량 지역 코드는 drop된다.
assert.equal(
  publicCalendarFeedPath({ ...emptyFilters(), regions: ["99"] }),
  PUBLIC_CALENDAR_FEED_ENDPOINT,
  "불량 코드만 있으면 빈 필터와 동일",
);

// ── 연동 링크: 필터 있는 경우 ─────────────────────────────────────
const links = buildCalendarConnectLinks("https://changupnote.com", FILTERS);

// webcal: https → webcal 스킴 치환({host}{path} 유지)
assert.ok(links.webcal.startsWith("webcal://changupnote.com/api/web/public-calendar?"), "webcal 변환");
assert.equal(new URL(links.webcal.replace(/^webcal:/, "https:")).pathname, PUBLIC_CALENDAR_FEED_ENDPOINT);

// ics: 피드 URL + download=1 (기존 필터 쿼리 뒤에 & 로 부착)
assert.ok(links.ics.startsWith("https://changupnote.com/api/web/public-calendar?"), "ics는 같은 오리진 https");
const icsParams = new URL(links.ics).searchParams;
assert.equal(icsParams.get("download"), "1", "download=1 부착");
assert.equal(icsParams.get("region"), "11,41", "ics에도 필터 보존");

// google: cid 파라미터가 webcal URL 전체를 인코딩해 담는다
assert.ok(links.google.startsWith("https://calendar.google.com/calendar/r?cid="), "google 엔드포인트");
assert.equal(new URL(links.google).searchParams.get("cid"), links.webcal, "cid = webcal URL");
assert.ok(!links.google.includes("webcal://"), "cid는 인코딩되어 원시 스킴이 노출되지 않음");

// outlook: url=webcal URL, name=캘린더 이름(한글 인코딩)
assert.ok(links.outlook.startsWith("https://outlook.live.com/calendar/0/addfromweb?"), "outlook 엔드포인트");
const outlookParams = new URL(links.outlook).searchParams;
assert.equal(outlookParams.get("url"), links.webcal, "url = webcal URL");
assert.equal(outlookParams.get("name"), PUBLIC_CALENDAR_FEED_NAME, "name = 캘린더 이름");
assert.ok(!links.outlook.includes(PUBLIC_CALENDAR_FEED_NAME), "한글 이름은 percent-encoding");

// ── 연동 링크: 필터 없는 경우 ────────────────────────────────────
const bareLinks = buildCalendarConnectLinks("http://localhost:4010", emptyFilters());
assert.equal(bareLinks.ics, "http://localhost:4010/api/web/public-calendar?download=1", "쿼리 없으면 ? 로 부착");
assert.equal(bareLinks.webcal, "webcal://localhost:4010/api/web/public-calendar", "http도 webcal 치환");
assert.equal(
  new URL(bareLinks.google).searchParams.get("cid"),
  "webcal://localhost:4010/api/web/public-calendar",
);

// ── origin 정규화: 후행 슬래시·경로 잔재가 섞여도 오리진만 사용 ────
assert.equal(
  buildCalendarConnectLinks("https://changupnote.com/", emptyFilters()).webcal,
  "webcal://changupnote.com/api/web/public-calendar",
  "후행 슬래시 정규화",
);
assert.equal(
  buildCalendarConnectLinks("https://changupnote.com/some/path", emptyFilters()).webcal,
  "webcal://changupnote.com/api/web/public-calendar",
  "경로 잔재 제거",
);

console.log("public-calendar-links: ok");
