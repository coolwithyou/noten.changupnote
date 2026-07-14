/**
 * iCalendar(.ics) 렌더링 공용 유틸 — 서버 전용 순수 함수.
 *
 * RFC 5545 최소 부분집합(VCALENDAR/VEVENT, VALUE=DATE 종일 일정)만 다룬다.
 * 값 이스케이프·74옥텟 폴딩·CRLF 종결 등 렌더링 규약을 한곳에 모아 신청 캘린더와
 * 비로그인 공개 캘린더가 동일한 출력 형식을 공유하도록 한다. 특정 도메인(신청/공고)
 * 지식은 두지 않는다 — 호출자가 이벤트를 구성해 넘긴다.
 */

export interface CalendarIcsEvent {
  uid: string;
  date: string;
  summary: string;
  description: string;
  url: string | null;
}

// 날짜 문자열이 잘못됐을 때 던진다. 도메인 에러(ApplicationCalendarError 등)에
// 의존하지 않기 위해 자체 에러 타입을 두고, 호출자가 필요하면 재래핑한다.
export class IcsDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsDateError";
  }
}

export function renderIcsCalendar(
  input: {
    productId: string;
    generatedAt: Date;
    events: CalendarIcsEvent[];
  },
  options?: { calendarName?: string },
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${input.productId}`,
    ...(options?.calendarName ? [`X-WR-CALNAME:${options.calendarName}`] : []),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...input.events.flatMap((event) => renderIcsEvent(event, input.generatedAt)),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function renderIcsEvent(event: CalendarIcsEvent, generatedAt: Date): string[] {
  const date = toIcsDate(event.date);
  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${toIcsDateTime(generatedAt)}`,
    `DTSTART;VALUE=DATE:${date}`,
    `DTEND;VALUE=DATE:${nextIcsDate(event.date)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    ...(event.url ? [`URL:${escapeIcsText(event.url)}`] : []),
    "END:VEVENT",
  ];
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function toIcsDate(value: string): string {
  const normalized = dateString(value);
  if (!normalized) {
    throw new IcsDateError("캘린더 날짜가 올바르지 않습니다.");
  }
  return normalized.replaceAll("-", "");
}

export function nextIcsDate(value: string): string {
  const normalized = dateString(value);
  if (!normalized) {
    throw new IcsDateError("캘린더 날짜가 올바르지 않습니다.");
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function toIcsDateTime(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function foldIcsLine(value: string): string {
  if (value.length <= 74) return value;
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > 74) {
    chunks.push(remaining.slice(0, 74));
    remaining = ` ${remaining.slice(74)}`;
  }
  chunks.push(remaining);
  return chunks.join("\r\n");
}

export function stableId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "grant";
}
