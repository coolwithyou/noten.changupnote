/**
 * 플랜 구독(subscription) 도메인 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/credits/subscriptions.test.ts
 *
 * 커버(설계 8장):
 *   - nextPeriodEnd 월 산술(1/31 → 2월 클램프 포함)
 *   - planGrantExpiry cycles=2(60일) / flex=3(90일)
 *   - planGrantExpiryCycles: flex → flexValue, 그 외 → value
 *   - retryScheduleDelayDays: retryCount 0→1, 1→3, 2→null(소진)
 *   - idempotencyKeys.plan(orderId) 형식이 `plan:{orderId}` 인지(4.3 / 레드팀 B1)
 */
import assert from "node:assert/strict";
import {
  CYCLE_DAYS,
  nextPeriodEnd,
  planGrantExpiry,
  planGrantExpiryCycles,
  retryScheduleDelayDays,
} from "./subscriptions.js";
import { idempotencyKeys } from "./ledger.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const d = (iso: string) => new Date(iso);
const DAY_MS = 24 * 60 * 60 * 1000;

// ── nextPeriodEnd (8.2) ────────────────────────────────────────────────

check("nextPeriodEnd: 월 중간 날짜는 다음 달 같은 날", () => {
  assert.equal(nextPeriodEnd(d("2026-07-10T00:00:00.000Z")).toISOString(), "2026-08-10T00:00:00.000Z");
});

check("nextPeriodEnd: 시각(HH:MM:SS)을 보존한다", () => {
  assert.equal(nextPeriodEnd(d("2026-03-15T09:30:45.000Z")).toISOString(), "2026-04-15T09:30:45.000Z");
});

check("nextPeriodEnd: 1/31 → 2/28 클램프(2026 평년)", () => {
  assert.equal(nextPeriodEnd(d("2026-01-31T00:00:00.000Z")).toISOString(), "2026-02-28T00:00:00.000Z");
});

check("nextPeriodEnd: 1/31 → 2/29 클램프(2028 윤년)", () => {
  assert.equal(nextPeriodEnd(d("2028-01-31T00:00:00.000Z")).toISOString(), "2028-02-29T00:00:00.000Z");
});

check("nextPeriodEnd: 12월 → 다음 해 1월(연도 넘김)", () => {
  assert.equal(nextPeriodEnd(d("2026-12-31T00:00:00.000Z")).toISOString(), "2027-01-31T00:00:00.000Z");
});

check("nextPeriodEnd: 3/31 → 4/30 클램프(30일 달)", () => {
  assert.equal(nextPeriodEnd(d("2026-03-31T00:00:00.000Z")).toISOString(), "2026-04-30T00:00:00.000Z");
});

// ── planGrantExpiry (4.2.1) ────────────────────────────────────────────

check("planGrantExpiry: cycles=2 → 지급 + 60일", () => {
  const granted = d("2026-07-10T00:00:00.000Z");
  const expiry = planGrantExpiry(granted, 2);
  assert.equal(expiry.getTime() - granted.getTime(), 60 * DAY_MS);
  assert.equal(expiry.toISOString(), "2026-09-08T00:00:00.000Z");
});

check("planGrantExpiry: flex cycles=3 → 지급 + 90일", () => {
  const granted = d("2026-07-10T00:00:00.000Z");
  const expiry = planGrantExpiry(granted, 3);
  assert.equal(expiry.getTime() - granted.getTime(), 90 * DAY_MS);
});

check("CYCLE_DAYS 는 30(60일=2주기, 90일=3주기의 근거)", () => {
  assert.equal(CYCLE_DAYS, 30);
});

check("planGrantExpiry: 0 이하 주기 수는 예외", () => {
  assert.throws(() => planGrantExpiry(d("2026-07-10T00:00:00.000Z"), 0), /양수/);
  assert.throws(() => planGrantExpiry(d("2026-07-10T00:00:00.000Z"), -1), /양수/);
});

// ── planGrantExpiryCycles (4.2.1) ──────────────────────────────────────

check("planGrantExpiryCycles: flex → flexValue(3), 그 외 → value(2)", () => {
  const settings = { value: 2, flexValue: 3 };
  assert.equal(planGrantExpiryCycles("flex", settings), 3);
  assert.equal(planGrantExpiryCycles("plus", settings), 2);
  assert.equal(planGrantExpiryCycles("pro", settings), 2);
  // 대소문자 무시(정확 일치는 소문자 flex).
  assert.equal(planGrantExpiryCycles("FLEX", settings), 3);
});

// ── retryScheduleDelayDays (8.4) ───────────────────────────────────────

check("retryScheduleDelayDays: [1,3] 스케줄에서 0→1, 1→3, 2→null(소진)", () => {
  const schedule = [1, 3];
  assert.equal(retryScheduleDelayDays(0, schedule), 1); // 첫 재시도 D+1
  assert.equal(retryScheduleDelayDays(1, schedule), 3); // 두 번째 재시도 D+3
  assert.equal(retryScheduleDelayDays(2, schedule), null); // 소진 → expired
  assert.equal(retryScheduleDelayDays(3, schedule), null);
});

check("retryScheduleDelayDays: 음수·비정수 retryCount 는 예외", () => {
  assert.throws(() => retryScheduleDelayDays(-1, [1, 3]), /정수/);
  assert.throws(() => retryScheduleDelayDays(1.5, [1, 3]), /정수/);
});

// ── plan 멱등 키 (4.3 / 레드팀 B1) ──────────────────────────────────────

check("plan 멱등 키는 plan:{orderId}(주문과 1:1, subId/period 아님)", () => {
  assert.equal(idempotencyKeys.plan("order-abc"), "plan:order-abc");
  // 초기 지급·갱신 지급 모두 각자의 주문 id 로 유일 키를 만든다.
  assert.notEqual(idempotencyKeys.plan("order-initial"), idempotencyKeys.plan("order-renewal"));
});

console.log(JSON.stringify({ ok: true, suite: "credits/subscriptions", passed }, null, 2));
