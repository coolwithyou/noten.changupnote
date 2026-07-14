import assert from "node:assert/strict";
import * as dates from "@/lib/calendar/dates";
import { calendarDday, dateKey, monthStart } from "./ApplicationCalendarView";

// 순수 로직은 @/lib/calendar/dates로 이전했고, 이 뷰는 기존 계약 유지를 위해
// dateKey/monthStart/calendarDday를 re-export 한다. 셋이 dates 모듈의 동일 함수를
// 가리키는지(동작 검증은 dates.test.ts가 담당) 최소 sanity로만 가드한다.
assert.equal(dateKey, dates.dateKey);
assert.equal(monthStart, dates.monthStart);
assert.equal(calendarDday, dates.calendarDday);

console.log("application-calendar-view: re-export contract ok");
