/**
 * 플랜 구독(subscription) 도메인 포트 — P4-A (설계 8장 / 9.1).
 *
 * ★ 시스템 경로(4.13): subscribe/change/cancel 라우트·갱신 웹훅·갱신 cron 은 세션이 없거나
 *   시스템 트리거다. 구독에 userId 가 있으므로, 지급(plan_grant)은 그 userId 로 user 컨텍스트를
 *   세팅해 applyLedgerEntry 를 경유한다(단일 진입점, 5.2). 이 포트는 그 오케스트레이션에 필요한
 *   조회·상태전이·지급·감사 로그 원자 연산을 제공한다.
 *
 * 이 포트의 메서드는 세션 검증을 하지 않는다(내부 함수). 소유권 검증은 API 라우트 계층이
 * session.userId 로 별도 수행한다(CreditPaymentRepository 와 동일한 규약, 레드팀 M2).
 *
 * ★ 지급 규약(4.3 / 8.2 / 8.3): plan_grant 의 멱등 키는 반드시 `plan:{orderId}` 다
 *   (ledger.ts 의 idempotencyKeys.plan(orderId) — 주문과 1:1, subId/periodStart 아님. 레드팀 B1).
 *   grantLot.source="plan_grant", grantLot.expiresAt = planGrantExpiry(now, cycles),
 *   grantLot.planSubscriptionId·paymentOrderId 설정. drizzle 구현은 반드시
 *   applyLedgerEntryTx 를 withCunoteDbUser(sub.userId) 안에서 경유한다(단일 진입점, 절대
 *   wallet/lot/ledger 를 직접 만지지 않는다).
 */

import type { CreditOrderRecord } from "./payments.js";

/** 플랜(4.9). */
export interface CreditPlanRecord {
  id: string;
  code: string; // "plus" | "pro" | "flex"
  name: string;
  monthlyPriceKrw: number;
  monthlyCredits: number;
  features: Record<string, unknown>;
  isActive: boolean;
  displayOrder: number;
}

/** 구독 상태(3.1 / 4.0 creditPlanSubStatusEnum). */
export type CreditSubscriptionStatus =
  | "incomplete"
  | "active"
  | "past_due"
  | "canceled"
  | "expired";

/** 구독 전체 행(4.9). */
export interface CreditSubscriptionRecord {
  id: string;
  userId: string;
  walletId: string;
  planId: string;
  status: CreditSubscriptionStatus;
  billingKey: string;
  billingKeyIssuedAt: Date | null;
  cardSummary: { brand?: string; last4?: string } | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  nextScheduleId: string | null;
  nextSchedulePaymentId: string | null;
  retryCount: number;
  pendingPlanId: string | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── 지급 오케스트레이션 입력/출력 ─────────────────────────────────────────

/** activateSubscriptionWithGrant 입력(8.2 step 4). */
export interface ActivateSubscriptionInput {
  /** 활성화할 구독 id(status=incomplete 여야 함). */
  subscriptionId: string;
  /** 지급 근거가 되는 plan_initial 주문 id(멱등 키 plan:{orderId}). */
  orderId: string;
  /** 이번 주기 시작(보통 now). */
  periodStart: Date;
  /** 이번 주기 종료(nextPeriodEnd(periodStart)). */
  periodEnd: Date;
  /** 지급할 월 크레딧(플랜 monthlyCredits 스냅샷). */
  monthlyCredits: number;
  /** plan_grant lot 만료(planGrantExpiry(now, cycles)). */
  lotExpiresAt: Date;
  /** 포트원 검증 응답 발췌(주문 전이 기록용). */
  portone: { status: string; txId: string | null; payMethod: string | null };
}

/** activate 결과 — Phase B 가 예약 등록 여부 판단에 사용. */
export interface ActivateSubscriptionResult {
  subscription: CreditSubscriptionRecord;
  grantedCredits: number;
  balance: number;
}

/** renewSubscriptionWithGrant 입력(8.3 갱신 트랜잭션). */
export interface RenewSubscriptionInput {
  /** 갱신 대상 구독 id(status active/past_due 여야 진행). */
  subscriptionId: string;
  /** 이번 갱신 근거 plan_renewal 주문 id(멱등 키 plan:{orderId}). */
  renewalOrderId: string;
  /** 지급 lot 만료(planGrantExpiry(now, cycles)) — 갱신 후 플랜 기준. */
  lotExpiresAt: Date;
  /** 포트원 검증 응답 발췌. */
  portone: { status: string; txId: string | null; payMethod: string | null };
}

/**
 * renew 결과 — Phase B 가 다음 예약 등록 여부를 결정한다.
 *  - status="active": 지급·period 롤 완료 → 다음 회차 예약 재등록 필요.
 *  - status="canceled": cancelAtPeriodEnd 로 종료 → 재예약 없음.
 */
export interface RenewSubscriptionResult {
  status: "active" | "canceled";
  /** canceled 면 0. */
  grantedCredits: number;
  /** 갱신 후 적용된 planId(다운그레이드 스왑 반영). canceled 면 이전 planId. */
  planId: string;
  periodStart: Date;
  periodEnd: Date;
  subscription: CreditSubscriptionRecord;
  /**
   * 이미 처리된 갱신(renewal 주문이 이미 paid)이라 period 롤·재예약을 건너뛰어야 함(멱등).
   * 웹훅 재전송·cron SUCCEEDED 재구제 시 이 주문의 갱신이 두 번 실행되면 period 가 두 번 롤되고
   * 예약이 중복 등록된다 → true 면 호출측(processRenewal)이 재예약을 하지 않는다(8.3 멱등).
   */
  alreadyProcessed?: boolean;
}

/** upgradeSubscriptionWithGrant 입력(8.5 업그레이드 — period 리셋 + planId 스왑 + 즉시 지급). */
export interface UpgradeSubscriptionInput {
  /** 업그레이드 대상 구독 id(status active/past_due). */
  subscriptionId: string;
  /** 지급 근거 plan_initial 주문 id(멱등 키 plan:{orderId} — D1 시나리오, 주문별 무충돌). */
  orderId: string;
  /** 교체 후 planId(상위 플랜). */
  newPlanId: string;
  /** 새 주기 시작(now — 업그레이드는 period 리셋). */
  periodStart: Date;
  /** 새 주기 종료(nextPeriodEnd(periodStart)). */
  periodEnd: Date;
  /** 지급할 상위 플랜 월 크레딧. */
  monthlyCredits: number;
  /** plan_grant lot 만료(planGrantExpiry(now, cycles) — 상위 플랜 기준). */
  lotExpiresAt: Date;
  /** 포트원 검증 응답 발췌. */
  portone: { status: string; txId: string | null; payMethod: string | null };
}

/** upgrade 결과 — Phase B 가 새 예약 재등록에 사용. */
export interface UpgradeSubscriptionResult {
  subscription: CreditSubscriptionRecord;
  grantedCredits: number;
  balance: number;
}

/** upsertIncompleteSubscription 입력(8.2 step 2). */
export interface UpsertIncompleteSubscriptionInput {
  userId: string;
  walletId: string;
  planId: string;
  billingKey: string;
  billingKeyIssuedAt: Date;
  cardSummary: { brand?: string; last4?: string } | null;
  periodStart: Date;
  periodEnd: Date;
}

/** 예약용 선생성 주문 입력(8.2 step 5 / 8.3 재예약 — plan_initial|plan_renewal). */
export interface CreatePlanOrderInput {
  id: string;
  paymentId: string;
  walletId: string;
  userId: string;
  planSubscriptionId: string;
  orderType: "plan_initial" | "plan_renewal";
  amountKrw: number;
  creditsToGrant: number;
  krwPerCreditSnapshot: number;
  expiresAt: Date;
}

/** 실패 웹훅 재처리 대상(7.3 — 48h inbox). */
export interface FailedWebhookEvent {
  id: string;
  webhookId: string;
  eventType: string;
  paymentId: string | null;
  billingKey: string | null;
}

/**
 * 플랜 구독 시스템 경로 포트. 세션 없는 신뢰 서버(라우트 래퍼/웹훅/cron)가 호출.
 *
 * ★ 지급·상태전이 메서드는 모두 세션리스지만 drizzle 구현이 withCunoteDbUser(sub.userId)
 *   안에서 applyLedgerEntryTx 를 경유한다(단일 진입점, 4.13 / 5.2). 이 포트를 통하지 않는
 *   wallet/lot/ledger 접근을 만들지 않는다.
 */
export interface CreditSubscriptionRepository {
  // ── 플랜 조회 (9.1 GET /plans) ─────────────────────────────────────────
  /** 활성 플랜 목록(공개). displayOrder 순. */
  listActivePlans(): Promise<CreditPlanRecord[]>;
  /** 플랜 code 로 조회(활성만). subscribe/change 검증용. */
  getPlanByCode(code: string): Promise<CreditPlanRecord | null>;
  /** 플랜 id 로 조회(활성 무관 — 지급 시 스냅샷 재구성용). */
  getPlanById(id: string): Promise<CreditPlanRecord | null>;

  // ── 구독 조회 ──────────────────────────────────────────────────────────
  /** user 의 비종료(active/past_due/incomplete) 구독 중 최신 1개. GET /plans 표시용. */
  getSubscriptionForUser(userId: string): Promise<CreditSubscriptionRecord | null>;
  /**
   * user 의 status IN (active, past_due) 구독(subscribe 의 409 가드용, 8.2 step 1).
   * one-active partial unique index 와 정합 — incomplete 는 제외.
   */
  getActiveOrPastDueForUser(userId: string): Promise<CreditSubscriptionRecord | null>;
  /** id 로 구독 조회. */
  getSubscriptionById(id: string): Promise<CreditSubscriptionRecord | null>;
  /** 예약 paymentId(선생성 renewal 주문)로 구독 매칭(갱신 웹훅, 8.3). */
  getSubscriptionByNextSchedulePaymentId(
    paymentId: string,
  ): Promise<CreditSubscriptionRecord | null>;
  /**
   * "현재" billingKey 가 이 값과 일치하는 비종료(active/past_due/incomplete) 구독 매칭.
   * BillingKey.Deleted 웹훅(7.3 레드팀 m6): 삭제된 키가 구독의 현재 키일 때만 강등하기 위함.
   * 키 교체가 발생시키는 구(舊) 키 Deleted 이벤트는 여기서 매칭되지 않아 정상 구독을 강등하지 않는다.
   */
  getSubscriptionByCurrentBillingKey(
    billingKey: string,
  ): Promise<CreditSubscriptionRecord | null>;

  // ── 구독 생성·활성화 (8.2) ─────────────────────────────────────────────
  /**
   * 8.2 step 2: incomplete 구독 upsert. 기존 incomplete 행이 있으면 UPDATE(재사용),
   * 없으면 INSERT status=incomplete. active/past_due 를 만들지 않는다(결제 성공 전 절대 active 금지,
   * 레드팀 M6). 같은 user 에 2번째 incomplete 를 만들지 않는다(먼저 조회 → UPDATE|INSERT).
   * 호출측이 active/past_due 존재를 가드하지만 방어적으로 재확인해도 된다.
   */
  upsertIncompleteSubscription(
    input: UpsertIncompleteSubscriptionInput,
  ): Promise<CreditSubscriptionRecord>;

  /**
   * 8.2 step 4: 첫 결제 PAID 확정 후 단일 트랜잭션으로 활성화 + 지급.
   *  - status=incomplete → active, currentPeriodStart/End 설정.
   *  - applyLedgerEntry(plan_grant, +monthlyCredits, key=plan:{orderId}) — source=plan_grant,
   *    lot expiresAt=lotExpiresAt, grantLot.planSubscriptionId·paymentOrderId 설정.
   *  - plan_initial 주문 UPDATE status=paid(grantPurchaseForOrder 의 주문 전이와 동일).
   *  - audit_log(action="subscription.started").
   * 멱등(plan:{orderId})이라 웹훅·complete 중복 진입에 안전.
   *
   * ★ drizzle 구현은 withCunoteDbUser(sub.userId) 안에서 applyLedgerEntryTx 경유(단일 진입점).
   */
  activateSubscriptionWithGrant(
    input: ActivateSubscriptionInput,
  ): Promise<ActivateSubscriptionResult>;

  /**
   * 8.3 갱신 트랜잭션(예약 실행 웹훅/cron 공통, 멱등):
   *  - status 가드: active/past_due 가 아니거나 renewal 주문이 이미 paid 면 현재 상태 반환(no-op).
   *  - period 롤: start=이전 currentPeriodEnd, end=nextPeriodEnd(start).
   *  - cancelAtPeriodEnd → status=canceled, canceledAt, 지급·재예약 없음(result.status="canceled").
   *  - pendingPlanId → planId 를 pendingPlanId 로 교체·clear 후 새 플랜 monthlyCredits 지급.
   *  - applyLedgerEntry(plan_grant, +credits, key=plan:{renewalOrderId}) — source=plan_grant.
   *  - plan_renewal 주문 UPDATE status=paid. retryCount=0 리셋.
   *  - audit_log(action="subscription.renewed").
   *
   * ★ drizzle 구현은 withCunoteDbUser(sub.userId) 안에서 applyLedgerEntryTx 경유(단일 진입점).
   */
  renewSubscriptionWithGrant(input: RenewSubscriptionInput): Promise<RenewSubscriptionResult>;

  /**
   * 8.5 업그레이드 즉시결제 PAID 확정 후 단일 트랜잭션으로 지급 + period 리셋 + planId 스왑.
   * renewSubscriptionWithGrant 와 달리 period 를 이전 종료로 롤하지 않고 입력(now~nextPeriodEnd)으로
   * 리셋하며, planId 를 newPlanId 로 즉시 교체한다(구독은 이미 active). 지급은 상위 플랜 monthlyCredits.
   *  - applyLedgerEntry(plan_grant, +monthlyCredits, key=plan:{orderId}) — 주문별 무충돌(레드팀 B1/D1).
   *  - plan_initial 주문 UPDATE status=paid. retryCount=0.
   *  - audit_log(action="subscription.started" 계열 — planId 교체 기록).
   *
   * ★ drizzle 구현은 withCunoteDbUser(sub.userId) 안에서 applyLedgerEntryTx 경유(단일 진입점).
   */
  upgradeSubscriptionWithGrant(
    input: UpgradeSubscriptionInput,
  ): Promise<UpgradeSubscriptionResult>;

  // ── 상태 전이 (8.4 / 8.5) ──────────────────────────────────────────────
  /** 갱신 실패 → past_due + retryCount 갱신. audit_log(subscription.past_due). */
  markSubscriptionPastDue(input: { subscriptionId: string; retryCount: number }): Promise<void>;
  /** 재시도 소진 → expired. audit_log(subscription.expired). */
  markSubscriptionExpired(subscriptionId: string): Promise<void>;
  /** 해지 예약/취소(8.5). cancelAtPeriodEnd 세팅. */
  setCancelAtPeriodEnd(input: { subscriptionId: string; cancel: boolean }): Promise<void>;
  /** 다운그레이드 예약(8.5). pendingPlanId 세팅(null 이면 clear). */
  setPendingPlan(input: { subscriptionId: string; pendingPlanId: string | null }): Promise<void>;
  /** 빌링키 교체(8.5). audit_log(billing_key.replaced). */
  updateBillingKey(input: {
    subscriptionId: string;
    billingKey: string;
    billingKeyIssuedAt: Date;
    cardSummary: { brand?: string; last4?: string } | null;
  }): Promise<void>;
  /**
   * 빌링키 삭제 감사(12.2 billing_key.deleted). 8.5 키 교체의 구 키 삭제·7.3 Deleted 웹훅 강등의
   * 감사 근거. 실제 포트원 deleteBillingKey 호출은 서비스가 하고, 이 메서드는 감사 로그만 남긴다.
   */
  recordBillingKeyDeleted(input: { subscriptionId: string; reason: string }): Promise<void>;
  /** 예약(scheduleId/paymentId) 저장·교체·해제(null=해제). */
  updateSchedule(input: {
    subscriptionId: string;
    nextScheduleId: string | null;
    nextSchedulePaymentId: string | null;
  }): Promise<void>;

  // ── 예약용 선생성 주문 (8.2 step 5 / 8.3, 레드팀 B2) ─────────────────────
  /**
   * 예약(초기·갱신) 결제용 주문을 status=created 로 선생성한다(레드팀 B2 — 웹훅 매칭을
   * 구독 단일 컬럼이 아니라 주문 테이블 paymentId unique 로 하기 위함).
   * CreditOrderRecord(payments.ts) 를 재사용한다. orders 테이블의 plan_subscription_id 컬럼 설정.
   */
  createPlanOrder(input: CreatePlanOrderInput): Promise<CreditOrderRecord>;
  /** 8.5: 이 구독의 선생성 예약 주문(status=created) 을 expired 로(예약 취소 시 정리). */
  expireCreatedOrdersForSubscription(subscriptionId: string): Promise<void>;

  // ── cron / inbox (8.3) ─────────────────────────────────────────────────
  /** 8.3 안전망 cron: status=active AND currentPeriodEnd < now - grace. */
  listRenewalDueSubscriptions(nowMinusGraceMs: number): Promise<CreditSubscriptionRecord[]>;
  /** 7.3 실패 웹훅 재처리: processingStatus=failed AND createdAt > now - since. */
  listFailedWebhookEvents(sinceMs: number): Promise<FailedWebhookEvent[]>;
}
