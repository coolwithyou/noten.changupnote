/**
 * 신청 캘린더 날짜 공용 유틸 — 서버·클라이언트 공용 (KST 기준 순수 함수만).
 *
 * "use client" 지시어 없이 순수 함수만 둔다 (React/DOM/서버 의존 없음). 덕분에
 * 서버 컴포넌트·라우트 핸들러·비로그인 공개 캘린더와 클라이언트 뷰가 동일한
 * 월 그리드 계산과 날짜 포맷을 공유한다. 날짜 경계는 한국 시간(Asia/Seoul)을
 * 기준으로 판정하고, "YYYY-MM-DD"/"YYYY-MM" 문자열 키를 단일 원천으로 삼는다.
 */

const KOREA_TIME_ZONE = "Asia/Seoul";

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function indexEventsByDate<T extends { date: string }>(events: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const event of events) {
    const current = index.get(event.date) ?? [];
    current.push(event);
    index.set(event.date, current);
  }
  return index;
}

export function calendarDays(month: Date): Array<{ date: string; dayOfMonth: number; weekday: number } | null> {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells: Array<{ date: string; dayOfMonth: number; weekday: number } | null> = [];
  for (let index = 0; index < firstWeekday; index += 1) cells.push(null);
  for (let day = 1; day <= dayCount; day += 1) {
    const date = new Date(Date.UTC(year, monthIndex, day));
    cells.push({ date: date.toISOString().slice(0, 10), dayOfMonth: day, weekday: date.getUTCDay() });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function monthStart(value: string): Date {
  const parts = koreaDateParts(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, 1));
}

export function addMonths(value: Date, amount: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + amount, 1));
}

export function dateKey(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = koreaDateParts(date);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function calendarDday(eventDateKey: string, todayKey: string): number | null {
  const eventDate = dateKeyToUtcDate(eventDateKey);
  const today = dateKeyToUtcDate(todayKey);
  if (!eventDate || !today) return null;
  return Math.round((eventDate.getTime() - today.getTime()) / 86_400_000);
}

export function dateKeyToUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function formatMonth(value: Date): string {
  return `${value.getUTCFullYear()}년 ${value.getUTCMonth() + 1}월`;
}

export function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function koreaDateParts(value: string | Date): { year: number; month: number; day: number } {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const read = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}

// KST 기준 "YYYY-MM" 월 키 — 공개 캘린더의 월 단위 라우팅/조회에 쓴다.
export function monthKey(date: Date): string {
  const parts = koreaDateParts(date);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}`;
}

// "YYYY-MM" 문자열을 검증해 파싱한다. 형식·월 범위(1~12)가 어긋나면 null.
export function parseMonthKey(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}
