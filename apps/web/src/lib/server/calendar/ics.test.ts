import assert from "node:assert/strict";
import { IcsDateError, renderIcsCalendar, type CalendarIcsEvent } from "./ics";

const generatedAt = new Date("2026-07-15T04:05:06.000Z");

function baseEvent(overrides: Partial<CalendarIcsEvent> = {}): CalendarIcsEvent {
  return {
    uid: "deadline-abc@cunote",
    date: "2026-07-31",
    summary: "마감 테스트",
    description: "설명",
    url: null,
    ...overrides,
  };
}

function physicalLines(ics: string): string[] {
  return ics.split("\r\n").filter((line) => line.length > 0);
}

// CRLF 종결 + 모든 줄바꿈이 \r\n (bare LF 금지)
const basic = renderIcsCalendar({
  productId: "-//Cunote//Test//KO",
  generatedAt,
  events: [baseEvent()],
});
assert.ok(basic.endsWith("\r\n"), "출력은 CRLF로 끝나야 한다");
assert.ok(!/[^\r]\n/.test(basic), "모든 LF는 CR과 짝을 이뤄야 한다");

// VALUE=DATE 형식 + DTEND가 +1일
assert.ok(basic.includes("DTSTART;VALUE=DATE:20260731"), "DTSTART는 VALUE=DATE 종일 형식");
assert.ok(basic.includes("DTEND;VALUE=DATE:20260801"), "DTEND는 DTSTART +1일");
assert.ok(basic.includes("DTSTAMP:20260715T040506Z"), "DTSTAMP는 UTC 압축 형식");

// 이스케이프 — 콤마·세미콜론·개행
const escaped = renderIcsCalendar({
  productId: "-//Cunote//Test//KO",
  generatedAt,
  events: [baseEvent({ summary: "마감: 테스트, 사업; 지원", description: "첫 줄\n둘째 줄" })],
});
assert.ok(escaped.includes("SUMMARY:마감: 테스트\\, 사업\\; 지원"), "콤마·세미콜론 이스케이프");
assert.ok(escaped.includes("DESCRIPTION:첫 줄\\n둘째 줄"), "개행 이스케이프");

// 74옥텟 폴딩 — 긴 줄은 74자 이하 물리 줄로 접히고, 언폴딩하면 원문 복원
const longUrl = `https://changupnote.com/grants/${"a".repeat(120)}`;
const folded = renderIcsCalendar({
  productId: "-//Cunote//Test//KO",
  generatedAt,
  events: [baseEvent({ url: longUrl })],
});
for (const line of physicalLines(folded)) {
  assert.ok(line.length <= 74, `물리 줄은 74자 이하여야 한다: ${line}`);
}
const unfolded = folded.replace(/\r\n /g, "");
assert.ok(unfolded.includes(`URL:${longUrl}`), "언폴딩 시 원본 URL 줄 복원");

// calendarName 미지정 → X-WR-CALNAME 부재
assert.ok(!basic.includes("X-WR-CALNAME"), "옵션 미지정 시 X-WR-CALNAME 없음");

// calendarName 지정 → X-WR-CALNAME 존재, PRODID 다음·CALSCALE 앞
const named = renderIcsCalendar(
  {
    productId: "-//Cunote//Test//KO",
    generatedAt,
    events: [baseEvent()],
  },
  { calendarName: "공개 공고 캘린더" },
);
const namedLines = physicalLines(named);
const prodIndex = namedLines.findIndex((line) => line.startsWith("PRODID:"));
const calNameIndex = namedLines.findIndex((line) => line === "X-WR-CALNAME:공개 공고 캘린더");
const calScaleIndex = namedLines.findIndex((line) => line === "CALSCALE:GREGORIAN");
assert.ok(calNameIndex !== -1, "calendarName 지정 시 X-WR-CALNAME 존재");
assert.equal(calNameIndex, prodIndex + 1, "X-WR-CALNAME은 PRODID 바로 다음");
assert.equal(calScaleIndex, calNameIndex + 1, "CALSCALE은 X-WR-CALNAME 다음");

// 미지정 출력은 옵션 인자를 빈 객체로 줘도 기존과 바이트 동일
const withEmptyOptions = renderIcsCalendar(
  { productId: "-//Cunote//Test//KO", generatedAt, events: [baseEvent()] },
  {},
);
assert.equal(withEmptyOptions, basic, "빈 옵션은 기존 출력과 바이트 동일");

// 잘못된 날짜 → IcsDateError
assert.throws(
  () =>
    renderIcsCalendar({
      productId: "-//Cunote//Test//KO",
      generatedAt,
      events: [baseEvent({ date: "not-a-date" })],
    }),
  (error: unknown) => error instanceof IcsDateError && /올바르지 않습니다/.test((error as Error).message),
);

console.log("calendar-ics: ok");
