import assert from "node:assert/strict"

import {
  buildNoticeCalendarRange,
  buildNoticeCalendarSnapshot,
  parseNoticeCalendarMonth,
} from "./calendar"

const now = new Date("2026-07-27T03:00:00.000Z")

assert.equal(parseNoticeCalendarMonth("2026-07", now), "2026-07")
assert.equal(parseNoticeCalendarMonth(["2026-08", "2026-09"], now), "2026-08")
assert.equal(parseNoticeCalendarMonth("2026-13", now), "2026-07")
assert.equal(parseNoticeCalendarMonth(undefined, now), "2026-07")

const july = buildNoticeCalendarRange("2026-07")
assert.equal(july.startDate, "2026-06-28")
assert.equal(july.endDateExclusive, "2026-08-09")
assert.equal(july.previousMonth, "2026-06")
assert.equal(july.nextMonth, "2026-08")
assert.equal(july.days.length, 42)
assert.equal(july.days.filter((day) => day.inCurrentMonth).length, 31)

const snapshot = buildNoticeCalendarSnapshot({
  range: july,
  generatedAt: now,
  historySource: "events",
  aggregates: [
    {
      date: "2026-07-25",
      collected: 97,
      analyzed: 4,
      activated: 2,
      kstartup: 77,
      bizinfo: 20,
      bizinfoEvent: 0,
    },
    {
      date: "2026-06-30",
      collected: 5,
      analyzed: 0,
      activated: 0,
      kstartup: 5,
      bizinfo: 0,
      bizinfoEvent: 0,
    },
  ],
})

assert.deepEqual(snapshot.totals, { collected: 97, analyzed: 4, activated: 2 })
assert.equal(snapshot.days.find((day) => day.date === "2026-07-27")?.isToday, true)
assert.equal(snapshot.days.find((day) => day.date === "2026-06-30")?.inCurrentMonth, false)
assert.deepEqual(
  snapshot.days.find((day) => day.date === "2026-07-25")?.collectedBySource,
  { kstartup: 77, bizinfo: 20, bizinfoEvent: 0 },
)

console.log("notice calendar tests: ok")
