import assert from "node:assert/strict";
import {
  CALENDAR_MIN_MONTH,
  clampCalendarMonth,
  parsePublicCalendarSearchParams,
  serializePublicCalendarQuery,
  type PublicCalendarFilters,
} from "./query";

const CURRENT = "2026-07";

function emptyFilters(): PublicCalendarFilters {
  return { regions: [], categories: [], sources: [], statuses: [] };
}

// ── 파싱: 오염 값 drop·dedupe·정렬 ──────────────────────────────
const parsed = parsePublicCalendarSearchParams(
  {
    month: "2026-09",
    region: "41,11,41,99",
    category: " 창업교육 , 창업교육 ,",
    source: "kstartup,bogus,bizinfo",
    status: "open,bad,upcoming",
  },
  CURRENT,
);
assert.equal(parsed.month, "2026-09");
assert.deepEqual(parsed.filters.regions, ["11", "41"], "불량(99) drop·dedupe·정렬");
assert.deepEqual(parsed.filters.categories, ["창업교육"], "trim·빈 값 drop·dedupe");
assert.deepEqual(parsed.filters.sources, ["bizinfo", "kstartup"], "enum 검증·정렬");
assert.deepEqual(parsed.filters.statuses, ["open", "upcoming"], "status enum 검증");

// dedupe·정렬 안정성 — 입력 순서와 무관하게 정규형
assert.deepEqual(
  parsePublicCalendarSearchParams({ region: "50,11,26,11" }, CURRENT).filters.regions,
  ["11", "26", "50"],
);

// 배열 searchParam은 첫 값만 사용
assert.deepEqual(
  parsePublicCalendarSearchParams({ region: ["26,11", "99"] }, CURRENT).filters.regions,
  ["11", "26"],
);

// ── 월 폴백: 불량/범위 밖 → 현재 월 ──────────────────────────────
assert.equal(parsePublicCalendarSearchParams({}, CURRENT).month, CURRENT, "부재 → 현재 월");
assert.equal(parsePublicCalendarSearchParams({ month: "not-month" }, CURRENT).month, CURRENT);
assert.equal(parsePublicCalendarSearchParams({ month: "2026-13" }, CURRENT).month, CURRENT, "월 범위 밖");
assert.equal(parsePublicCalendarSearchParams({ month: "2023-12" }, CURRENT).month, CURRENT, "MIN 미만");
assert.equal(parsePublicCalendarSearchParams({ month: "2027-08" }, CURRENT).month, CURRENT, "현재+12 초과");
// 경계는 허용
assert.equal(parsePublicCalendarSearchParams({ month: CALENDAR_MIN_MONTH }, CURRENT).month, CALENDAR_MIN_MONTH);
assert.equal(parsePublicCalendarSearchParams({ month: "2027-07" }, CURRENT).month, "2027-07", "현재+12 경계 허용");

// ── clamp 경계 ─────────────────────────────────────────────────
assert.equal(clampCalendarMonth("2023-05", CURRENT), CALENDAR_MIN_MONTH, "하한 clamp");
assert.equal(clampCalendarMonth("2030-01", CURRENT), "2027-07", "상한(현재+12) clamp");
assert.equal(clampCalendarMonth("2026-09", CURRENT), "2026-09", "범위 내 유지");
assert.equal(clampCalendarMonth(CALENDAR_MIN_MONTH, CURRENT), CALENDAR_MIN_MONTH, "하한 경계");
assert.equal(clampCalendarMonth("2027-07", CURRENT), "2027-07", "상한 경계");
assert.equal(clampCalendarMonth("garbage", CURRENT), CURRENT, "불량 입력 → 현재 월");

// ── 직렬화: 정규 순서·정렬, 기본값 생략 ─────────────────────────
const filters: PublicCalendarFilters = {
  regions: ["41", "11"],
  categories: ["창업교육"],
  sources: ["bizinfo", "kstartup"],
  statuses: ["upcoming", "open"],
};
const serialized = serializePublicCalendarQuery("2026-09", filters);
const serializedParams = new URLSearchParams(serialized);
assert.deepEqual(
  [...serializedParams.keys()],
  ["month", "region", "category", "source", "status"],
  "축 순서는 항상 month→region→category→source→status",
);
assert.equal(serializedParams.get("region"), "11,41", "정렬된 코드");
assert.equal(serializedParams.get("status"), "open,upcoming");

// 정렬 안 된 입력도 방어적으로 정규화
const messy = serializePublicCalendarQuery(
  "2026-07",
  { regions: ["50", "11"], categories: ["나", "가", "가"], sources: ["kstartup"], statuses: ["open"] },
  { currentMonthKey: CURRENT },
);
const messyParams = new URLSearchParams(messy);
assert.equal(messyParams.get("region"), "11,50");
assert.equal(messyParams.get("category"), "가,나");
assert.equal(messyParams.has("month"), false, "현재 월은 생략");

// 기본값(현재 월 + 빈 필터)은 완전히 빈 문자열
assert.equal(
  serializePublicCalendarQuery(CURRENT, emptyFilters(), { currentMonthKey: CURRENT }),
  "",
  "기본값 → 빈 쿼리",
);
// currentMonthKey 미제공이면 month는 항상 포함
assert.equal(serializePublicCalendarQuery(CURRENT, emptyFilters()), "month=2026-07");
// 다른 월은 currentMonthKey를 줘도 포함
assert.equal(
  serializePublicCalendarQuery("2026-09", emptyFilters(), { currentMonthKey: CURRENT }),
  "month=2026-09",
);

// ── 파싱/직렬화 왕복 ────────────────────────────────────────────
const roundTrip = parsePublicCalendarSearchParams(
  Object.fromEntries(new URLSearchParams(serialized)),
  CURRENT,
);
assert.equal(roundTrip.month, "2026-09");
assert.deepEqual(roundTrip.filters.regions, ["11", "41"]);
assert.deepEqual(roundTrip.filters.categories, ["창업교육"]);
assert.deepEqual(roundTrip.filters.sources, ["bizinfo", "kstartup"]);
assert.deepEqual(roundTrip.filters.statuses, ["open", "upcoming"]);

console.log("public-calendar-query: ok");
