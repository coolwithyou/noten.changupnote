import assert from "node:assert/strict";
import {
  applyPublicCalendarFilters,
  buildPublicCalendarEvents,
  buildPublicCalendarFacets,
  deriveCalendarStatus,
  normalizeRegionBuckets,
  type PublicCalendarRow,
} from "./publicCalendarCore";

const TODAY = "2026-07-15";

// 03:00Z = KST 12:00 같은 달력일 → dateKey가 인자 키와 일치(경계 혼동 회피).
function d(dateKey: string): Date {
  return new Date(`${dateKey}T03:00:00.000Z`);
}

function row(overrides: Partial<PublicCalendarRow> = {}): PublicCalendarRow {
  return {
    id: "g0",
    source: "kstartup",
    sourceId: "s0",
    title: "공고",
    url: "https://example.com/g0",
    agencyOperator: "운영기관",
    agencyJurisdiction: null,
    agencyPrimary: null,
    categoryL1: "창업",
    applyStart: null,
    applyEnd: null,
    status: "open",
    fRegions: ["11"],
    supportAmount: null,
    ...overrides,
  };
}

// ── deriveCalendarStatus: 읽기 시점 상태 파생 ────────────────────
// stale open → closed 교정 (마감 경과)
assert.equal(deriveCalendarStatus({ applyStart: d("2026-07-01"), applyEnd: d("2026-07-10"), status: "open" }, TODAY), "closed");
// 접수 시작 전 → upcoming
assert.equal(deriveCalendarStatus({ applyStart: d("2026-07-20"), applyEnd: d("2026-08-10"), status: "open" }, TODAY), "upcoming");
// 접수 기간 내 → open (경계: end == today 포함)
assert.equal(deriveCalendarStatus({ applyStart: d("2026-07-10"), applyEnd: d("2026-07-15"), status: "unknown" }, TODAY), "open");
// 날짜 부족 폴백 — closed는 closed 유지, unknown/open은 open, upcoming은 upcoming
assert.equal(deriveCalendarStatus({ applyStart: null, applyEnd: null, status: "closed" }, TODAY), "closed");
assert.equal(deriveCalendarStatus({ applyStart: null, applyEnd: null, status: "unknown" }, TODAY), "open");
assert.equal(deriveCalendarStatus({ applyStart: null, applyEnd: null, status: "upcoming" }, TODAY), "upcoming");
// 한쪽 날짜만 — 시작만(과거)·마감만(미래) → 폴백(DB open → open)
assert.equal(deriveCalendarStatus({ applyStart: d("2026-07-01"), applyEnd: null, status: "open" }, TODAY), "open");
assert.equal(deriveCalendarStatus({ applyStart: null, applyEnd: d("2026-07-31"), status: "open" }, TODAY), "open");

// ── normalizeRegionBuckets: 지역 버킷 ──────────────────────────
function bucketArr(buckets: { codes: Set<string>; nationwide: boolean }) {
  return { codes: [...buckets.codes].sort(), nationwide: buckets.nationwide };
}
assert.deepEqual(bucketArr(normalizeRegionBuckets(null)), { codes: [], nationwide: true });
assert.deepEqual(bucketArr(normalizeRegionBuckets([])), { codes: [], nationwide: true });
// 오염 토큰·전국 의미 토큰만 → 유효 코드 0개 → 전국
assert.deepEqual(bucketArr(normalizeRegionBuckets(["99", "국내"])), { codes: [], nationwide: true });
// 수도권 → 서울·인천·경기 3코드 확장
assert.deepEqual(bucketArr(normalizeRegionBuckets(["수도권"])), { codes: ["11", "28", "41"], nationwide: false });
// 코드·짧은 표기 혼합
assert.deepEqual(bucketArr(normalizeRegionBuckets(["11", "경기"])), { codes: ["11", "41"], nationwide: false });

// ── buildPublicCalendarEvents: 이벤트 파생·정렬 ─────────────────
const rows: PublicCalendarRow[] = [
  row({ id: "g1", title: "B공고", applyStart: d("2026-07-10"), applyEnd: d("2026-07-31"), fRegions: ["11"], status: "open", categoryL1: "창업", source: "kstartup" }),
  row({ id: "g2", title: "A공고", applyStart: null, applyEnd: d("2026-07-31"), fRegions: null, status: "open", categoryL1: "기타", source: "kstartup" }),
  row({ id: "g3", title: "상시", applyStart: d("2026-08-01"), applyEnd: null, fRegions: ["수도권"], status: "unknown", categoryL1: "창업", source: "bizinfo" }),
  row({ id: "g4", title: "무일정", applyStart: null, applyEnd: null }),
];
const events = buildPublicCalendarEvents(rows, TODAY);

// g4(날짜 둘 다 null)는 이벤트 미생성. 정렬: date asc → title(ko-KR)
assert.equal(events.length, 4);
assert.deepEqual(
  events.map((event) => event.id),
  ["g1:start", "g2:deadline", "g1:deadline", "g3:start"],
);

const g1Deadline = events.find((event) => event.id === "g1:deadline");
assert.ok(g1Deadline);
assert.equal(g1Deadline.kind, "deadline");
assert.equal(g1Deadline.dDay, 16, "deadline D-day = calendarDday");
assert.equal(g1Deadline.status, "open");
assert.deepEqual(g1Deadline.regionLabels, ["서울"]);
assert.equal(g1Deadline.sourceLabel, "K-Startup");
assert.equal(g1Deadline.agency, "운영기관");
assert.equal(g1Deadline.supportAmountLabel, null, "지원금 라벨 재사용(null 값 → null)");

const g1Start = events.find((event) => event.id === "g1:start");
assert.ok(g1Start);
assert.equal(g1Start.dDay, null, "start 이벤트는 dDay 없음");

assert.deepEqual(events.find((event) => event.id === "g2:deadline")?.regionLabels, ["전국"]);
assert.deepEqual(events.find((event) => event.id === "g3:start")?.regionLabels, ["서울", "인천", "경기"]);
assert.equal(events.find((event) => event.id === "g3:start")?.status, "upcoming");

// ── applyPublicCalendarFilters: 각 축 ──────────────────────────
const ids = (list: typeof events) => new Set(list.map((event) => event.id));
// 지역: nationwide || 교집합. region=41 → g2(전국)·g3(수도권⊇41) 통과, g1(서울만) 제외
assert.deepEqual(
  ids(applyPublicCalendarFilters(events, { regions: ["41"], categories: [], sources: [], statuses: [] })),
  new Set(["g2:deadline", "g3:start"]),
);
// 분야: categoryL1 완전 일치
assert.deepEqual(
  ids(applyPublicCalendarFilters(events, { regions: [], categories: ["창업"], sources: [], statuses: [] })),
  new Set(["g1:start", "g1:deadline", "g3:start"]),
);
// 소스
assert.deepEqual(
  ids(applyPublicCalendarFilters(events, { regions: [], categories: [], sources: ["bizinfo"], statuses: [] })),
  new Set(["g3:start"]),
);
// 상태(파생): upcoming
assert.deepEqual(
  ids(applyPublicCalendarFilters(events, { regions: [], categories: [], sources: [], statuses: ["upcoming"] })),
  new Set(["g3:start"]),
);
// 상태: open (closed 이벤트 없음, 세 open 이벤트)
assert.deepEqual(
  ids(applyPublicCalendarFilters(events, { regions: [], categories: [], sources: [], statuses: ["open"] })),
  new Set(["g1:start", "g1:deadline", "g2:deadline"]),
);

// ── buildPublicCalendarFacets: count 규칙 ──────────────────────
// source=bizinfo 선택 → source facet은 자기 축을 제외한 집합(=전체) 기준이라 kstartup=3 유지
const facetsSourceSelected = buildPublicCalendarFacets(events, { regions: [], categories: [], sources: ["bizinfo"], statuses: [] });
const sourceOption = (value: string) => facetsSourceSelected.sources.find((option) => option.value === value);
assert.equal(sourceOption("kstartup")?.count, 3, "자기 축(source) 선택은 자기 옵션 count에 영향 없음");
assert.equal(sourceOption("bizinfo")?.count, 1);
assert.equal(sourceOption("bizinfo")?.selected, true);
// status facet은 source=bizinfo 적용 집합(g3만) 기준 → upcoming=1, open 부재
const statusOption = (value: string) => facetsSourceSelected.statuses.find((option) => option.value === value);
assert.equal(statusOption("upcoming")?.count, 1, "다른 축(source) 필터는 status facet에 반영");
assert.equal(statusOption("open"), undefined);

// 선택된 옵션은 count 0이어도 포함
const facetsZeroSelected = buildPublicCalendarFacets(events, { regions: [], categories: [], sources: ["bizinfo_event"], statuses: [] });
const zeroOption = facetsZeroSelected.sources.find((option) => option.value === "bizinfo_event");
assert.ok(zeroOption, "선택 옵션은 count 0이어도 포함");
assert.equal(zeroOption.count, 0);
assert.equal(zeroOption.selected, true);

// 지역 facet — 전국 이벤트가 각 코드·전국 옵션에 기여
const facetsRegion = buildPublicCalendarFacets(events, { regions: [], categories: [], sources: [], statuses: [] });
const regionOption = (value: string) => facetsRegion.regions.find((option) => option.value === value);
assert.equal(regionOption("nationwide")?.count, 1);
assert.equal(regionOption("nationwide")?.label, "전국");
assert.equal(regionOption("11")?.count, 4, "서울: 코드 매칭 3 + 전국 1");
assert.equal(regionOption("11")?.label, "서울");
assert.equal(regionOption("28")?.count, 2, "인천: g3 + 전국");
assert.equal(regionOption("41")?.count, 2, "경기: g3 + 전국");

console.log("public-calendar-core: ok");
