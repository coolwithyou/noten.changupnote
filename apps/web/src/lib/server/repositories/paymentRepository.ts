/**
 * 결제/충전 리포지토리 — 시스템 경로(P3, 설계 7장 / 9.1).
 *
 * ★ 규범:
 *   - 지급(purchase_grant)은 order.userId 로 user 컨텍스트를 세팅해 applyLedgerEntryTx 를 경유한다
 *     (5.2 단일 진입점). verifyAndGrant·웹훅·cron 은 세션이 없지만 order.userId 를 알기에 가능.
 *   - 멱등: purchase:{orderId} / refund:{orderId}:{cancellationId} (4.3).
 *   - 환불 회수는 반드시 lotSelection={targetLotIds}(레드팀 M1). consume_order 금지.
 *   - 콘솔 발 취소 shortfall: 회수 가능분만 회수 + refund.shortfall audit + 지갑 자동 frozen(7.4 레드팀 M3).
 *   - 웹훅 inbox: payloadDigest 는 화이트리스트 발췌만(원문 비저장, 레드팀 M5 PII).
 *
 * 세션 소유권 검증(order.userId === session.userId, 레드팀 M2)은 이 리포지토리가 아니라
 * API 라우트(checkout/complete)가 수행한다 — 이 포트는 세션 없는 내부 함수다.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  idempotencyKeys,
  type CreateOrderInput,
  type CreditOrderRecord,
  type CreditPaymentRepository,
  type CreditProductRecord,
  type OrderLotSnapshot,
} from "@cunote/core";
import type { CunoteDb } from "@/lib/server/db/client";
import { withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { applyLedgerEntryTx, insertAuditLog } from "./creditRepository";

interface Deps {
  client: CunoteDb;
  now?: () => Date;
}

export class DrizzlePaymentRepository implements CreditPaymentRepository {
  private readonly client: CunoteDb;
  private readonly now: () => Date;

  constructor(deps: Deps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
  }

  // ── 상품 ────────────────────────────────────────────────────────────────
  async listActiveProducts(): Promise<CreditProductRecord[]> {
    const rows = await this.client
      .select()
      .from(schema.creditProducts)
      .where(eq(schema.creditProducts.isActive, true))
      .orderBy(schema.creditProducts.displayOrder);
    return rows.map(toProductRecord);
  }

  async getActiveProductByCode(code: string): Promise<CreditProductRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditProducts)
      .where(and(eq(schema.creditProducts.code, code), eq(schema.creditProducts.isActive, true)))
      .limit(1);
    return row ? toProductRecord(row) : null;
  }

  // ── 주문 ────────────────────────────────────────────────────────────────
  async createOrder(input: CreateOrderInput): Promise<CreditOrderRecord> {
    const at = this.now();
    const [row] = await this.client
      .insert(schema.creditPaymentOrders)
      .values({
        id: input.id,
        paymentId: input.paymentId,
        walletId: input.walletId,
        userId: input.userId,
        orderType: input.orderType,
        productId: input.productId,
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

  async getOrderByPaymentId(paymentId: string): Promise<CreditOrderRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPaymentOrders)
      .where(eq(schema.creditPaymentOrders.paymentId, paymentId))
      .limit(1);
    return row ? toOrderRecord(row) : null;
  }

  async getOrderById(orderId: string): Promise<CreditOrderRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditPaymentOrders)
      .where(eq(schema.creditPaymentOrders.id, orderId))
      .limit(1);
    return row ? toOrderRecord(row) : null;
  }

  async getProductById(productId: string): Promise<CreditProductRecord | null> {
    const [row] = await this.client
      .select()
      .from(schema.creditProducts)
      .where(eq(schema.creditProducts.id, productId))
      .limit(1);
    return row ? toProductRecord(row) : null;
  }

  async listOrdersForWallet(input: {
    walletId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{ orders: CreditOrderRecord[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(Math.trunc(input.limit) || 20, 1), 100);
    const cursor = parseCursor(input.cursor);
    const cursorClause = cursor
      ? sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : sql.raw("");
    const rows = await this.client.execute<Record<string, unknown>>(sql`
      SELECT * FROM credit_payment_orders
      WHERE wallet_id = ${input.walletId}::uuid ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const orders = page.map(toOrderRecordRaw);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(String(last.created_at)), String(last.id)) : null;
    return { orders, nextCursor, hasMore };
  }

  async countOpenOrdersForUser(userId: string): Promise<number> {
    const [row] = await this.client.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM credit_payment_orders
      WHERE user_id = ${userId}::uuid AND status IN ('created','pending')
    `);
    return Number(row?.n ?? 0);
  }

  async countRecentOrdersForUser(userId: string, sinceMs: number): Promise<number> {
    const since = new Date(this.now().getTime() - sinceMs).toISOString();
    const [row] = await this.client.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM credit_payment_orders
      WHERE user_id = ${userId}::uuid AND created_at >= ${since}::timestamptz
    `);
    return Number(row?.n ?? 0);
  }

  // ── verifyAndGrant 지급 (7.2 step 4) ──────────────────────────────────────
  async grantPurchaseForOrder(input: {
    orderId: string;
    portone: { status: string; txId: string | null; payMethod: string | null };
    lotExpiresAt: Date | null;
  }): Promise<{ grantedCredits: number; balance: number }> {
    const at = this.now();
    // 주문(userId·walletId·creditsToGrant)을 먼저 조회(세션 컨텍스트 밖).
    const [order] = await this.client
      .select()
      .from(schema.creditPaymentOrders)
      .where(eq(schema.creditPaymentOrders.id, input.orderId))
      .limit(1);
    if (!order) throw new Error(`주문을 찾을 수 없습니다: ${input.orderId}`);

    // order.userId 로 user 컨텍스트를 세팅해 단일 진입점(applyLedgerEntryTx)을 경유한다.
    return withCunoteDbUser(this.client, order.userId, async (tx) => {
      // 1. purchase_grant 지급(멱등 key=purchase:{orderId}). 지급 lot 에 paymentOrderId 연결.
      const entry = await applyLedgerEntryTx(
        tx,
        {
          walletId: order.walletId,
          entryType: "purchase_grant",
          amountCredits: order.creditsToGrant,
          idempotencyKey: idempotencyKeys.purchase(order.id),
          actorType: "system",
          actorId: "system:payment",
          reason: "크레딧 충전",
          paymentOrderId: order.id,
          grantLot: {
            source: "purchase",
            expiresAt: input.lotExpiresAt,
            paymentOrderId: order.id,
          },
        },
        () => at,
      );

      // 2. 주문 상태 전이(멱등 — 이미 paid 여도 no-op 성격). paid 로만 전이.
      await tx.execute(sql`
        UPDATE credit_payment_orders
        SET status = 'paid',
            paid_at = COALESCE(paid_at, ${at.toISOString()}::timestamptz),
            portone_status = ${input.portone.status},
            portone_tx_id = ${input.portone.txId},
            pay_method = ${input.portone.payMethod},
            updated_at = ${at.toISOString()}::timestamptz
        WHERE id = ${order.id}::uuid AND status <> 'refunded' AND status <> 'partial_refunded'
      `);

      // 3. audit_log(payment.paid). (멱등: 지급이 no-op 이었으면 이미 기록됨 — 중복 audit 는 무해)
      await insertAuditLog(tx, {
        action: "payment.paid",
        actorType: "system",
        actorId: "system:payment",
        targetType: "payment_order",
        targetId: order.id,
        after: {
          grantedCredits: order.creditsToGrant,
          ledgerEntryId: entry.id,
          portoneStatus: input.portone.status,
        },
        at,
      });

      // 지급 후 지갑 balance.
      const [wallet] = await tx.execute<{ balance_credits: number }>(
        sql`SELECT balance_credits FROM credit_wallets WHERE id = ${order.walletId}::uuid`,
      );
      return {
        grantedCredits: order.creditsToGrant,
        balance: Number(wallet?.balance_credits ?? 0),
      };
    });
  }

  async markOrderMismatch(input: {
    orderId: string;
    portoneStatus: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    const at = this.now();
    const [order] = await this.client
      .select({ userId: schema.creditPaymentOrders.userId, walletId: schema.creditPaymentOrders.walletId })
      .from(schema.creditPaymentOrders)
      .where(eq(schema.creditPaymentOrders.id, input.orderId))
      .limit(1);
    await this.client.execute(sql`
      UPDATE credit_payment_orders
      SET status = 'failed', portone_status = ${input.portoneStatus},
          fail_reason = 'payment.mismatch', updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${input.orderId}::uuid AND status IN ('created','pending','expired')
    `);
    await this.client.insert(schema.creditAuditLogs).values({
      action: "payment.mismatch",
      actorType: "system",
      actorId: "system:payment",
      targetType: "payment_order",
      targetId: input.orderId,
      after: input.detail,
      createdAt: at,
    });
  }

  async markOrderFailed(input: {
    orderId: string;
    reason: string;
    portoneStatus?: string | null;
  }): Promise<void> {
    const at = this.now();
    await this.client.execute(sql`
      UPDATE credit_payment_orders
      SET status = 'failed', fail_reason = ${input.reason},
          portone_status = ${input.portoneStatus ?? null},
          updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${input.orderId}::uuid AND status IN ('created','pending','expired')
    `);
  }

  async markOrderExpired(orderId: string): Promise<void> {
    const at = this.now();
    await this.client.execute(sql`
      UPDATE credit_payment_orders
      SET status = 'expired', updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${orderId}::uuid AND status IN ('created','pending')
    `);
  }

  async listDueOrders(limit: number): Promise<CreditOrderRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 100, 1), 1000);
    const rows = await this.client.execute<Record<string, unknown>>(sql`
      SELECT * FROM credit_payment_orders
      WHERE status IN ('created','pending') AND expires_at < now()
      ORDER BY expires_at ASC
      LIMIT ${bounded}
    `);
    return rows.map(toOrderRecordRaw);
  }

  // ── 환불 ────────────────────────────────────────────────────────────────
  async getOrderLots(orderId: string): Promise<OrderLotSnapshot[]> {
    const rows = await this.client
      .select({
        lotId: schema.creditLots.id,
        source: schema.creditLots.source,
        initialCredits: schema.creditLots.initialCredits,
        remainingCredits: schema.creditLots.remainingCredits,
        status: schema.creditLots.status,
      })
      .from(schema.creditLots)
      .where(eq(schema.creditLots.paymentOrderId, orderId));
    return rows.map((r) => ({
      lotId: r.lotId,
      source: r.source,
      initialCredits: Number(r.initialCredits),
      remainingCredits: Number(r.remainingCredits),
      status: r.status,
    }));
  }

  async syncRefundForOrder(input: {
    orderId: string;
    cancellationId: string;
    targetLotIds: string[];
    recoverCredits: number;
    refundedAmountKrw: number;
    fullRefund: boolean;
    reason: string;
  }): Promise<{ recovered: number; shortfall: number; frozen: boolean }> {
    // 콘솔 발 취소 동기화(7.4 레드팀 M3). 완결 audit action = refund.synced, actor=system:payment.
    const result = await this.applyRefundLedger({
      ...input,
      completedAction: "refund.synced",
      actorType: "system",
      actorId: "system:payment",
    });
    return { recovered: result.recovered, shortfall: result.shortfall, frozen: result.frozen };
  }

  async executeRefundForOrder(input: {
    orderId: string;
    cancellationId: string;
    targetLotIds: string[];
    recoverCredits: number;
    refundedAmountKrw: number;
    fullRefund: boolean;
    reason: string;
    actorId: string;
    actorType: "admin" | "system";
  }): Promise<{ recovered: number; shortfall: number; frozen: boolean; entryId: string | null }> {
    // admin 발 환불 실행(7.4 executeRefund). 완결 audit action = refund.executed, before/after 포함.
    return this.applyRefundLedger({
      orderId: input.orderId,
      cancellationId: input.cancellationId,
      targetLotIds: input.targetLotIds,
      recoverCredits: input.recoverCredits,
      refundedAmountKrw: input.refundedAmountKrw,
      fullRefund: input.fullRefund,
      reason: input.reason,
      completedAction: "refund.executed",
      actorType: input.actorType,
      actorId: input.actorId,
    });
  }

  async recordRefundFailedAudit(input: {
    orderId: string;
    reason: string;
    detail: Record<string, unknown>;
    actorId: string;
    actorType: "admin" | "system";
  }): Promise<void> {
    const at = this.now();
    await this.client.insert(schema.creditAuditLogs).values({
      action: "refund.failed",
      actorType: input.actorType,
      actorId: input.actorId,
      targetType: "payment_order",
      targetId: input.orderId,
      after: input.detail,
      reason: input.reason,
      createdAt: at,
    });
  }

  /**
   * refund_deduct 분개 + lot revoke + order 상태전이 + shortfall/frozen 방어를 단일 트랜잭션으로 집행.
   * 콘솔 발 동기화(refund.synced)와 admin 발 실행(refund.executed)이 공유하는 원장 코어.
   * 멱등: refund:{orderId}:{cancellationId}. 회수는 반드시 targetLotIds(레드팀 M1).
   */
  private async applyRefundLedger(input: {
    orderId: string;
    cancellationId: string;
    targetLotIds: string[];
    recoverCredits: number;
    refundedAmountKrw: number;
    fullRefund: boolean;
    reason: string;
    completedAction: "refund.synced" | "refund.executed";
    actorType: "system" | "admin";
    actorId: string;
  }): Promise<{ recovered: number; shortfall: number; frozen: boolean; entryId: string | null }> {
    const at = this.now();
    const [order] = await this.client
      .select()
      .from(schema.creditPaymentOrders)
      .where(eq(schema.creditPaymentOrders.id, input.orderId))
      .limit(1);
    if (!order) throw new Error(`주문을 찾을 수 없습니다: ${input.orderId}`);

    return withCunoteDbUser(this.client, order.userId, async (tx) => {
      let recovered = 0;
      let shortfall = 0;
      let entryId: string | null = null;
      const beforeStatus = order.status;

      if (input.recoverCredits > 0 && input.targetLotIds.length > 0) {
        // refund_deduct: 반드시 targetLotIds(레드팀 M1). shortfall 은 회수 가능분만.
        const entry = await applyLedgerEntryTx(
          tx,
          {
            walletId: order.walletId,
            entryType: "refund_deduct",
            amountCredits: -input.recoverCredits,
            idempotencyKey: idempotencyKeys.refund(order.id, input.cancellationId),
            lotSelection: { targetLotIds: input.targetLotIds },
            actorType: input.actorType,
            actorId: input.actorId,
            reason: input.reason,
            paymentOrderId: order.id,
          },
          () => at,
        );
        entryId = entry.id;
        recovered = -entry.amountCredits; // effectiveAmount 는 회수 가능분(shortfall 클램프 반영).
        shortfall = input.recoverCredits - recovered;

        // 전액 회수된 lot 은 revoked 로 마감.
        await tx.execute(sql`
          UPDATE credit_lots
          SET status = 'revoked', updated_at = ${at.toISOString()}::timestamptz
          WHERE id = ANY(${sql`ARRAY[${sql.join(
            input.targetLotIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
            AND remaining_credits <= 0
        `);
      }

      // 주문 상태 전이 + refundedAmountKrw 누적.
      const newStatus = input.fullRefund ? "refunded" : "partial_refunded";
      await tx.execute(sql`
        UPDATE credit_payment_orders
        SET status = ${newStatus}::credit_order_status,
            refunded_amount_krw = refunded_amount_krw + ${input.refundedAmountKrw},
            updated_at = ${at.toISOString()}::timestamptz
        WHERE id = ${order.id}::uuid
      `);

      // shortfall 발생 시: refund.shortfall audit + 지갑 자동 frozen(7.4 레드팀 M3).
      let frozen = false;
      if (shortfall > 0) {
        await tx.execute(sql`
          UPDATE credit_wallets
          SET status = 'frozen',
              frozen_reason = COALESCE(frozen_reason, 'refund_shortfall'),
              updated_at = ${at.toISOString()}::timestamptz
          WHERE id = ${order.walletId}::uuid
        `);
        frozen = true;
        await insertAuditLog(tx, {
          action: "refund.shortfall",
          actorType: input.actorType,
          actorId: input.actorId,
          targetType: "wallet",
          targetId: order.walletId,
          after: { orderId: order.id, cancellationId: input.cancellationId, shortfall, recovered },
          reason: input.reason,
          at,
        });
      }

      await insertAuditLog(tx, {
        action: input.completedAction,
        actorType: input.actorType,
        actorId: input.actorId,
        targetType: "payment_order",
        targetId: order.id,
        before: { status: beforeStatus },
        after: {
          cancellationId: input.cancellationId,
          recovered,
          shortfall,
          refundedAmountKrw: input.refundedAmountKrw,
          fullRefund: input.fullRefund,
          status: newStatus,
        },
        reason: input.reason,
        at,
      });

      return { recovered, shortfall, frozen, entryId };
    });
  }

  // ── 웹훅 inbox ────────────────────────────────────────────────────────────
  async insertWebhookEvent(input: {
    webhookId: string;
    eventType: string;
    paymentId: string | null;
    billingKey: string | null;
    payloadDigest: Record<string, unknown>;
  }): Promise<{ id: string; duplicate: boolean }> {
    const at = this.now();
    try {
      const [row] = await this.client
        .insert(schema.portoneWebhookEvents)
        .values({
          webhookId: input.webhookId,
          eventType: input.eventType,
          paymentId: input.paymentId,
          billingKey: input.billingKey,
          payloadDigest: input.payloadDigest,
          processingStatus: "received",
          createdAt: at,
        })
        .returning({ id: schema.portoneWebhookEvents.id });
      return { id: row!.id, duplicate: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const [existing] = await this.client
          .select({ id: schema.portoneWebhookEvents.id })
          .from(schema.portoneWebhookEvents)
          .where(eq(schema.portoneWebhookEvents.webhookId, input.webhookId))
          .limit(1);
        return { id: existing?.id ?? "", duplicate: true };
      }
      throw error;
    }
  }

  async updateWebhookEvent(input: {
    id: string;
    processingStatus: "processed" | "failed" | "skipped";
    error?: string | null;
  }): Promise<void> {
    const at = this.now();
    await this.client
      .update(schema.portoneWebhookEvents)
      .set({
        processingStatus: input.processingStatus,
        processedAt: at,
        error: input.error ?? null,
      })
      .where(eq(schema.portoneWebhookEvents.id, input.id));
  }
}

// ── 매핑 ──────────────────────────────────────────────────────────────────
function toProductRecord(row: typeof schema.creditProducts.$inferSelect): CreditProductRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    amountKrw: row.amountKrw,
    credits: Number(row.credits),
    bonusCredits: Number(row.bonusCredits),
    isActive: row.isActive,
    displayOrder: row.displayOrder,
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

function toOrderRecordRaw(row: Record<string, unknown>): CreditOrderRecord {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    walletId: String(row.wallet_id),
    userId: String(row.user_id),
    orderType: String(row.order_type) as CreditOrderRecord["orderType"],
    productId: (row.product_id as string | null) ?? null,
    planSubscriptionId: (row.plan_subscription_id as string | null) ?? null,
    amountKrw: Number(row.amount_krw),
    creditsToGrant: Number(row.credits_to_grant),
    krwPerCreditSnapshot: Number(row.krw_per_credit_snapshot),
    status: String(row.status) as CreditOrderRecord["status"],
    portoneStatus: (row.portone_status as string | null) ?? null,
    portoneTxId: (row.portone_tx_id as string | null) ?? null,
    payMethod: (row.pay_method as string | null) ?? null,
    paidAt: row.paid_at ? new Date(String(row.paid_at)) : null,
    failReason: (row.fail_reason as string | null) ?? null,
    refundedAmountKrw: Number(row.refunded_amount_krw ?? 0),
    expiresAt: new Date(String(row.expires_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function parseCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep === -1) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
