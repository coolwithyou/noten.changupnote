// 딥분석 실행 코어 — 모집기간 판정의 단일 원천.
// "AI 분석 대상 = 모집기간에 오늘(KST)이 포함된 공고"를 서버(코호트 선정·배치 가드)와
// UI(기간 미상 배지·기간 입력)가 같은 규칙으로 판정하도록 순수 함수만 둔다(DB·React 무의존).
//
// 날짜 규약(중요 — 타임존 함정):
// grants.applyStart/applyEnd 는 timestamptz 지만, 수집 파이프라인(normalizedGrantPublisher
// dateValue)은 "YYYY-MM-DD" 를 UTC 자정으로 저장하고, 제품의 활성 판정
// (repositories/activeGrantFilter.activeGrantApplyEndCutoff)은 "KST 캘린더 오늘의 UTC 자정"과
// 비교한다. 즉 저장값의 UTC 날짜 문자열이 곧 KST 캘린더 날짜다. 여기서도 같은 규약을 따른다 —
// 사용자 입력 날짜를 KST 캘린더 날짜로 해석하되, 저장은 그 날짜의 UTC 자정으로 한다
// (KST 자정 순간(전날 15:00Z)으로 저장하면 .toISOString().slice(0,10) 계열 판독이 하루 밀린다).

export type NoticePeriodStatus =
  /** 모집기간에 오늘(KST)이 포함 — AI 분석 대상. */
  | "eligible"
  /** applyStart 가 미래 — 조용히 제외(예외 큐 아님). */
  | "not_started"
  /** applyEnd 가 과거 — 조용히 제외(예외 큐 아님). */
  | "closed"
  /** applyEnd null(기간을 찾지 못함) — 사용자가 감사로 기간을 특정해야 하는 예외 큐. */
  | "unknown";

const DAY_MS = 24 * 60 * 60 * 1000;
/** KST 는 DST 없는 고정 +09:00 — Intl 없이 산술로 안전하다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * now 가 속한 KST 캘린더 날짜의 "UTC 자정" 시각.
 * activeGrantFilter.activeGrantApplyEndCutoff 와 동일 의미(중복 구현 이유: 저 모듈은
 * lib/server 소속이라 클라이언트 컴포넌트에서 가져올 수 없다).
 */
export function kstDayStartUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
}

function toDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 모집기간 4분면 판정. 날짜 규약(위 헤더) 때문에 "오늘 포함" 판정은 순간 비교가 아니라
 * KST 캘린더 일 단위 비교다:
 * - 마감: applyEnd < 오늘(KST) 시작 → 마감일의 UTC 자정 저장값은 마감 당일 내내 eligible.
 * - 시작 전: applyStart ≥ 내일(KST) 시작 → 시작일 당일부터 eligible.
 * - applyEnd 를 파싱할 수 없는 값도 unknown(예외 큐)으로 취급한다(안전측).
 */
export function classifyNoticePeriod(
  applyStart: string | Date | null,
  applyEnd: string | Date | null,
  now: Date = new Date(),
): NoticePeriodStatus {
  const end = toDate(applyEnd);
  if (end === null) return "unknown";
  const dayStart = kstDayStartUtc(now);
  if (end.getTime() < dayStart.getTime()) return "closed";
  const start = toDate(applyStart);
  if (start !== null && start.getTime() >= dayStart.getTime() + DAY_MS) return "not_started";
  return "eligible";
}

/**
 * 현재 지원 가능한 공고인지 보는 promotion용 기간 판정.
 *
 * 기간 null은 기존 상시/미지정 공고 정책대로 열어 두되, 존재하는 날짜가 잘못됐거나
 * 시작일이 마감일보다 늦으면 fail-closed한다. 날짜 경계는 classifyNoticePeriod와 같은
 * KST 캘린더 일 규약을 사용해 시작일·마감일 당일을 모두 포함한다.
 * string/Date는 이 모듈 헤더의 저장 계약대로 각각 YYYY-MM-DD 또는 그 달력일의 UTC 자정만
 * 허용한다. 타임존이 붙은 임의 시각을 암묵적으로 다른 달력일로 바꾸지 않는다.
 */
export function isNoticeApplicationOpen(
  applyStart: string | Date | null,
  applyEnd: string | Date | null,
  now: Date = new Date(),
): boolean {
  const start = parseOptionalNoticeDate(applyStart);
  const end = parseOptionalNoticeDate(applyEnd);
  if (!start.valid || !end.valid) return false;
  if (start.value && end.value && start.value.getTime() > end.value.getTime()) return false;

  const dayStartMs = kstDayStartUtc(now).getTime();
  if (!Number.isFinite(dayStartMs)) return false;
  if (start.value && start.value.getTime() >= dayStartMs + DAY_MS) return false;
  if (end.value && end.value.getTime() < dayStartMs) return false;
  return true;
}

function parseOptionalNoticeDate(
  value: string | Date | null,
): { valid: boolean; value: Date | null } {
  if (value === null) return { valid: true, value: null };
  if (typeof value === "string") {
    const storedDate = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/u.exec(value);
    const date = storedDate ? parseDateInputToUtc(storedDate[1]!) : null;
    return date
      ? { valid: true, value: date }
      : { valid: false, value: null };
  }
  if (
    !Number.isFinite(value.getTime())
    || value.getUTCHours() !== 0
    || value.getUTCMinutes() !== 0
    || value.getUTCSeconds() !== 0
    || value.getUTCMilliseconds() !== 0
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "YYYY-MM-DD" 입력(KST 캘린더 날짜)을 저장 규약(그 날짜의 UTC 자정)으로 파싱한다.
 * 형식 불일치·존재하지 않는 날짜(예: 2026-02-30)는 null.
 */
export function parseDateInputToUtc(value: string): Date | null {
  if (!DATE_INPUT_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC 는 2026-02-30 → 03-02 로 굴려버린다 — 왕복 검증으로 거른다.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
