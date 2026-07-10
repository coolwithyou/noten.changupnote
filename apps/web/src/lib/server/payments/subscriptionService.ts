/**
 * 플랜 구독 오케스트레이션 (설계 8.2 시작 / 8.3 갱신 / 8.4 갱신실패 / 8.5 변경).
 *
 * ★ 세션 없는 시스템 경로 오케스트레이션 함수 모음(paymentService.ts 와 동형).
 *   각 함수는 deps 를 받아 리포지토리·포트원을 통해서만 동작한다. 소유권 검증(session.userId)은
 *   라우트 계층이 수행하고, 이 서비스는 userId 를 신뢰 입력으로 받는다(레드팀 M2).
 *
 * ★ 불변식 (3.1 / 8.5 레드팀 B2 — BLOCKER): 모든 구독 상태 전이의 첫 단계는
 *   "이 구독의 미소진 포트원 예약 전부 취소"(cancelAllSchedules)다. 업그레이드·다운그레이드·
 *   past_due 진입/이탈·해지·강제해지·빌링키 교체 모두 이 규약을 따른다. 취소 성공을 확인한 뒤
 *   다음 단계로 진행하고, 선생성 예약 주문(created)은 expired 처리한다.
 *
 * ★ 지급/원장은 오직 Phase-A 리포지토리 메서드(activate/renew/upgradeSubscriptionWithGrant)로만
 *   집행한다 — wallet/lot/ledger 를 직접 만지지 않는다. 멱등은 plan:{orderId}(주문별, 레드팀 B1).
 */
import {
  paymentIdForOrder,
  planGrantExpiry,
  planGrantExpiryCycles,
  retryScheduleDelayDays,
  nextPeriodEnd,
  type CreditPaymentRepository,
  type CreditSubscriptionRecord,
  type CreditSubscriptionRepository,
  type CreditSystemRepository,
} from "@cunote/core";
import type { PortoneClient } from "./portone";

// ── 설정 fallback (4.7) ────────────────────────────────────────────────────
const PLAN_GRANT_EXPIRY_CYCLES_FALLBACK = { value: 2, flexValue: 3 } as const;
const PLAN_RETRY_SCHEDULE_DAYS_FALLBACK = [1, 3] as const;
const KRW_PER_CREDIT_FALLBACK = 1;
const ORDER_TTL_MINUTES_FALLBACK = 90;

export interface SubscriptionServiceDeps {
  subscription: CreditSubscriptionRepository;
  payment: CreditPaymentRepository;
  system: CreditSystemRepository;
  portone: PortoneClient;
  now?: () => Date;
}

// ── 설정 읽기 헬퍼 (객체값 설정 해소) ───────────────────────────────────────

/**
 * plan_grant_expiry_cycles = { value: 2, flexValue: 3 } (객체값 설정).
 * readNumericSetting 은 .value(숫자)만 읽으므로 flexValue 를 얻으려면 raw jsonb 를 읽는다(readJsonSetting).
 */
async function readPlanGrantCycles(
  system: CreditSystemRepository,
): Promise<{ value: number; flexValue: number }> {
  const raw = await system.readJsonSetting("plan_grant_expiry_cycles");
  const value = typeof raw?.value === "number" && Number.isFinite(raw.value)
    ? raw.value
    : PLAN_GRANT_EXPIRY_CYCLES_FALLBACK.value;
  const flexValue = typeof raw?.flexValue === "number" && Number.isFinite(raw.flexValue)
    ? raw.flexValue
    : PLAN_GRANT_EXPIRY_CYCLES_FALLBACK.flexValue;
  return { value, flexValue };
}

/** plan_retry_schedule_days = { value: [1, 3] } (배열 설정). raw 로 읽고, 부재/오형이면 [1,3]. */
async function readRetryScheduleDays(system: CreditSystemRepository): Promise<number[]> {
  const raw = await system.readJsonSetting("plan_retry_schedule_days");
  const arr = raw?.value;
  if (Array.isArray(arr) && arr.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) {
    return arr as number[];
  }
  return [...PLAN_RETRY_SCHEDULE_DAYS_FALLBACK];
}

/** 플랜 코드별 lot 만료(4.2.1): planGrantExpiry(grantedAt, cyclesForPlan). */
async function computeLotExpiry(
  system: CreditSystemRepository,
  planCode: string,
  grantedAt: Date,
): Promise<Date> {
  const cyclesSetting = await readPlanGrantCycles(system);
  const cycles = planGrantExpiryCycles(planCode, cyclesSetting);
  return planGrantExpiry(grantedAt, cycles);
}

// ── 공통: 예약 취소(모든 전이의 첫 단계, 레드팀 B2) ─────────────────────────

/**
 * ★ 모든 상태 전이의 첫 단계(3.1 / 8.5 레드팀 B2):
 *   1. 이 구독의 미소진 포트원 예약 전부 취소(billingKey 기준 + 알려진 scheduleId 지정).
 *   2. 선생성 예약 주문(created)을 expired 처리(고아 주문 정리).
 *   3. 구독의 nextScheduleId/nextSchedulePaymentId 를 null 로.
 * 취소 성공을 확인한 뒤에만 다음 단계로 진행한다(포트원 예외는 상위로 전파 — 전이 중단).
 *
 * @param billingKey 예약 취소에 사용할 키. 빌링키 교체 시 "구 키"를 명시 전달한다.
 */
async function cancelAllSchedules(
  sub: CreditSubscriptionRecord,
  deps: SubscriptionServiceDeps,
  billingKey: string = sub.billingKey,
): Promise<void> {
  // billingKey 기준으로 전부 취소하고, 알려진 scheduleId 도 명시 지정(이중 안전).
  await deps.portone.cancelSchedules(
    sub.nextScheduleId ? { billingKey, scheduleIds: [sub.nextScheduleId] } : { billingKey },
  );
  // 선생성 예약 주문(created) 정리.
  await deps.subscription.expireCreatedOrdersForSubscription(sub.id);
  // 구독 예약 컬럼 해제.
  await deps.subscription.updateSchedule({
    subscriptionId: sub.id,
    nextScheduleId: null,
    nextSchedulePaymentId: null,
  });
}

// ── 공통: 다음 주기 예약 등록(레드팀 B2 — 주문 선생성 후 schedulePayment) ────

/**
 * 8.2 step 5 / 8.3 재예약 / 8.5: 다음 주기 예약을 등록한다.
 *   1. plan_renewal 주문을 status=created 로 선생성(NEW paymentId).
 *   2. portone.schedulePayment(timeToPay=timeToPay).
 *   3. updateSchedule(nextScheduleId, nextSchedulePaymentId).
 *
 * @param amountKrw    예약 결제 금액(다운그레이드 재예약은 하위 플랜 금액).
 * @param creditsToGrant 예약 결제 지급 예정 크레딧(주문 스냅샷).
 * @param timeToPay    예약 실행 시각(보통 periodEnd, 재시도는 now+delay).
 */
async function registerSchedule(
  sub: CreditSubscriptionRecord,
  planName: string,
  amountKrw: number,
  creditsToGrant: number,
  timeToPay: Date,
  deps: SubscriptionServiceDeps,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const krwPerCredit = await deps.system.readNumericSetting("krw_per_credit", KRW_PER_CREDIT_FALLBACK);
  const ttlMinutes = await deps.system.readNumericSetting("payment_order_ttl_minutes", ORDER_TTL_MINUTES_FALLBACK);

  const orderId = crypto.randomUUID();
  const paymentId = paymentIdForOrder(orderId);
  // 예약 주문 만료: 실행 시각 + TTL(실행 전 만료 방지). 실행 시각이 미래이므로 여유를 둔다.
  const expiresAt = new Date(Math.max(timeToPay.getTime(), now.getTime()) + ttlMinutes * 60 * 1000);

  await deps.subscription.createPlanOrder({
    id: orderId,
    paymentId,
    walletId: sub.walletId,
    userId: sub.userId,
    planSubscriptionId: sub.id,
    orderType: "plan_renewal",
    amountKrw,
    creditsToGrant,
    krwPerCreditSnapshot: krwPerCredit,
    expiresAt,
  });

  const { scheduleId } = await deps.portone.schedulePayment({
    paymentId,
    billingKey: sub.billingKey,
    orderName: planName,
    amount: amountKrw,
    customerId: sub.userId,
    timeToPay: timeToPay.toISOString(),
    idempotencyKey: paymentId,
  });

  await deps.subscription.updateSchedule({
    subscriptionId: sub.id,
    nextScheduleId: scheduleId,
    nextSchedulePaymentId: paymentId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// startSubscription (8.2)
// ─────────────────────────────────────────────────────────────────────────────

export type StartSubscriptionOutcome =
  | { kind: "conflict" }
  | { kind: "mismatch" }
  | { kind: "payment_failed"; reason: string }
  | { kind: "active"; subscription: CreditSubscriptionRecord; grantedCredits: number };

export interface StartSubscriptionInput {
  userId: string;
  wallet: { id: string };
  planCode: string;
  billingKey: string;
  cardSummary?: { brand?: string; last4?: string } | null;
}

/** 8.2 구독 시작 전체 시퀀스. */
export async function startSubscription(
  input: StartSubscriptionInput,
  deps: SubscriptionServiceDeps,
): Promise<StartSubscriptionOutcome> {
  const now = deps.now?.() ?? new Date();

  // 1. 기존 active/past_due 구독 있으면 409(변경은 8.5 경로).
  const existing = await deps.subscription.getActiveOrPastDueForUser(input.userId);
  if (existing) return { kind: "conflict" };

  // 플랜 조회.
  const plan = await deps.subscription.getPlanByCode(input.planCode);
  if (!plan) return { kind: "payment_failed", reason: "존재하지 않는 플랜입니다." };

  // 2. incomplete 구독 upsert(period 는 임시 — PAID 확정 시 재확정). 기존 incomplete 재사용.
  const periodStart = now;
  const periodEnd = nextPeriodEnd(now);
  const sub = await deps.subscription.upsertIncompleteSubscription({
    userId: input.userId,
    walletId: input.wallet.id,
    planId: plan.id,
    billingKey: input.billingKey,
    billingKeyIssuedAt: now,
    cardSummary: input.cardSummary ?? null,
    periodStart,
    periodEnd,
  });

  // 3. 첫 결제: plan_initial 주문 선생성 → 빌링키 즉시결제.
  const krwPerCredit = await deps.system.readNumericSetting("krw_per_credit", KRW_PER_CREDIT_FALLBACK);
  const ttlMinutes = await deps.system.readNumericSetting("payment_order_ttl_minutes", ORDER_TTL_MINUTES_FALLBACK);
  const orderId = crypto.randomUUID();
  const paymentId = paymentIdForOrder(orderId);
  await deps.subscription.createPlanOrder({
    id: orderId,
    paymentId,
    walletId: input.wallet.id,
    userId: input.userId,
    planSubscriptionId: sub.id,
    orderType: "plan_initial",
    amountKrw: plan.monthlyPriceKrw,
    creditsToGrant: plan.monthlyCredits,
    krwPerCreditSnapshot: krwPerCredit,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
  });

  const payment = await deps.portone.payWithBillingKey({
    paymentId,
    billingKey: input.billingKey,
    orderName: plan.name,
    amount: plan.monthlyPriceKrw,
    customerId: input.userId,
    idempotencyKey: paymentId,
  });

  // 4. PAID 분기.
  if (payment.status !== "PAID") {
    // 비-PAID → incomplete 유지 + 주문 failed. 지급·예약 없음.
    const reason = payment.failureReason ?? `결제 미완(${payment.status})`;
    await deps.payment.markOrderFailed({ orderId, reason, portoneStatus: payment.status });
    return { kind: "payment_failed", reason };
  }

  // 금액·통화 대조(레드팀 M2). 불일치 → 주문 failed(mismatch).
  const total = payment.amount?.total ?? -1;
  if (total !== plan.monthlyPriceKrw || payment.currency !== "KRW") {
    await deps.payment.markOrderMismatch({
      orderId,
      portoneStatus: payment.status,
      detail: {
        expectedAmount: plan.monthlyPriceKrw,
        actualAmount: total,
        expectedCurrency: "KRW",
        actualCurrency: payment.currency,
      },
    });
    return { kind: "mismatch" };
  }

  // 활성화 + 지급(멱등 plan:{orderId}). lot 만료 = planGrantExpiry(now, cyclesForPlan).
  const lotExpiresAt = await computeLotExpiry(deps.system, plan.code, now);
  const activated = await deps.subscription.activateSubscriptionWithGrant({
    subscriptionId: sub.id,
    orderId,
    periodStart,
    periodEnd,
    monthlyCredits: plan.monthlyCredits,
    lotExpiresAt,
    portone: { status: payment.status, txId: payment.transactionId, payMethod: payment.payMethod },
  });

  // 5. 다음 주기 예약 등록(주문 선생성 → schedulePayment → updateSchedule).
  await registerSchedule(
    activated.subscription,
    plan.name,
    plan.monthlyPriceKrw,
    plan.monthlyCredits,
    periodEnd,
    deps,
  );

  // 6. 반환.
  return {
    kind: "active",
    subscription: activated.subscription,
    grantedCredits: activated.grantedCredits,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// changePlan (8.5)
// ─────────────────────────────────────────────────────────────────────────────

export type ChangePlanOutcome =
  | { kind: "no_subscription" }
  | { kind: "noop" }
  | { kind: "mismatch" }
  | { kind: "payment_failed"; reason: string }
  | { kind: "upgraded"; subscription: CreditSubscriptionRecord; grantedCredits: number }
  | { kind: "downgrade_scheduled"; subscription: CreditSubscriptionRecord };

export async function changePlan(
  input: { userId: string; planCode: string },
  deps: SubscriptionServiceDeps,
): Promise<ChangePlanOutcome> {
  const now = deps.now?.() ?? new Date();

  const sub = await deps.subscription.getActiveOrPastDueForUser(input.userId);
  if (!sub) return { kind: "no_subscription" };

  const target = await deps.subscription.getPlanByCode(input.planCode);
  if (!target) return { kind: "payment_failed", reason: "존재하지 않는 플랜입니다." };

  const current = await deps.subscription.getPlanById(sub.planId);
  if (!current) return { kind: "payment_failed", reason: "현재 플랜을 찾을 수 없습니다." };

  if (target.id === current.id) return { kind: "noop" };

  if (target.monthlyPriceKrw > current.monthlyPriceKrw) {
    // ── 업그레이드 ──
    // [1] 예약 전부 취소(레드팀 B2).
    await cancelAllSchedules(sub, deps);

    // [2] 새 플랜 즉시결제(전액, 새 plan_initial 주문).
    const krwPerCredit = await deps.system.readNumericSetting("krw_per_credit", KRW_PER_CREDIT_FALLBACK);
    const ttlMinutes = await deps.system.readNumericSetting("payment_order_ttl_minutes", ORDER_TTL_MINUTES_FALLBACK);
    const orderId = crypto.randomUUID();
    const paymentId = paymentIdForOrder(orderId);
    await deps.subscription.createPlanOrder({
      id: orderId,
      paymentId,
      walletId: sub.walletId,
      userId: sub.userId,
      planSubscriptionId: sub.id,
      orderType: "plan_initial",
      amountKrw: target.monthlyPriceKrw,
      creditsToGrant: target.monthlyCredits,
      krwPerCreditSnapshot: krwPerCredit,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
    });

    const payment = await deps.portone.payWithBillingKey({
      paymentId,
      billingKey: sub.billingKey,
      orderName: target.name,
      amount: target.monthlyPriceKrw,
      customerId: sub.userId,
      idempotencyKey: paymentId,
    });

    if (payment.status !== "PAID") {
      const reason = payment.failureReason ?? `결제 미완(${payment.status})`;
      await deps.payment.markOrderFailed({ orderId, reason, portoneStatus: payment.status });
      return { kind: "payment_failed", reason };
    }
    const total = payment.amount?.total ?? -1;
    if (total !== target.monthlyPriceKrw || payment.currency !== "KRW") {
      await deps.payment.markOrderMismatch({
        orderId,
        portoneStatus: payment.status,
        detail: {
          expectedAmount: target.monthlyPriceKrw,
          actualAmount: total,
          expectedCurrency: "KRW",
          actualCurrency: payment.currency,
        },
      });
      return { kind: "mismatch" };
    }

    // [3] 즉시 지급 + period 리셋 + planId 스왑(Phase-A upgradeSubscriptionWithGrant — 단일 진입점).
    const periodStart = now;
    const periodEnd = nextPeriodEnd(now);
    const lotExpiresAt = await computeLotExpiry(deps.system, target.code, now);
    const upgraded = await deps.subscription.upgradeSubscriptionWithGrant({
      subscriptionId: sub.id,
      orderId,
      newPlanId: target.id,
      periodStart,
      periodEnd,
      monthlyCredits: target.monthlyCredits,
      lotExpiresAt,
      portone: { status: payment.status, txId: payment.transactionId, payMethod: payment.payMethod },
    });

    // [4] 새 예약 등록(상위 플랜 금액).
    await registerSchedule(
      upgraded.subscription,
      target.name,
      target.monthlyPriceKrw,
      target.monthlyCredits,
      periodEnd,
      deps,
    );

    return { kind: "upgraded", subscription: upgraded.subscription, grantedCredits: upgraded.grantedCredits };
  }

  // ── 다운그레이드 ──
  // [1] 예약 전부 취소(레드팀 B2).
  await cancelAllSchedules(sub, deps);
  // [2] pendingPlanId 저장(다음 갱신부터 적용).
  await deps.subscription.setPendingPlan({ subscriptionId: sub.id, pendingPlanId: target.id });
  // [3] 새 금액(하위 플랜)으로 재예약(현재 주기 종료 시각에).
  const refreshed = (await deps.subscription.getSubscriptionById(sub.id)) ?? sub;
  await registerSchedule(
    refreshed,
    target.name,
    target.monthlyPriceKrw,
    target.monthlyCredits,
    refreshed.currentPeriodEnd,
    deps,
  );

  const result = (await deps.subscription.getSubscriptionById(sub.id)) ?? refreshed;
  return { kind: "downgrade_scheduled", subscription: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelSubscription (8.5)
// ─────────────────────────────────────────────────────────────────────────────

export type CancelSubscriptionOutcome =
  | { kind: "no_subscription" }
  | { kind: "canceled"; periodEnd: Date };

export async function cancelSubscription(
  input: { userId: string },
  deps: SubscriptionServiceDeps,
): Promise<CancelSubscriptionOutcome> {
  const sub = await deps.subscription.getActiveOrPastDueForUser(input.userId);
  if (!sub) return { kind: "no_subscription" };

  // [1] 예약 전부 취소(레드팀 B2).
  await cancelAllSchedules(sub, deps);
  // [2] 해지 예약(주기 종료 시 canceled).
  await deps.subscription.setCancelAtPeriodEnd({ subscriptionId: sub.id, cancel: true });

  return { kind: "canceled", periodEnd: sub.currentPeriodEnd };
}

// ─────────────────────────────────────────────────────────────────────────────
// replaceBillingKey (8.5)
// ─────────────────────────────────────────────────────────────────────────────

export type ReplaceBillingKeyOutcome =
  | { kind: "no_subscription" }
  | { kind: "replaced"; cardBrand: string | null; cardLast4: string | null };

export async function replaceBillingKey(
  input: { userId: string; newBillingKey: string; cardSummary?: { brand?: string; last4?: string } | null },
  deps: SubscriptionServiceDeps,
): Promise<ReplaceBillingKeyOutcome> {
  const now = deps.now?.() ?? new Date();

  const sub = await deps.subscription.getActiveOrPastDueForUser(input.userId);
  if (!sub) return { kind: "no_subscription" };

  const oldBillingKey = sub.billingKey;
  const cardSummary = input.cardSummary ?? null;

  // 순서(8.5): 새 키 → 구독 UPDATE → 구 키 예약 취소 → 새 키로 재예약 → 구 키 삭제.
  // [1] 새 키로 구독 UPDATE(billing_key.replaced audit 은 updateBillingKey 내부).
  await deps.subscription.updateBillingKey({
    subscriptionId: sub.id,
    billingKey: input.newBillingKey,
    billingKeyIssuedAt: now,
    cardSummary,
  });

  // 갱신된 구독(새 billingKey 반영)을 재조회 — 재예약은 새 키로 나가야 한다.
  const updated = (await deps.subscription.getSubscriptionById(sub.id)) ?? { ...sub, billingKey: input.newBillingKey };

  // [2] 구 키의 예약 전부 취소(레드팀 B2 — 구 키 기준). 선생성 예약 주문 정리 + updateSchedule(null).
  await cancelAllSchedules(updated, deps, oldBillingKey);

  // [3] 새 키로 재예약(현재 주기 종료 시각에). 현재 플랜 금액.
  const plan = await deps.subscription.getPlanById(updated.planId);
  const planName = plan?.name ?? "플랜 구독";
  const amountKrw = plan?.monthlyPriceKrw ?? 0;
  const creditsToGrant = plan?.monthlyCredits ?? 0;
  // 다시 최신 구독 조회(cancelAllSchedules 가 updateSchedule 로 nextSchedule* 를 비웠으므로).
  const forSchedule = (await deps.subscription.getSubscriptionById(sub.id)) ?? updated;
  await registerSchedule(forSchedule, planName, amountKrw, creditsToGrant, forSchedule.currentPeriodEnd, deps);

  // [4] 구 키 삭제. 이때 발생하는 구 키의 BillingKey.Deleted 웹훅은 7.3 "현재 키 일치" 조건으로 무해.
  await deps.portone.deleteBillingKey({
    billingKey: oldBillingKey,
    idempotencyKey: `billingkey-delete:${sub.id}:${oldBillingKey}`,
  });
  // 12.2 billing_key.deleted 감사(구 키 삭제 근거).
  await deps.subscription.recordBillingKeyDeleted({ subscriptionId: sub.id, reason: "billing_key_rotation" });

  return { kind: "replaced", cardBrand: cardSummary?.brand ?? null, cardLast4: cardSummary?.last4 ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// forceCancelSubscription (8.5 강제 해지 — admin 발)
// ─────────────────────────────────────────────────────────────────────────────

export type ForceCancelOutcome =
  | { kind: "not_found" }
  | { kind: "already_terminal"; status: CreditSubscriptionRecord["status"] }
  | { kind: "canceled"; previousStatus: CreditSubscriptionRecord["status"] };

/**
 * 8.5 강제 해지(admin). 첫 단계는 반드시 미소진 예약 전부 취소(cancelSchedules 선행) →
 * 즉시 canceled 전이(cancelAtPeriodEnd 아님 — 주기 종료 대기 없이 즉시 종료).
 * @param input.subscriptionId 강제 해지 대상 구독 id.
 * @param input.reason 감사 근거(필수).
 * @param input.actorId 감사 actorId(admin_users.id).
 */
export async function forceCancelSubscription(
  input: { subscriptionId: string; reason: string; actorId: string },
  deps: SubscriptionServiceDeps,
): Promise<ForceCancelOutcome> {
  const sub = await deps.subscription.getSubscriptionById(input.subscriptionId);
  if (!sub) return { kind: "not_found" };
  if (sub.status === "canceled" || sub.status === "expired") {
    return { kind: "already_terminal", status: sub.status };
  }

  // ★ 8.5 첫 단계: 미소진 예약 전부 취소(cancelSchedules 선행 — 3.1 불변 규칙).
  await cancelAllSchedules(sub, deps);
  // 즉시 canceled 전이 + audit(subscription.forced_cancel).
  await deps.subscription.forceCancelSubscription({
    subscriptionId: sub.id,
    reason: input.reason,
    actorId: input.actorId,
  });

  return { kind: "canceled", previousStatus: sub.status };
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelSchedulesForUser (4.1 freeze 연동 — 예약만 취소, 구독은 유지)
// ─────────────────────────────────────────────────────────────────────────────

export type CancelSchedulesForUserOutcome =
  | { kind: "no_subscription" }
  | { kind: "schedules_canceled"; subscriptionId: string };

/**
 * 4.1 지갑 동결 연동: 해당 유저의 활성(active/past_due) 구독의 미소진 포트원 예약을 전부 취소한다.
 * ★ 구독 상태는 유지(canceled 로 만들지 않는다) — 동결은 "다음 예약결제만 막는" 것이 목적.
 *   예약이 실행돼 plan_grant 가 지급되면 freeze 예외 목록에 없어 지급되므로, 예약 자체를 제거한다.
 */
export async function cancelSchedulesForUser(
  input: { userId: string },
  deps: SubscriptionServiceDeps,
): Promise<CancelSchedulesForUserOutcome> {
  const sub = await deps.subscription.getActiveOrPastDueForUser(input.userId);
  if (!sub) return { kind: "no_subscription" };

  // 예약 전부 취소(portone.cancelSchedules + 선생성 예약 주문 정리 + updateSchedule(null)).
  // 구독 상태는 그대로 — cancelAtPeriodEnd/canceled 전이를 하지 않는다.
  await cancelAllSchedules(sub, deps);

  return { kind: "schedules_canceled", subscriptionId: sub.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// processRenewal (8.3 — 갱신 트랜잭션. 웹훅 Transaction.Paid + cron SUCCEEDED 공유)
// ─────────────────────────────────────────────────────────────────────────────

export type ProcessRenewalOutcome =
  | { kind: "unknown_order" }
  | { kind: "not_renewal" } // plan_renewal 아님 → 호출자가 topup 처리로 폴백.
  | { kind: "no_subscription" }
  | { kind: "renewed"; grantedCredits: number; subscription: CreditSubscriptionRecord }
  | { kind: "canceled"; subscription: CreditSubscriptionRecord };

export async function processRenewal(
  input: { paymentId: string },
  deps: SubscriptionServiceDeps,
): Promise<ProcessRenewalOutcome> {
  const now = deps.now?.() ?? new Date();

  const order = await deps.payment.getOrderByPaymentId(input.paymentId);
  if (!order) return { kind: "unknown_order" }; // "우리가 모르는 결제" — 경보 대상(레드팀 B2).
  if (order.orderType !== "plan_renewal") return { kind: "not_renewal" };

  // 구독 매칭: 예약 paymentId → 없으면 order.planSubscriptionId 로.
  let sub = await deps.subscription.getSubscriptionByNextSchedulePaymentId(input.paymentId);
  if (!sub && order.planSubscriptionId) {
    sub = await deps.subscription.getSubscriptionById(order.planSubscriptionId);
  }
  if (!sub) return { kind: "no_subscription" };

  // 진실 재조회(사후검증 가드). 리포지토리의 renew 는 plan:{orderId} 로 멱등이므로 안전.
  const payment = await deps.portone.getPayment(input.paymentId);

  // 갱신 후 적용될 플랜 코드로 lot 만료 계산(pendingPlanId 반영).
  const effectivePlanId = sub.pendingPlanId ?? sub.planId;
  const effectivePlan = await deps.subscription.getPlanById(effectivePlanId);
  const planCode = effectivePlan?.code ?? "";
  const lotExpiresAt = await computeLotExpiry(deps.system, planCode, now);

  const result = await deps.subscription.renewSubscriptionWithGrant({
    subscriptionId: sub.id,
    renewalOrderId: order.id,
    lotExpiresAt,
    portone: { status: payment.status, txId: payment.transactionId, payMethod: payment.payMethod },
  });

  if (result.status === "canceled") {
    // cancelAtPeriodEnd 로 종료 — 재예약 없음.
    return { kind: "canceled", subscription: result.subscription };
  }

  // 멱등 no-op(이미 처리된 갱신) — period 롤·재예약 없이 현재 상태만 반환(웹훅 재전송·cron 재구제).
  if (result.alreadyProcessed) {
    return { kind: "renewed", grantedCredits: 0, subscription: result.subscription };
  }

  // active → 다음 회차 예약 재등록(roll 된 periodEnd 로). 적용된 플랜(스왑 반영) 기준 금액.
  const rolledPlan = (await deps.subscription.getPlanById(result.planId)) ?? effectivePlan;
  const planName = rolledPlan?.name ?? "플랜 구독";
  const amountKrw = rolledPlan?.monthlyPriceKrw ?? 0;
  const creditsToGrant = rolledPlan?.monthlyCredits ?? result.grantedCredits;
  await registerSchedule(result.subscription, planName, amountKrw, creditsToGrant, result.periodEnd, deps);

  return { kind: "renewed", grantedCredits: result.grantedCredits, subscription: result.subscription };
}

// ─────────────────────────────────────────────────────────────────────────────
// handleRenewalFailure (8.4 — Transaction.Failed 예약 건)
// ─────────────────────────────────────────────────────────────────────────────

export type RenewalFailureOutcome =
  | { kind: "unknown_order" }
  | { kind: "not_renewal" }
  | { kind: "no_subscription" }
  | { kind: "retry_scheduled"; retryCount: number; delayDays: number }
  | { kind: "expired" };

export async function handleRenewalFailure(
  input: { paymentId: string },
  deps: SubscriptionServiceDeps,
): Promise<RenewalFailureOutcome> {
  const now = deps.now?.() ?? new Date();

  const order = await deps.payment.getOrderByPaymentId(input.paymentId);
  if (!order) return { kind: "unknown_order" };
  if (order.orderType !== "plan_renewal") return { kind: "not_renewal" };

  let sub = await deps.subscription.getSubscriptionByNextSchedulePaymentId(input.paymentId);
  if (!sub && order.planSubscriptionId) {
    sub = await deps.subscription.getSubscriptionById(order.planSubscriptionId);
  }
  if (!sub) return { kind: "no_subscription" };

  // 실패 주문 표기.
  await deps.payment.markOrderFailed({
    orderId: order.id,
    reason: "webhook_transaction_failed",
    portoneStatus: "FAILED",
  });

  const nextRetryCount = sub.retryCount + 1;

  // ★ past_due 진입 — 3.1 불변 규칙: 미소진 예약 전부 취소 후 재등록(이중 청구 방지).
  await cancelAllSchedules(sub, deps);

  // 다음 재시도 지연(8.4): retryScheduleDelayDays(현재까지 실패한 재시도 횟수, schedule).
  // 현재 retryCount 는 "직전까지 실패 횟수". 이번 실패를 반영한 다음 지연은 schedule[sub.retryCount].
  const schedule = await readRetryScheduleDays(deps.system);
  const delayDays = retryScheduleDelayDays(sub.retryCount, schedule);

  if (delayDays === null) {
    // 재시도 소진 → expired.
    await deps.subscription.markSubscriptionExpired(sub.id);
    return { kind: "expired" };
  }

  // past_due + retryCount 갱신.
  await deps.subscription.markSubscriptionPastDue({ subscriptionId: sub.id, retryCount: nextRetryCount });

  // ★ 정확히 예약 1개만 등록(레드팀 — 이중 청구 방지). D+delayDays 에 재시도 결제 예약.
  const timeToPay = new Date(now.getTime() + delayDays * 24 * 60 * 60 * 1000);
  const plan = await deps.subscription.getPlanById(sub.pendingPlanId ?? sub.planId);
  const planName = plan?.name ?? "플랜 구독";
  const amountKrw = plan?.monthlyPriceKrw ?? order.amountKrw;
  const creditsToGrant = plan?.monthlyCredits ?? order.creditsToGrant;
  // cancelAllSchedules 가 nextSchedule* 를 비웠으므로 최신 구독 재조회.
  const refreshed = (await deps.subscription.getSubscriptionById(sub.id)) ?? sub;
  await registerSchedule(refreshed, planName, amountKrw, creditsToGrant, timeToPay, deps);

  return { kind: "retry_scheduled", retryCount: nextRetryCount, delayDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// handleBillingKeyDeleted (7.3 — BillingKey.Deleted 웹훅, 레드팀 m6)
// ─────────────────────────────────────────────────────────────────────────────

export type BillingKeyDeletedOutcome =
  | { kind: "skipped" } // 현재 키와 불일치(구 키 로테이션 이벤트 등) → 무해.
  | { kind: "demoted"; subscription: CreditSubscriptionRecord };

export async function handleBillingKeyDeleted(
  input: { billingKey: string },
  deps: SubscriptionServiceDeps,
): Promise<BillingKeyDeletedOutcome> {
  // 삭제된 키가 어떤 구독의 "현재" billingKey 와 일치할 때만 강등(레드팀 m6).
  const sub = await deps.subscription.getSubscriptionByCurrentBillingKey(input.billingKey);
  if (!sub || sub.billingKey !== input.billingKey) {
    // 현재 키가 아님(키 교체가 발생시키는 구 키 Deleted) → 무해 skip.
    return { kind: "skipped" };
  }
  // active/past_due 만 강등 의미가 있다(incomplete 는 아직 결제 전).
  if (sub.status !== "active" && sub.status !== "past_due") {
    return { kind: "skipped" };
  }

  // 12.2 billing_key.deleted 감사(현재 키 삭제로 인한 강등 근거).
  await deps.subscription.recordBillingKeyDeleted({ subscriptionId: sub.id, reason: "billing_key_deleted_webhook" });
  // ★ 3.1 불변 규칙: 미소진 예약 전부 취소 후 past_due 전환.
  await cancelAllSchedules(sub, deps);
  await deps.subscription.markSubscriptionPastDue({ subscriptionId: sub.id, retryCount: sub.retryCount });

  const refreshed = (await deps.subscription.getSubscriptionById(sub.id)) ?? sub;
  return { kind: "demoted", subscription: refreshed };
}
