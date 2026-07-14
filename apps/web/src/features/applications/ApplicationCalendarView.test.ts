import assert from "node:assert/strict";
import { calendarDday, dateKey, monthStart } from "./ApplicationCalendarView";

assert.equal(dateKey("2026-07-14T15:30:00.000Z"), "2026-07-15");
assert.equal(dateKey("2026-07-31T15:30:00.000Z"), "2026-08-01");
assert.equal(dateKey("2026-08-04"), "2026-08-04");
assert.equal(monthStart("2026-07-31T15:30:00.000Z").toISOString(), "2026-08-01T00:00:00.000Z");

const beforeKoreaMidnight = dateKey("2026-07-14T14:59:59.000Z");
const atKoreaMidnight = dateKey("2026-07-14T15:00:00.000Z");
assert.equal(beforeKoreaMidnight, "2026-07-14");
assert.equal(atKoreaMidnight, "2026-07-15");
assert.equal(calendarDday("2026-07-15", beforeKoreaMidnight), 1);
assert.equal(calendarDday("2026-07-15", atKoreaMidnight), 0);

assert.equal(calendarDday(dateKey("2026-08-04"), "2026-08-01"), 3);
assert.equal(calendarDday(dateKey("2026-08-03T15:00:00.000Z"), "2026-08-01"), 3);
assert.equal(calendarDday("invalid", "2026-08-01"), null);

console.log("application-calendar-view: ok");
