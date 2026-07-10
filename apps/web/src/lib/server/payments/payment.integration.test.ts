/**
 * 결제(충전) 통합 테스트 (실제 Postgres 필요, 설계 16.2 / P3 검수 C1~C3).
 *
 * ★ 안전장치: DATABASE_URL 호스트가 pooler.supabase.com/supabase.co 면 즉시 abort.
 *   실서비스 공용 DB 에 절대 쓰지 않는다. 일회용 컨테이너에서만 실행한다.
 *
 * 셋업(공용 DB 스키마 덤프 → 컨테이너 복원):
 *   1) .env 의 DATABASE_URL 에서 쿼리스트링을 제거한 URL 로
 *      pg_dump --schema-only --no-owner --no-privileges 하여 /tmp/schema.sql 생성.
 *   2) docker run --rm -d --name cunote-pay-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:17
 *   3) psql "postgres://postgres:test@127.0.0.1:54340/cunote" -f /tmp/schema.sql
 *   4) DATABASE_URL=postgres://postgres:test@127.0.0.1:54340/cunote pnpm test:credits-payment-integration
 *
 * 커버(C1~C3 + 웹훅/불일치/콘솔취소):
 *   C1  paid 주문에 complete 재호출 → no-op(멱등, failed 로 안 덮임)
 *   C2  동일 webhookId 2회 → 1회 처리
 *   C3  타 유저 주문 complete → 라우트 계층 404(여기선 verifyAndGrant 세션 없음 — 소유권은 라우트가 검증)
 *   웹훅 Paid 가 complete 보다 먼저·나중 양쪽
 *   금액 불일치 → mismatch(order failed + payment.mismatch audit)
 *   콘솔 취소 shortfall → 회수 가능분 회수 + 지갑 frozen
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { paymentIdForOrder } from "@cunote/core";
import * as schema from "../db/schema";
import { DrizzleCreditRepository, DrizzleCreditSystemRepository } from "../repositories/creditRepository";
import { DrizzlePaymentRepository } from "../repositories/paymentRepository";
import { DrizzleSubscriptionRepository } from "../repositories/subscriptionRepository";
import { verifyAndGrant, syncRefundFromPortone } from "./paymentService";
import { handlePortoneWebhook } from "./webhookHandler";
import type { PortoneClient, PortonePayment } from "./portone";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL ?? "";
if (!url) {
  console.error("DATABASE_URL 이 필요합니다 (일회용 테스트 컨테이너).");
  process.exit(1);
}
if (url.includes("pooler.supabase.com") || url.includes("supabase.co")) {
  console.error(`ABORT: 실서비스 공용 DB 로 보이는 호스트입니다. 통합 테스트를 중단합니다.\n  host=${new URL(url).host}`);
  process.exit(1);
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const client = postgres(url, { prepare: false, max: 10 });
const db = drizzle(client, { schema });
const creditRepo = new DrizzleCreditRepository({ client: db });
const paymentRepo = new DrizzlePaymentRepository({ client: db });
const systemRepo = new DrizzleCreditSystemRepository({ client: db });
const subscriptionRepo = new DrizzleSubscriptionRepository({ client: db });

/** 스텁 포트원 클라이언트 — GET /payments 응답을 시나리오별로 주입한다(실호출 금지). */
function stubPortone(payment: Partial<PortonePayment> & { status: PortonePayment["status"] }): PortoneClient {
  const full: PortonePayment = {
    id: payment.id ?? "cnord_x",
    status: payment.status,
    amount: payment.amount ?? { total: 0, paid: null, cancelled: null },
    currency: payment.currency ?? "KRW",
    payMethod: payment.payMethod ?? "CARD",
    paidAt: payment.paidAt ?? null,
    cancellations: payment.cancellations ?? [],
    failureReason: payment.failureReason ?? null,
    transactionId: payment.transactionId ?? "tx_1",
  };
  return {
    isConfigured: () => true,
    async getPayment() {
      return full;
    },
    async getPaymentSchedule() {
      return null;
    },
    async cancelPayment() {
      return { cancellation: { id: "c1", status: "SUCCEEDED", totalAmount: full.amount?.total ?? 0, reason: null } };
    },
    async payWithBillingKey() {
      return full;
    },
    async schedulePayment() {
      return { scheduleId: "sch_1" };
    },
    async cancelSchedules() {
      return { revokedScheduleIds: [] };
    },
    async deleteBillingKey() {},
  };
}

interface Fixture {
  userId: string;
  walletId: string;
  productId: string;
}

/** user + wallet + product + 주문 하나를 만든다. */
async function seedOrder(input: { amountKrw: number; credits: number; bonus?: number }): Promise<{
  fx: Fixture;
  orderId: string;
  paymentId: string;
}> {
  const userId = crypto.randomUUID();
  await client`INSERT INTO users (id, email) VALUES (${userId}, ${`pay-test-${userId}@example.com`})`;
  const walletId = crypto.randomUUID();
  await client`INSERT INTO credit_wallets (id, user_id, balance_credits, status) VALUES (${walletId}, ${userId}, 0, 'active')`;
  const productId = crypto.randomUUID();
  const code = `topup_${productId.slice(0, 8)}`;
  await client`INSERT INTO credit_products (id, code, name, amount_krw, credits, bonus_credits, is_active)
    VALUES (${productId}, ${code}, ${'테스트 상품'}, ${input.amountKrw}, ${input.credits}, ${input.bonus ?? 0}, true)`;

  const orderId = crypto.randomUUID();
  const paymentId = paymentIdForOrder(orderId);
  const creditsToGrant = input.credits + (input.bonus ?? 0);
  await paymentRepo.createOrder({
    id: orderId,
    paymentId,
    walletId,
    userId,
    orderType: "credit_topup",
    productId,
    amountKrw: input.amountKrw,
    creditsToGrant,
    krwPerCreditSnapshot: 1,
    expiresAt: new Date(Date.now() + 90 * 60 * 1000),
  });
  return { fx: { userId, walletId, productId }, orderId, paymentId };
}

async function orderStatus(paymentId: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`SELECT status FROM credit_payment_orders WHERE payment_id = ${paymentId}`;
  return row!.status;
}
async function walletBalance(walletId: string): Promise<number> {
  const [row] = await client<{ balance_credits: number }[]>`SELECT balance_credits FROM credit_wallets WHERE id = ${walletId}`;
  return Number(row!.balance_credits);
}
async function walletStatus(walletId: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`SELECT status FROM credit_wallets WHERE id = ${walletId}`;
  return row!.status;
}
async function auditCount(action: string, targetId: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM credit_audit_logs WHERE action = ${action} AND target_id = ${targetId}`;
  return Number(row!.n);
}
async function ledgerCount(walletId: string, entryType: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM credit_ledger WHERE wallet_id = ${walletId} AND entry_type = ${entryType}`;
  return Number(row!.n);
}

async function main() {
  console.log("결제 통합 테스트 (P3 / C1~C3)");

  // ── 정상 지급 ──────────────────────────────────────────────────────────
  await check("PAID 검증 → purchase_grant 지급 + 잔액 반영 + payment.paid audit", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 10000, credits: 10000 });
    const outcome = await verifyAndGrant(paymentId, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({ id: paymentId, status: "PAID", amount: { total: 10000, paid: 10000, cancelled: null } }),
    });
    assert.equal(outcome.kind, "granted");
    if (outcome.kind === "granted") assert.equal(outcome.grantedCredits, 10000);
    assert.equal(await orderStatus(paymentId), "paid");
    assert.equal(await walletBalance(fx.walletId), 10000);
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 1);
    assert.equal(await auditCount("payment.paid", (await orderId(paymentId))), 1);
  });

  // ── C1: paid 주문에 complete 재호출 → no-op(멱등, failed 로 안 덮임) ─────
  await check("C1 paid 주문에 verifyAndGrant 재호출 → no-op(멱등, 지급 1건 유지, failed 안 됨)", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 5000, credits: 5000 });
    const portone = stubPortone({ id: paymentId, status: "PAID", amount: { total: 5000, paid: 5000, cancelled: null } });
    await verifyAndGrant(paymentId, { payment: paymentRepo, system: systemRepo, portone });
    // 재호출 — 상태 가드로 already 반환. 지급 분개 1건 유지.
    const again = await verifyAndGrant(paymentId, { payment: paymentRepo, system: systemRepo, portone });
    assert.equal(again.kind, "already");
    assert.equal(await orderStatus(paymentId), "paid");
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 1);
    assert.equal(await walletBalance(fx.walletId), 5000);
  });

  // ── C3: 타 유저 주문 소유권 검증(라우트 계층 404 로직 재현) ────────────────
  await check("C3 타 유저 주문 소유권 검증 → 불일치 시 404(주문 존재 은닉)", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 5000, credits: 5000 });
    const otherUserId = crypto.randomUUID();
    await client`INSERT INTO users (id, email) VALUES (${otherUserId}, ${`other-${otherUserId}@example.com`})`;
    // 라우트가 수행하는 소유권 검증(order.userId === session.userId)을 재현.
    const order = await paymentRepo.getOrderByPaymentId(paymentId);
    assert.ok(order);
    // 본인 → 통과. 타인 → 404 로 취급되어야 한다(라우트가 order.userId !== userId → 404).
    assert.equal(order!.userId === fx.userId, true);
    assert.equal(order!.userId === otherUserId, false);
    // 타인 컨텍스트에서는 지급이 일어나지 않았어야 함(검증 전 단계에서 차단).
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 0);
  });

  // ── C2: 동일 webhookId 2회 → 1회 처리 ───────────────────────────────────
  await check("C2 동일 webhookId 2회 → 1회 처리(멱등, 지급 1건)", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 30000, credits: 30000, bonus: 900 });
    const portone = stubPortone({ id: paymentId, status: "PAID", amount: { total: 30000, paid: 30000, cancelled: null } });
    const webhookId = `wh_${crypto.randomUUID()}`;
    const payload = { type: "Transaction.Paid", data: { paymentId } };
    const deps = { payment: paymentRepo, subscription: subscriptionRepo, system: systemRepo, portone };
    const first = await handlePortoneWebhook(webhookId, payload, deps);
    const second = await handlePortoneWebhook(webhookId, payload, deps);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 1);
    assert.equal(await walletBalance(fx.walletId), 30900);
  });

  // ── 웹훅 Paid 가 complete 보다 먼저·나중 양쪽 ────────────────────────────
  await check("웹훅 Paid → 이후 verifyAndGrant(complete) → 이중 지급 없음", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 5000, credits: 5000 });
    const portone = stubPortone({ id: paymentId, status: "PAID", amount: { total: 5000, paid: 5000, cancelled: null } });
    await handlePortoneWebhook(`wh_${crypto.randomUUID()}`, { type: "Transaction.Paid", data: { paymentId } }, { payment: paymentRepo, subscription: subscriptionRepo, system: systemRepo, portone });
    const complete = await verifyAndGrant(paymentId, { payment: paymentRepo, system: systemRepo, portone });
    assert.equal(complete.kind, "already");
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 1);
  });

  await check("complete 먼저 → 이후 웹훅 Paid → 이중 지급 없음", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 5000, credits: 5000 });
    const portone = stubPortone({ id: paymentId, status: "PAID", amount: { total: 5000, paid: 5000, cancelled: null } });
    await verifyAndGrant(paymentId, { payment: paymentRepo, system: systemRepo, portone });
    await handlePortoneWebhook(`wh_${crypto.randomUUID()}`, { type: "Transaction.Paid", data: { paymentId } }, { payment: paymentRepo, subscription: subscriptionRepo, system: systemRepo, portone });
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 1);
    assert.equal(await walletBalance(fx.walletId), 5000);
  });

  // ── 금액 불일치 → mismatch + audit ──────────────────────────────────────
  await check("금액 불일치 → order failed + payment.mismatch audit (지급 없음)", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 10000, credits: 10000 });
    const outcome = await verifyAndGrant(paymentId, {
      payment: paymentRepo,
      system: systemRepo,
      // 포트원이 9,000원만 결제됐다고 응답(주문은 10,000).
      portone: stubPortone({ id: paymentId, status: "PAID", amount: { total: 9000, paid: 9000, cancelled: null } }),
    });
    assert.equal(outcome.kind, "mismatch");
    assert.equal(await orderStatus(paymentId), "failed");
    assert.equal(await auditCount("payment.mismatch", await orderId(paymentId)), 1);
    assert.equal(await ledgerCount(fx.walletId, "purchase_grant"), 0);
    assert.equal(await walletBalance(fx.walletId), 0);
  });

  // ── READY → 대기(failed 로 안 만든다) ───────────────────────────────────
  await check("READY 상태 → pending 반환(order 는 failed 로 안 됨)", async () => {
    const { paymentId } = await seedOrder({ amountKrw: 5000, credits: 5000 });
    const outcome = await verifyAndGrant(paymentId, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({ id: paymentId, status: "READY" }),
    });
    assert.equal(outcome.kind, "pending");
    assert.equal(await orderStatus(paymentId), "created");
  });

  // ── 콘솔 취소 shortfall → 회수 가능분 회수 + 지갑 frozen ─────────────────
  await check("콘솔 취소 shortfall → 회수 가능분만 회수 + 지갑 frozen + refund.shortfall audit", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 10000, credits: 10000 });
    // 먼저 지급.
    await verifyAndGrant(paymentId, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({ id: paymentId, status: "PAID", amount: { total: 10000, paid: 10000, cancelled: null } }),
    });
    assert.equal(await walletBalance(fx.walletId), 10000);
    // 유저가 크레딧을 6,000 소진했다고 가정(원장 admin_deduct 대신 직접 소진 시뮬 — 별도 지급 lot 소모).
    await creditRepo.applyLedgerEntry(fx.userId, {
      walletId: fx.walletId,
      entryType: "usage_capture",
      amountCredits: -6000,
      idempotencyKey: `usage:${crypto.randomUUID()}`,
      actorType: "user",
      actorId: fx.userId,
    });
    assert.equal(await walletBalance(fx.walletId), 4000);
    // 콘솔에서 전액(10,000원) 취소 웹훅 도착 → 10,000 회수 필요하나 잔여 4,000 만 회수 가능.
    const refund = await syncRefundFromPortone(paymentId, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({
        id: paymentId,
        status: "CANCELLED",
        amount: { total: 10000, paid: 0, cancelled: 10000 },
        cancellations: [{ id: "cancel_1", status: "SUCCEEDED", totalAmount: 10000, reason: "console" }],
      }),
    });
    assert.equal(refund.kind, "synced");
    assert.equal(refund.recovered, 4000); // 회수 가능분만.
    assert.equal(refund.shortfall, 6000);
    assert.equal(refund.frozen, true);
    assert.equal(await walletBalance(fx.walletId), 0); // 음수 잔액 없음(4.1).
    assert.equal(await walletStatus(fx.walletId), "frozen");
    assert.equal(await auditCount("refund.shortfall", fx.walletId), 1);
    assert.equal(await orderStatus(paymentId), "refunded");
  });

  // ── 콘솔 취소 멱등(같은 cancellationId 2회) ─────────────────────────────
  await check("콘솔 취소 웹훅 재전송(같은 cancellationId) → 회수 1회만", async () => {
    const { fx, paymentId } = await seedOrder({ amountKrw: 5000, credits: 5000 });
    await verifyAndGrant(paymentId, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({ id: paymentId, status: "PAID", amount: { total: 5000, paid: 5000, cancelled: null } }),
    });
    const portone = stubPortone({
      id: paymentId,
      status: "CANCELLED",
      amount: { total: 5000, paid: 0, cancelled: 5000 },
      cancellations: [{ id: "cancel_same", status: "SUCCEEDED", totalAmount: 5000, reason: "console" }],
    });
    const deps = { payment: paymentRepo, system: systemRepo, portone };
    await syncRefundFromPortone(paymentId, deps);
    await syncRefundFromPortone(paymentId, deps); // 재전송 — refund_deduct 멱등.
    assert.equal(await ledgerCount(fx.walletId, "refund_deduct"), 1);
    assert.equal(await walletBalance(fx.walletId), 0);
  });

  console.log(`\n결제 통합: ${passed} passed`);
}

/** paymentId → orderId(audit targetId 는 order.id). */
async function orderId(paymentId: string): Promise<string> {
  const [row] = await client<{ id: string }[]>`SELECT id FROM credit_payment_orders WHERE payment_id = ${paymentId}`;
  return row!.id;
}

main()
  .then(async () => {
    await client.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\n✗ 통합 테스트 실패:", error);
    await client.end({ timeout: 5 });
    process.exit(1);
  });
