/**
 * 플랜 구독(subscription) 도메인 규칙 — 순수 함수 (P4-A, 설계 8장).
 *
 * ★ 규범: DB·IO 미의존. 주기·만료·재시도 스케줄 계산만 제공하고,
 *   실제 트랜잭션 집행(plan_grant·상태 전이)은 Drizzle 리포지토리가 한다.
 *
 * 설계 참조:
 *   - 8.2 구독 시작: period = now ~ now+1개월
 *   - 4.2.1 plan_grant 만료: 지급 + 2주기(60일), flex 는 + 3주기(90일). 1주기 = 30일.
 *   - 8.4 갱신 실패 재시도: plan_retry_schedule_days = [1, 3] (D+1, D+3). 한 번에 예약 1개만.
 *   - 멱등 키는 ledger.ts 의 idempotencyKeys.plan(orderId) = `plan:{orderId}` 재사용(4.3 / 레드팀 B1).
 */

/** 1주기 = 30일(plan_grant 만료 회계용, 4.2.1). 60일=2주기, 90일=3주기. */
export const CYCLE_DAYS = 30;

/**
 * 다음 주기 종료일(8.2): start + 1개월(캘린더 월).
 *
 * 월말 클램핑: setMonth(+1)이 다음 달에 같은 일자가 없으면 다음 달로 넘어가므로
 * (예: 1/31 → setMonth(1) 은 3/2 또는 3/3), 대상 월의 마지막 날로 클램프한다(1/31 → 2/28|29).
 * 이는 결제 청구일이 "그 다음 다음 달"로 밀리는 것을 막는 정기결제 관례를 따른다.
 */
export function nextPeriodEnd(start: Date): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  // 대상 월(=start 월 + 1)의 마지막 일. day 0 of month (m+2) = last day of month (m+1).
  const lastDayOfTargetMonth = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDayOfTargetMonth);
  const result = new Date(start.getTime());
  result.setUTCFullYear(y, m + 1, clampedDay);
  return result;
}

/**
 * plan_grant lot 의 만료일(4.2.1): grantedAt + cycles × 30일.
 * cycles=2 → 60일, cycles=3(flex) → 90일.
 */
export function planGrantExpiry(grantedAt: Date, cycles: number): Date {
  if (!Number.isFinite(cycles) || cycles <= 0) {
    throw new Error(`plan_grant 만료 주기 수는 양수여야 합니다: ${cycles}`);
  }
  return new Date(grantedAt.getTime() + cycles * CYCLE_DAYS * 24 * 60 * 60 * 1000);
}

/** credit_settings.plan_grant_expiry_cycles = { value: 2, flexValue: 3 }. */
export interface PlanGrantExpiryCycleSettings {
  value: number;
  flexValue: number;
}

/**
 * 플랜 코드에 따른 만료 주기 수(4.2.1): flex → flexValue, 그 외 → value.
 * planCode 비교는 소문자 "flex" 정확 일치.
 */
export function planGrantExpiryCycles(
  planCode: string,
  settings: PlanGrantExpiryCycleSettings,
): number {
  return planCode.toLowerCase() === "flex" ? settings.flexValue : settings.value;
}

/**
 * 갱신 실패 재시도 지연(8.4): schedule = [1, 3] (D+1, D+3). 한 번에 예약 1개만.
 *
 * @param retryCount 현재까지 실패한 재시도 횟수. 0 이면 아직 재시도 없음.
 * @param schedule   plan_retry_schedule_days (기본 [1, 3]).
 * @returns 다음 재시도까지의 지연 일수. 소진(retryCount >= schedule.length)이면 null(→ expired).
 *
 * 흐름:
 *   retryCount=0 → 다음 시도는 D+1 (schedule[0])
 *   그것도 실패(retryCount=1) → D+3 (schedule[1])
 *   retryCount>=2 → null (재시도 소진 → status=expired, 8.4)
 */
export function retryScheduleDelayDays(retryCount: number, schedule: readonly number[]): number | null {
  if (retryCount < 0 || !Number.isInteger(retryCount)) {
    throw new Error(`retryCount 는 0 이상의 정수여야 합니다: ${retryCount}`);
  }
  if (retryCount >= schedule.length) return null;
  return schedule[retryCount]!;
}
