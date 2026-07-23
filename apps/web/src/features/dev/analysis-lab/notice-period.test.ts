// 모집기간 정책(2026-07-23) 순수 함수 단위 테스트 — DB·네트워크 미사용.
// 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/features/dev/analysis-lab/notice-period.test.ts
// 검증: 4분면(기간 포함/시작 전/마감/미상) + KST 캘린더 일 경계(마감 당일·시작 당일·자정 직전) +
// 날짜 입력 파싱(형식·실존 날짜·UTC 자정 저장 규약).
import assert from "node:assert/strict";
import { classifyNoticePeriod, kstDayStartUtc, parseDateInputToUtc } from "./notice-period";

// ── kstDayStartUtc ───────────────────────────────────────────────
// 2026-07-23T20:00Z 는 KST 로 07-24 05:00 — KST 캘린더 날짜는 07-24.
assert.equal(
  kstDayStartUtc(new Date("2026-07-23T20:00:00.000Z")).toISOString(),
  "2026-07-24T00:00:00.000Z",
);
// 2026-07-23T10:00Z 는 KST 로 07-23 19:00 — 같은 날.
assert.equal(
  kstDayStartUtc(new Date("2026-07-23T10:00:00.000Z")).toISOString(),
  "2026-07-23T00:00:00.000Z",
);
// KST 자정 정각(전날 15:00Z) — 그 순간부터 새 날.
assert.equal(
  kstDayStartUtc(new Date("2026-07-22T15:00:00.000Z")).toISOString(),
  "2026-07-23T00:00:00.000Z",
);

// ── classifyNoticePeriod: 4분면 ──────────────────────────────────
// now: KST 2026-07-23 정오(03:00Z). 저장 규약(수집 파이프라인)대로 날짜는 UTC 자정 문자열.
const now = new Date("2026-07-23T03:00:00.000Z");

// ① 기간 포함(시작 과거·마감 미래) → eligible.
assert.equal(classifyNoticePeriod("2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now), "eligible");
// applyStart null 도 "시작됨" 취급 → eligible.
assert.equal(classifyNoticePeriod(null, "2026-08-01T00:00:00.000Z", now), "eligible");

// ② 시작 전(applyStart 미래) → not_started (조용한 제외 — 예외 큐 아님).
assert.equal(classifyNoticePeriod("2026-07-24T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now), "not_started");

// ③ 마감(applyEnd 과거) → closed (조용한 제외 — 예외 큐 아님).
assert.equal(classifyNoticePeriod("2026-06-01T00:00:00.000Z", "2026-07-22T00:00:00.000Z", now), "closed");

// ④ 기간 미상(applyEnd null) → unknown (예외 큐 — 감사로 기간 특정 필요).
assert.equal(classifyNoticePeriod(null, null, now), "unknown");
assert.equal(classifyNoticePeriod("2026-07-01T00:00:00.000Z", null, now), "unknown");
// 파싱 불가 applyEnd 도 안전측으로 unknown.
assert.equal(classifyNoticePeriod(null, "not-a-date", now), "unknown");

// ── KST 캘린더 일 경계 ───────────────────────────────────────────
// 마감일 == 오늘(KST): UTC 자정 저장값이라도 마감 당일 내내 eligible 이어야 한다.
assert.equal(classifyNoticePeriod(null, "2026-07-23T00:00:00.000Z", now), "eligible");
// KST 07-23 밤 11시(14:00Z)에도 여전히 eligible — 순간 비교였다면 closed 로 오판됐을 케이스.
assert.equal(
  classifyNoticePeriod(null, "2026-07-23T00:00:00.000Z", new Date("2026-07-23T14:00:00.000Z")),
  "eligible",
);
// KST 자정을 넘기면(07-24 00:00 KST == 07-23 15:00Z) closed.
assert.equal(
  classifyNoticePeriod(null, "2026-07-23T00:00:00.000Z", new Date("2026-07-23T15:00:00.000Z")),
  "closed",
);
// 시작일 == 오늘(KST) → 당일부터 eligible.
assert.equal(classifyNoticePeriod("2026-07-23T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now), "eligible");
// UTC 로는 아직 07-22 저녁이지만 KST 로는 이미 07-23 인 시각 — KST 기준으로 eligible.
assert.equal(
  classifyNoticePeriod("2026-07-23T00:00:00.000Z", "2026-08-01T00:00:00.000Z", new Date("2026-07-22T16:00:00.000Z")),
  "eligible",
);

// ── parseDateInputToUtc: 저장 규약(캘린더 날짜의 UTC 자정) ────────
assert.equal(parseDateInputToUtc("2026-07-30")?.toISOString(), "2026-07-30T00:00:00.000Z");
// 저장값의 UTC 날짜 문자열이 입력 캘린더 날짜와 같아야 한다(.slice(0,10) 판독 규약).
assert.equal(parseDateInputToUtc("2026-07-30")?.toISOString().slice(0, 10), "2026-07-30");
// 형식 불일치.
assert.equal(parseDateInputToUtc("2026/07/30"), null);
assert.equal(parseDateInputToUtc("20260730"), null);
assert.equal(parseDateInputToUtc(""), null);
// 실존하지 않는 날짜(Date.UTC 롤오버 차단).
assert.equal(parseDateInputToUtc("2026-02-30"), null);
assert.equal(parseDateInputToUtc("2026-13-01"), null);
// 윤년은 실존 — 2028-02-29 통과.
assert.equal(parseDateInputToUtc("2028-02-29")?.toISOString(), "2028-02-29T00:00:00.000Z");

console.log("notice-period.test.ts: all assertions passed");
