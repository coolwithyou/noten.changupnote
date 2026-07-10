/**
 * 플랜 구독 리포지토리 — 시스템 경로(P4-A, 설계 8장 / 9.1).
 *
 * ★ 규범:
 *   - 지급(plan_grant)은 sub.userId 로 user 컨텍스트를 세팅해 applyLedgerEntryTx 를 경유한다
 *     (5.2 단일 진입점). subscribe·갱신 웹훅·갱신 cron 은 세션이 없지만 sub.userId 를 알기에 가능.
 *   - 멱등: plan:{orderId}(주문과 1:1, subId/period 아님 — 레드팀 B1). 초기·갱신 모두 각 주문 id 로.
 *   - grantLot.source="plan_grant", expiresAt=lotExpiresAt(Phase B 가 planGrantExpiry 로 계산),
 *     planSubscriptionId·paymentOrderId 설정.
 *   - one-active partial unique index(status IN active/past_due)는 2번째 active 활성화 시 23505.
 *     incomplete 는 의도적으로 제외(레드팀 M6) — upsertIncompleteSubscription 은 기존 incomplete 재사용.
 *
 * 세션 소유권 검증(sub.userId === session.userId, 레드팀 M2)은 이 리포지토리가 아니라
 * API 라우트(plans/*)가 수행한다 — 이 포트는 세션 없는 내부 함수다.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  idempotencyKeys,
  nextPeriodEnd,
  type ActivateSubscriptionInput,
  type ActivateSubscriptionResult,
  type CreatePlanOrderInput,
  type CreditOrderRecord,
  type CreditPlanRecord,
  type CreditSubscriptionRecord,
  type CreditSubscriptionRepository,
  type FailedWebhookEvent,
  type RenewSubscriptionInput,
  type RenewSubscriptionResult,
  type UpgradeSubscriptionInput,
  type UpgradeSubscriptionResult,
  type UpsertIncompleteSubscriptionInput,
} from "@cunote/core";
import type { CunoteDb } from "@/lib/server/db/client";
import { withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { applyLedgerEntryTx, insertAuditLog } from "./creditRepository";

interface Deps {
  client: CunoteDb;
  now?: () => Date;
}

/** 비종료 상태(getSubscriptionForUser 표시용). */
const NON_TERMINAL_STATUSES = ["active", "past_due", "incomplete"] as const;

export class DrizzleSubscriptionRepository implements CreditSubscriptionRepository {
  private readonly client: CunoteDb;
  private readonly now: () => Date;

  constructor(deps: Deps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
  }

  // ── 플랜 조회 ─────────────────────────────────────────────────────────────
  async listActivePlans(): Promise<CreditPlanRecord[]> {
    const rows = await this.client
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.isActive, true))
      .orderBy(schema.creditPlans.displayOrder);
    return rows.map(toPlanRecord);
  }

  async getPlanByCode(code: string): Promise<CreditPlanRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPlans)
      .where(and(eq(schema.creditPlans.code, code), eq(schema.creditPlans.isActive, true)))
      .limit(1);
    return row ? toPlanRecord(row) : null;
  }

  async getPlanById(id: string): Promise<CreditPlanRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.id, id))
      .limit(1);
    return row ? toPlanRecord(row) : null;
  }

  // ── 구독 조회 ──────────────────────────────────────────────────────────────
  async getSubscriptionForUser(userId: string): Promise<CreditSubscriptionRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(
        and(
          eq(schema.creditPlanSubscriptions.userId, userId),
          inArray(schema.creditPlanSubscriptions.status, [...NON_TERMINAL_STATUSES]),
        ),
      )
      .orderBy(desc(schema.creditPlanSubscriptions.createdAt))
      .limit(1);
    return row ? toSubscriptionRecord(row) : null;
  }

  async getActiveOrPastDueForUser(userId: string): Promise<CreditSubscriptionRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(
        and(
          eq(schema.creditPlanSubscriptions.userId, userId),
          inArray(schema.creditPlanSubscriptions.status, ["active", "past_due"]),
        ),
      )
      .orderBy(desc(schema.creditPlanSubscriptions.createdAt))
      .limit(1);
    return row ? toSubscriptionRecord(row) : null;
  }

  async getSubscriptionById(id: string): Promise<CreditSubscriptionRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(eq(schema.creditPlanSubscriptions.id, id))
      .limit(1);
    return row ? toSubscriptionRecord(row) : null;
  }

  async getSubscriptionByNextSchedulePaymentId(
    paymentId: string,
  ): Promise<CreditSubscriptionRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(eq(schema.creditPlanSubscriptions.nextSchedulePaymentId, paymentId))
      .limit(1);
    return row ? toSubscriptionRecord(row) : null;
  }

  async getSubscriptionByCurrentBillingKey(
    billingKey: string,
  ): Promise<CreditSubscriptionRecord | null> {
    // 비종료 구독 중 현재 billingKey 가 일치하는 것(BillingKey.Deleted 웹훅 매칭, 7.3 레드팀 m6).
    const [row] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(
        and(
          eq(schema.creditPlanSubscriptions.billingKey, billingKey),
          inArray(schema.creditPlanSubscriptions.status, [...NON_TERMINAL_STATUSES]),
        ),
      )
      .orderBy(desc(schema.creditPlanSubscriptions.createdAt))
      .limit(1);
    return row ? toSubscriptionRecord(row) : null;
  }

  // ── 구독 생성·활성화 (8.2) ───────────────────────────────────────────────
  async upsertIncompleteSubscription(
    input: UpsertIncompleteSubscriptionInput,
  ): Promise<CreditSubscriptionRecord> {
    const at = this.now();
    // 기존 incomplete 행 재사용(레드팀 M6). active/past_due 는 이 upsert 로 건드리지 않는다.
    const [existing] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(
        and(
          eq(schema.creditPlanSubscriptions.userId, input.userId),
          eq(schema.creditPlanSubscriptions.status, "incomplete"),
        ),
      )
      .orderBy(desc(schema.creditPlanSubscriptions.createdAt))
      .limit(1);

    if (existing) {
      const [row] = await this.client
        .update(schema.creditPlanSubscriptions)
        .set({
          walletId: input.walletId,
          planId: input.planId,
          billingKey: input.billingKey,
          billingKeyIssuedAt: input.billingKeyIssuedAt,
          cardSummary: input.cardSummary,
          currentPeriodStart: input.periodStart,
          currentPeriodEnd: input.periodEnd,
          cancelAtPeriodEnd: false,
          nextScheduleId: null,
          nextSchedulePaymentId: null,
          retryCount: 0,
          pendingPlanId: null,
          canceledAt: null,
          updatedAt: at,
        })
        .where(eq(schema.creditPlanSubscriptions.id, existing.id))
        .returning();
      return toSubscriptionRecord(row!);
    }

    const [row] = await this.client
      .insert(schema.creditPlanSubscriptions)
      .values({
        userId: input.userId,
        walletId: input.walletId,
        planId: input.planId,
        status: "incomplete",
        billingKey: input.billingKey,
        billingKeyIssuedAt: input.billingKeyIssuedAt,
        cardSummary: input.cardSummary,
        currentPeriodStart: input.periodStart,
        currentPeriodEnd: input.periodEnd,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return toSubscriptionRecord(row!);
  }

  async activateSubscriptionWithGrant(
    input: ActivateSubscriptionInput,
  ): Promise<ActivateSubscriptionResult> {
    const at = this.now();
    const [sub] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new Error(`구독을 찾을 수 없습니다: ${input.subscriptionId}`);

    // sub.userId 로 user 컨텍스트를 세팅해 단일 진입점(applyLedgerEntryTx)을 경유한다.
    return withCunoteDbUser(this.client, sub.userId, async (tx) => {
      // 1. plan_grant 지급(멱등 key=plan:{orderId}). lot 에 planSubscriptionId·paymentOrderId 연결.
      const entry = await applyLedgerEntryTx(
        tx,
        {
          walletId: sub.walletId,
          entryType: "plan_grant",
          amountCredits: input.monthlyCredits,
          idempotencyKey: idempotencyKeys.plan(input.orderId),
          actorType: "system",
          actorId: "system:subscription",
          reason: "플랜 월 크레딧 지급",
          paymentOrderId: input.orderId,
          grantLot: {
            source: "plan_grant",
            expiresAt: input.lotExpiresAt,
            paymentOrderId: input.orderId,
            planSubscriptionId: sub.id,
          },
        },
        () => at,
      );

      // 2. incomplete → active 전이 + period 확정.
      const [updated] = await tx
        .update(schema.creditPlanSubscriptions)
        .set({
          status: "active",
          currentPeriodStart: input.periodStart,
          currentPeriodEnd: input.periodEnd,
          retryCount: 0,
          updatedAt: at,
        })
        .where(eq(schema.creditPlanSubscriptions.id, sub.id))
        .returning();

      // 3. plan_initial 주문 paid 전이(grantPurchaseForOrder 와 동일 규약).
      await tx.execute(sql`
        UPDATE credit_payment_orders
        SET status = 'paid',
            paid_at = COALESCE(paid_at, ${at.toISOString()}::timestamptz),
            portone_status = ${input.portone.status},
            portone_tx_id = ${input.portone.txId},
            pay_method = ${input.portone.payMethod},
            updated_at = ${at.toISOString()}::timestamptz
        WHERE id = ${input.orderId}::uuid AND status <> 'refunded' AND status <> 'partial_refunded'
      `);

      // 4. audit_log(subscription.started).
      await insertAuditLog(tx, {
        action: "subscription.started",
        actorType: "system",
        actorId: "system:subscription",
        targetType: "subscription",
        targetId: sub.id,
        after: {
          planId: sub.planId,
          orderId: input.orderId,
          grantedCredits: input.monthlyCredits,
          ledgerEntryId: entry.id,
          periodEnd: input.periodEnd.toISOString(),
        },
        at,
      });

      const [wallet] = await tx.execute<{ balance_credits: number }>(
        sql`SELECT balance_credits FROM credit_wallets WHERE id = ${sub.walletId}::uuid`,
      );
      return {
        subscription: toSubscriptionRecord(updated!),
        grantedCredits: input.monthlyCredits,
        balance: Number(wallet?.balance_credits ?? 0),
      };
    });
  }

  async renewSubscriptionWithGrant(
    input: RenewSubscriptionInput,
  ): Promise<RenewSubscriptionResult> {
    const at = this.now();
    const [sub] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new Error(`구독을 찾을 수 없습니다: ${input.subscriptionId}`);

    // status 가드(8.3): active/past_due 만 갱신 진행. 그 외는 no-op(현재 상태 반환).
    if (sub.status !== "active" && sub.status !== "past_due") {
      return renewNoOp(sub);
    }

    // 멱등 가드(8.3): 이 renewal 주문이 이미 paid 면 갱신이 이미 실행된 것 —
    // period 를 두 번 롤하거나 예약을 중복 등록하지 않도록 no-op(alreadyProcessed) 로 반환한다.
    // (plan_grant 는 plan:{orderId} 키로 멱등이지만 period 롤·주문 전이·재예약은 멱등이 아니므로
    //  이 주문-상태 가드가 웹훅 재전송·cron SUCCEEDED 재구제의 이중 실행을 막는 진짜 방어선이다.)
    const [renewalOrder] = await this.client
      .select({ status: schema.creditPaymentOrders.status })
      .from(schema.creditPaymentOrders)
      .where(eq(schema.creditPaymentOrders.id, input.renewalOrderId))
      .limit(1);
    if (renewalOrder?.status === "paid") {
      return { ...renewNoOp(sub), alreadyProcessed: true };
    }

    // period 롤: start=이전 currentPeriodEnd, end=nextPeriodEnd(start).
    const periodStart = new Date(sub.currentPeriodEnd);
    const periodEnd = nextPeriodEnd(periodStart);

    // cancelAtPeriodEnd → canceled, 지급·재예약 없음(막차 결제 방어 분기).
    if (sub.cancelAtPeriodEnd) {
      const [updated] = await this.client
        .update(schema.creditPlanSubscriptions)
        .set({
          status: "canceled",
          canceledAt: at,
          nextScheduleId: null,
          nextSchedulePaymentId: null,
          updatedAt: at,
        })
        .where(eq(schema.creditPlanSubscriptions.id, sub.id))
        .returning();
      await this.client.insert(schema.creditAuditLogs).values({
        action: "subscription.canceled",
        actorType: "system",
        actorId: "system:subscription",
        targetType: "subscription",
        targetId: sub.id,
        after: { reason: "cancel_at_period_end", renewalOrderId: input.renewalOrderId },
        createdAt: at,
      });
      return {
        status: "canceled",
        grantedCredits: 0,
        planId: sub.planId,
        periodStart,
        periodEnd,
        subscription: toSubscriptionRecord(updated!),
      };
    }

    // pendingPlanId → 플랜 교체. 지급은 새 플랜의 monthlyCredits.
    const effectivePlanId = sub.pendingPlanId ?? sub.planId;
    const [plan] = await this.client
      .select({ monthlyCredits: schema.creditPlans.monthlyCredits })
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.id, effectivePlanId))
      .limit(1);
    if (!plan) throw new Error(`플랜을 찾을 수 없습니다: ${effectivePlanId}`);
    const grantCredits = Number(plan.monthlyCredits);

    return withCunoteDbUser(this.client, sub.userId, async (tx) => {
      // 1. plan_grant 지급(멱등 key=plan:{renewalOrderId}).
      const entry = await applyLedgerEntryTx(
        tx,
        {
          walletId: sub.walletId,
          entryType: "plan_grant",
          amountCredits: grantCredits,
          idempotencyKey: idempotencyKeys.plan(input.renewalOrderId),
          actorType: "system",
          actorId: "system:subscription",
          reason: "플랜 월 크레딧 갱신 지급",
          paymentOrderId: input.renewalOrderId,
          grantLot: {
            source: "plan_grant",
            expiresAt: input.lotExpiresAt,
            paymentOrderId: input.renewalOrderId,
            planSubscriptionId: sub.id,
          },
        },
        () => at,
      );

      // 2. period 롤 + 플랜 스왑(pendingPlanId 반영) + retryCount 리셋 + past_due→active 복귀.
      const [updated] = await tx
        .update(schema.creditPlanSubscriptions)
        .set({
          status: "active",
          planId: effectivePlanId,
          pendingPlanId: null,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          retryCount: 0,
          updatedAt: at,
        })
        .where(eq(schema.creditPlanSubscriptions.id, sub.id))
        .returning();

      // 3. plan_renewal 주문 paid 전이.
      await tx.execute(sql`
        UPDATE credit_payment_orders
        SET status = 'paid',
            paid_at = COALESCE(paid_at, ${at.toISOString()}::timestamptz),
            portone_status = ${input.portone.status},
            portone_tx_id = ${input.portone.txId},
            pay_method = ${input.portone.payMethod},
            updated_at = ${at.toISOString()}::timestamptz
        WHERE id = ${input.renewalOrderId}::uuid AND status <> 'refunded' AND status <> 'partial_refunded'
      `);

      // 4. audit_log(subscription.renewed).
      await insertAuditLog(tx, {
        action: "subscription.renewed",
        actorType: "system",
        actorId: "system:subscription",
        targetType: "subscription",
        targetId: sub.id,
        after: {
          planId: effectivePlanId,
          planSwapped: sub.pendingPlanId !== null,
          renewalOrderId: input.renewalOrderId,
          grantedCredits: grantCredits,
          ledgerEntryId: entry.id,
          periodEnd: periodEnd.toISOString(),
        },
        at,
      });

      return {
        status: "active" as const,
        grantedCredits: grantCredits,
        planId: effectivePlanId,
        periodStart,
        periodEnd,
        subscription: toSubscriptionRecord(updated!),
      };
    });
  }

  async upgradeSubscriptionWithGrant(
    input: UpgradeSubscriptionInput,
  ): Promise<UpgradeSubscriptionResult> {
    const at = this.now();
    const [sub] = await this.client
      .select()
      .from(schema.creditPlanSubscriptions)
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new Error(`구독을 찾을 수 없습니다: ${input.subscriptionId}`);

    // sub.userId 로 user 컨텍스트를 세팅해 단일 진입점(applyLedgerEntryTx)을 경유한다.
    return withCunoteDbUser(this.client, sub.userId, async (tx) => {
      // 1. plan_grant 지급(멱등 key=plan:{orderId} — 주문별 무충돌, 레드팀 B1/D1).
      const entry = await applyLedgerEntryTx(
        tx,
        {
          walletId: sub.walletId,
          entryType: "plan_grant",
          amountCredits: input.monthlyCredits,
          idempotencyKey: idempotencyKeys.plan(input.orderId),
          actorType: "system",
          actorId: "system:subscription",
          reason: "플랜 업그레이드 즉시 지급",
          paymentOrderId: input.orderId,
          grantLot: {
            source: "plan_grant",
            expiresAt: input.lotExpiresAt,
            paymentOrderId: input.orderId,
            planSubscriptionId: sub.id,
          },
        },
        () => at,
      );

      // 2. planId 스왑 + period 리셋(now~nextPeriodEnd) + pendingPlanId clear + retryCount 리셋.
      const [updated] = await tx
        .update(schema.creditPlanSubscriptions)
        .set({
          status: "active",
          planId: input.newPlanId,
          pendingPlanId: null,
          currentPeriodStart: input.periodStart,
          currentPeriodEnd: input.periodEnd,
          retryCount: 0,
          updatedAt: at,
        })
        .where(eq(schema.creditPlanSubscriptions.id, sub.id))
        .returning();

      // 3. plan_initial 주문 paid 전이.
      await tx.execute(sql`
        UPDATE credit_payment_orders
        SET status = 'paid',
            paid_at = COALESCE(paid_at, ${at.toISOString()}::timestamptz),
            portone_status = ${input.portone.status},
            portone_tx_id = ${input.portone.txId},
            pay_method = ${input.portone.payMethod},
            updated_at = ${at.toISOString()}::timestamptz
        WHERE id = ${input.orderId}::uuid AND status <> 'refunded' AND status <> 'partial_refunded'
      `);

      // 4. audit_log(subscription.started — 업그레이드로 새 플랜 활성). before/after 로 planId 교체 기록.
      await insertAuditLog(tx, {
        action: "subscription.started",
        actorType: "system",
        actorId: "system:subscription",
        targetType: "subscription",
        targetId: sub.id,
        before: { planId: sub.planId },
        after: {
          kind: "upgrade",
          planId: input.newPlanId,
          orderId: input.orderId,
          grantedCredits: input.monthlyCredits,
          ledgerEntryId: entry.id,
          periodEnd: input.periodEnd.toISOString(),
        },
        at,
      });

      const [wallet] = await tx.execute<{ balance_credits: number }>(
        sql`SELECT balance_credits FROM credit_wallets WHERE id = ${sub.walletId}::uuid`,
      );
      return {
        subscription: toSubscriptionRecord(updated!),
        grantedCredits: input.monthlyCredits,
        balance: Number(wallet?.balance_credits ?? 0),
      };
    });
  }

  // ── 상태 전이 (8.4 / 8.5) ───────────────────────────────────────────────
  async markSubscriptionPastDue(input: {
    subscriptionId: string;
    retryCount: number;
  }): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({ status: "past_due", retryCount: input.retryCount, updatedAt: at })
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId));
    await this.client.insert(schema.creditAuditLogs).values({
      action: "subscription.past_due",
      actorType: "system",
      actorId: "system:subscription",
      targetType: "subscription",
      targetId: input.subscriptionId,
      after: { retryCount: input.retryCount },
      createdAt: at,
    });
  }

  async markSubscriptionExpired(subscriptionId: string): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({
        status: "expired",
        nextScheduleId: null,
        nextSchedulePaymentId: null,
        updatedAt: at,
      })
      .where(eq(schema.creditPlanSubscriptions.id, subscriptionId));
    await this.client.insert(schema.creditAuditLogs).values({
      action: "subscription.expired",
      actorType: "system",
      actorId: "system:subscription",
      targetType: "subscription",
      targetId: subscriptionId,
      createdAt: at,
    });
  }

  async forceCancelSubscription(input: {
    subscriptionId: string;
    reason: string;
    actorId: string;
  }): Promise<void> {
    const at = this.now();
    // ★ 예약 취소(cancelSchedules)는 서비스(forceCancelSubscription)가 선행한다. 여기선 상태 전이만.
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({
        status: "canceled",
        canceledAt: at,
        nextScheduleId: null,
        nextSchedulePaymentId: null,
        updatedAt: at,
      })
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId));
    await this.client.insert(schema.creditAuditLogs).values({
      action: "subscription.forced_cancel",
      actorType: "admin",
      actorId: input.actorId,
      targetType: "subscription",
      targetId: input.subscriptionId,
      after: { status: "canceled" },
      reason: input.reason,
      createdAt: at,
    });
  }

  async setCancelAtPeriodEnd(input: {
    subscriptionId: string;
    cancel: boolean;
  }): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({ cancelAtPeriodEnd: input.cancel, updatedAt: at })
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId));
  }

  async setPendingPlan(input: {
    subscriptionId: string;
    pendingPlanId: string | null;
  }): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({ pendingPlanId: input.pendingPlanId, updatedAt: at })
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId));
  }

  async updateBillingKey(input: {
    subscriptionId: string;
    billingKey: string;
    billingKeyIssuedAt: Date;
    cardSummary: { brand?: string; last4?: string } | null;
  }): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({
        billingKey: input.billingKey,
        billingKeyIssuedAt: input.billingKeyIssuedAt,
        cardSummary: input.cardSummary,
        updatedAt: at,
      })
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId));
    await this.client.insert(schema.creditAuditLogs).values({
      action: "billing_key.replaced",
      actorType: "system",
      actorId: "system:subscription",
      targetType: "subscription",
      targetId: input.subscriptionId,
      after: { cardSummary: input.cardSummary },
      createdAt: at,
    });
  }

  async recordBillingKeyDeleted(input: {
    subscriptionId: string;
    reason: string;
  }): Promise<void> {
    // 12.2 billing_key.deleted — 8.5 키 교체 시 구 키 삭제, 7.3 Deleted 웹훅 강등의 감사 근거.
    await this.client.insert(schema.creditAuditLogs).values({
      action: "billing_key.deleted",
      actorType: "system",
      actorId: "system:subscription",
      targetType: "subscription",
      targetId: input.subscriptionId,
      reason: input.reason,
      createdAt: this.now(),
    });
  }

  async updateSchedule(input: {
    subscriptionId: string;
    nextScheduleId: string | null;
    nextSchedulePaymentId: string | null;
  }): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.creditPlanSubscriptions)
      .set({
        nextScheduleId: input.nextScheduleId,
        nextSchedulePaymentId: input.nextSchedulePaymentId,
        updatedAt: at,
      })
      .where(eq(schema.creditPlanSubscriptions.id, input.subscriptionId));
  }

  // ── 예약용 선생성 주문 (8.2 step 5 / 8.3, 레드팀 B2) ──────────────────────
  async createPlanOrder(input: CreatePlanOrderInput): Promise<CreditOrderRecord> {
    const at = this.now();
    const [row] = await this.client
      .insert(schema.creditPaymentOrders)
      .values({
        id: input.id,
        paymentId: input.paymentId,
        walletId: input.walletId,
        userId: input.userId,
        orderType: input.orderType,
        planSubscriptionId: input.planSubscriptionId,
        amountKrw: input.amountKrw,
        creditsToGrant: input.creditsToGrant,
        krwPerCreditSnapshot: input.krwPerCreditSnapshot,
        status: "created",
        expiresAt: input.expiresAt,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return toOrderRecord(row!);
  }

  async expireCreatedOrdersForSubscription(subscriptionId: string): Promise<void> {
    const at = this.now();
    await this.client.execute(sql`
      UPDATE credit_payment_orders
      SET status = 'expired', updated_at = ${at.toISOString()}::timestamptz
      WHERE plan_subscription_id = ${subscriptionId}::uuid AND status = 'created'
    `);
  }

  // ── cron / inbox (8.3) ──────────────────────────────────────────────────
  async listRenewalDueSubscriptions(nowMinusGraceMs: number): Promise<CreditSubscriptionRecord[]> {
    const threshold = new Date(this.now().getTime() - nowMinusGraceMs).toISOString();
    const rows = await this.client.execute<Record<string, unknown>>(sql`
      SELECT * FROM credit_plan_subscriptions
      WHERE status = 'active' AND current_period_end < ${threshold}::timestamptz
      ORDER BY current_period_end ASC
      LIMIT 1000
    `);
    return rows.map(toSubscriptionRecordRaw);
  }

  async listFailedWebhookEvents(sinceMs: number): Promise<FailedWebhookEvent[]> {
    const since = new Date(this.now().getTime() - sinceMs).toISOString();
    const rows = await this.client.execute<Record<string, unknown>>(sql`
      SELECT id, webhook_id, event_type, payment_id, billing_key
      FROM portone_webhook_events
      WHERE processing_status = 'failed' AND created_at > ${since}::timestamptz
      ORDER BY created_at ASC
      LIMIT 1000
    `);
    return rows.map((r) => ({
      id: String(r.id),
      webhookId: String(r.webhook_id),
      eventType: String(r.event_type),
      paymentId: (r.payment_id as string | null) ?? null,
      billingKey: (r.billing_key as string | null) ?? null,
    }));
  }
}

// ── no-op 결과(status 가드에 걸린 갱신) ────────────────────────────────────
function renewNoOp(row: typeof schema.creditPlanSubscriptions.$inferSelect): RenewSubscriptionResult {
  const sub = toSubscriptionRecord(row);
  return {
    status: sub.status === "canceled" ? "canceled" : "active",
    grantedCredits: 0,
    planId: sub.planId,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    subscription: sub,
  };
}

// ── 매핑 ────────────────────────────────────────────────────────────────────
function toPlanRecord(row: typeof schema.creditPlans.$inferSelect): CreditPlanRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    monthlyPriceKrw: row.monthlyPriceKrw,
    monthlyCredits: Number(row.monthlyCredits),
    features: row.features,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
  };
}

function toSubscriptionRecord(
  row: typeof schema.creditPlanSubscriptions.$inferSelect,
): CreditSubscriptionRecord {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    planId: row.planId,
    status: row.status,
    billingKey: row.billingKey,
    billingKeyIssuedAt: row.billingKeyIssuedAt,
    cardSummary: row.cardSummary ?? null,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    nextScheduleId: row.nextScheduleId,
    nextSchedulePaymentId: row.nextSchedulePaymentId,
    retryCount: row.retryCount,
    pendingPlanId: row.pendingPlanId,
    canceledAt: row.canceledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSubscriptionRecordRaw(row: Record<string, unknown>): CreditSubscriptionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    walletId: String(row.wallet_id),
    planId: String(row.plan_id),
    status: String(row.status) as CreditSubscriptionRecord["status"],
    billingKey: String(row.billing_key),
    billingKeyIssuedAt: row.billing_key_issued_at ? new Date(String(row.billing_key_issued_at)) : null,
    cardSummary: (row.card_summary as { brand?: string; last4?: string } | null) ?? null,
    currentPeriodStart: new Date(String(row.current_period_start)),
    currentPeriodEnd: new Date(String(row.current_period_end)),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    nextScheduleId: (row.next_schedule_id as string | null) ?? null,
    nextSchedulePaymentId: (row.next_schedule_payment_id as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    pendingPlanId: (row.pending_plan_id as string | null) ?? null,
    canceledAt: row.canceled_at ? new Date(String(row.canceled_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function toOrderRecord(row: typeof schema.creditPaymentOrders.$inferSelect): CreditOrderRecord {
  return {
    id: row.id,
    paymentId: row.paymentId,
    walletId: row.walletId,
    userId: row.userId,
    orderType: row.orderType as CreditOrderRecord["orderType"],
    productId: row.productId,
    planSubscriptionId: row.planSubscriptionId,
    amountKrw: row.amountKrw,
    creditsToGrant: Number(row.creditsToGrant),
    krwPerCreditSnapshot: row.krwPerCreditSnapshot,
    status: row.status,
    portoneStatus: row.portoneStatus,
    portoneTxId: row.portoneTxId,
    payMethod: row.payMethod,
    paidAt: row.paidAt,
    failReason: row.failReason,
    refundedAmountKrw: row.refundedAmountKrw,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
