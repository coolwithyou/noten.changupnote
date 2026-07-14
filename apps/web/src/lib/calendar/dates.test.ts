import assert from "node:assert/strict";
import {
  calendarDday,
  dateKey,
  indexEventsByDate,
  monthKey,
  monthStart,
  parseMonthKey,
} from "./dates";

// dateKey — KST 기준 날짜 키 정규화
assert.equal(dateKey("2026-07-14T15:30:00.000Z"), "2026-07-15");
assert.equal(dateKey("2026-07-31T15:30:00.000Z"), "2026-08-01");
assert.equal(dateKey("2026-08-04"), "2026-08-04");
assert.equal(monthStart("2026-07-31T15:30:00.000Z").toISOString(), "2026-08-01T00:00:00.000Z");

// KST 자정 경계 — UTC 15:00에 다음 날로 넘어간다
const beforeKoreaMidnight = dateKey("2026-07-14T14:59:59.000Z");
const atKoreaMidnight = dateKey("2026-07-14T15:00:00.000Z");
assert.equal(beforeKoreaMidnight, "2026-07-14");
assert.equal(atKoreaMidnight, "2026-07-15");
assert.equal(calendarDday("2026-07-15", beforeKoreaMidnight), 1);
assert.equal(calendarDday("2026-07-15", atKoreaMidnight), 0);

assert.equal(calendarDday(dateKey("2026-08-04"), "2026-08-01"), 3);
assert.equal(calendarDday(dateKey("2026-08-03T15:00:00.000Z"), "2026-08-01"), 3);
assert.equal(calendarDday("invalid", "2026-08-01"), null);

// monthKey — KST 기준 "YYYY-MM"
assert.equal(monthKey(new Date("2026-07-15T04:00:00.000Z")), "2026-07");
assert.equal(monthKey(new Date("2026-07-31T15:00:00.000Z")), "2026-08"); // KST로 8월 1일
assert.equal(monthKey(new Date("2026-01-01T00:00:00.000Z")), "2026-01");

// parseMonthKey — 형식·월 범위 검증
assert.deepEqual(parseMonthKey("2026-07"), { year: 2026, month: 7 });
assert.deepEqual(parseMonthKey("2026-12"), { year: 2026, month: 12 });
assert.deepEqual(parseMonthKey("2026-01"), { year: 2026, month: 1 });
assert.equal(parseMonthKey("2026-00"), null);
assert.equal(parseMonthKey("2026-13"), null);
assert.equal(parseMonthKey("2026-7"), null);
assert.equal(parseMonthKey("2026/07"), null);
assert.equal(parseMonthKey("2026-07-01"), null);
assert.equal(parseMonthKey(""), null);

// indexEventsByDate — 같은 날짜끼리 순서 보존 그룹핑 (제네릭)
const grouped = indexEventsByDate([
  { date: "2026-07-15", id: "a" },
  { date: "2026-07-16", id: "b" },
  { date: "2026-07-15", id: "c" },
]);
assert.deepEqual(grouped.get("2026-07-15")?.map((event) => event.id), ["a", "c"]);
assert.deepEqual(grouped.get("2026-07-16")?.map((event) => event.id), ["b"]);
assert.equal(grouped.get("2026-07-17"), undefined);
assert.equal(indexEventsByDate([]).size, 0);

console.log("calendar-dates: ok");
