/**
 * 환불 실행 통합 테스트 (실제 Postgres 필요, 설계 7.4 executeRefund / 9.3 admin 결제 실행 경로).
 *
 * ★ 안전장치: DATABASE_URL 호스트가 pooler.supabase.com/supabase.co 면 즉시 abort.
 *   실서비스 공용 DB 에 절대 쓰지 않는다. 일회용 컨테이너에서만 실행한다(payment.integration.test.ts 동일).
 *
 * 셋업(공용 DB 스키마 덤프 → 컨테이너 복원):
 *   1) pg_dump --schema-only --no-owner --no-privileges → /tmp/schema.sql
 *   2) docker run --rm -d --name cunote-pay-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:17
 *   3) psql "postgres://postgres:test@127.0.0.1:54340/cunote" -f /tmp/schema.sql
 *   4) DATABASE_URL=postgres://postgres:test@127.0.0.1:54340/cunote pnpm test:credits-refund-integration
 *
 * 시나리오(7.4 + DoD):
 *   R1  청약철회 미사용 전액 환불(SUCCEEDED → refund_deduct targetLotIds + lot revoked + order refunded)
 *   R2  부분 사용 부분 환불(원금 소진분만 차감, 회수는 잔여 전체)
 *   R3  임의 환불(7일 초과) 보너스 회수
 *   R4  환불 불가(보너스 lot 뿐 = admin_grant/promo만) → refundable=false, 실행 안 함
 *   R5  REQUESTED → 분개 없음·대기 → 이후 Cancelled 웹훅으로 완결(syncRefundFromPortone 합류·멱등)
 *   R6  FAILED → 오류 + refund.failed audit
 *   R7  동일 주문 재실행 멱등(SUCCEEDED 재호출 → refund_deduct 1건 유지)
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { paymentIdForOrder } from "@cunote/core";
import * as schema from "../db/schema";
import { DrizzleCreditRepository, DrizzleCreditSystemRepository } from "../repositories/creditRepository";
import { DrizzlePaymentRepository } from "../repositories/paymentRepository";
import { DrizzleSubscriptionRepository } from "../repositories/subscriptionRepository";
import { executeRefund, previewRefund, syncRefundFromPortone } from "./paymentService";
import { handlePortoneWebhook } from "./webhookHandler";
import type { PortoneClient, PortonePayment, PortoneCancellation } from "./portone";

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

interface StubOptions {
  payment: Partial<PortonePayment> & { status: PortonePayment["status"] };
  /** cancelPayment 가 반환할 cancellation(SUCCEEDED/REQUESTED/FAILED). */
  cancelResult?: PortoneCancellation;
}

/** 스텁 포트원 — getPayment/cancelPayment 를 시나리오별로 주입(실호출 금지). */
function stubPortone(opts: StubOptions): PortoneClient {
  const full: PortonePayment = {
    id: opts.payment.id ?? "cnord_x",
    status: opts.payment.status,
    amount: opts.payment.amount ?? { total: 0, paid: null, cancelled: null },
    currency: opts.payment.currency ?? "KRW",
    payMethod: opts.payment.payMethod ?? "CARD",
    paidAt: opts.payment.paidAt ?? null,
    cancellations: opts.payment.cancellations ?? [],
    failureReason: opts.payment.failureReason ?? null,
    transactionId: opts.payment.transactionId ?? "tx_1",
  };
  const cancelResult: PortoneCancellation =
    opts.cancelResult ?? { id: "c1", status: "SUCCEEDED", totalAmount: full.amount?.total ?? 0, reason: null };
  return {
    isConfigured: () => true,
    async getPayment() {
      return full;
    },
    async getPaymentSchedule() {
      return null;
    },
    async cancelPayment(input) {
      // 실제 취소 금액을 totalAmount 에 반영(부분취소 지원).
      return {
        cancellation: {
          ...cancelResult,
          totalAmount: cancelResult.totalAmount ?? input.amount ?? full.amount?.total ?? 0,
        },
      };
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

/** user + wallet + product + paid 주문(지급 완료)을 만든다. */
async function seedPaidOrder(input: {
  amountKrw: number;
  credits: number;
  bonus?: number;
  paidDaysAgo?: number;
}): Promise<{ userId: string; walletId: string; orderId: string; paymentId: string }> {
  const userId = crypto.randomUUID();
  await client`INSERT INTO users (id, email) VALUES (${userId}, ${`refund-${userId}@example.com`})`;
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
  // 지급(purchase_grant). paidAt 을 과거로 두려면 이후 UPDATE.
  await paymentRepo.grantPurchaseForOrder({
    orderId,
    portone: { status: "PAID", txId: "tx_1", payMethod: "CARD" },
    lotExpiresAt: new Date(Date.now() + 1825 * 24 * 60 * 60 * 1000),
  });
  if (input.paidDaysAgo && input.paidDaysAgo > 0) {
    const paidAt = new Date(Date.now() - input.paidDaysAgo * 24 * 60 * 60 * 1000);
    await client`UPDATE credit_payment_orders SET paid_at = ${paidAt.toISOString()}::timestamptz WHERE id = ${orderId}`;
  }
  return { userId, walletId, orderId, paymentId };
}

async function orderStatus(orderId: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`SELECT status FROM credit_payment_orders WHERE id = ${orderId}`;
  return row!.status;
}
async function walletBalance(walletId: string): Promise<number> {
  const [row] = await client<{ balance_credits: number }[]>`SELECT balance_credits FROM credit_wallets WHERE id = ${walletId}`;
  return Number(row!.balance_credits);
}
async function ledgerCount(walletId: string, entryType: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM credit_ledger WHERE wallet_id = ${walletId} AND entry_type = ${entryType}`;
  return Number(row!.n);
}
async function auditCount(action: string, targetId: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM credit_audit_logs WHERE action = ${action} AND target_id = ${targetId}`;
  return Number(row!.n);
}
async function lotStatus(walletId: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`SELECT status FROM credit_lots WHERE wallet_id = ${walletId} AND source = 'purchase' ORDER BY created_at DESC LIMIT 1`;
  return row?.status ?? "none";
}

async function main() {
  console.log("환불 실행 통합 테스트 (7.4 executeRefund)");

  // ── R1: 청약철회 미사용 전액 환불 ────────────────────────────────────────
  await check("R1 청약철회 미사용 전액 환불 → refund_deduct(targetLotIds) + lot revoked + order refunded", async () => {
    const { walletId, orderId, paymentId } = await seedPaidOrder({ amountKrw: 10000, credits: 10000 });
    assert.equal(await walletBalance(walletId), 10000);

    // 미리보기(포트원 호출 없음): 전액 환불 가능.
    const preview = await previewRefund(orderId, { payment: paymentRepo, system: systemRepo, portone: stubPortone({ payment: { status: "PAID" } }) });
    assert.equal(preview.kind, "preview");
    assert.equal(preview.calc?.refundable, true);
    assert.equal(preview.calc?.kind, "withdrawal");
    assert.equal(preview.calc?.refundKrw, 10000);
    assert.equal(preview.calc?.recoverCredits, 10000);

    const outcome = await executeRefund(orderId, { reason: "청약철회" }, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({
        payment: { id: paymentId, status: "PAID", amount: { total: 10000, paid: 10000, cancelled: null } },
        cancelResult: { id: "cancel_r1", status: "SUCCEEDED", totalAmount: 10000, reason: null },
      }),
      actorId: "admin_1",
      actorType: "admin",
    });
    assert.equal(outcome.kind, "executed");
    if (outcome.kind === "executed") {
      assert.equal(outcome.recovered, 10000);
      assert.equal(outcome.shortfall, 0);
      assert.equal(outcome.refundKrw, 10000);
    }
    assert.equal(await walletBalance(walletId), 0);
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 1);
    assert.equal(await lotStatus(walletId), "revoked");
    assert.equal(await orderStatus(orderId), "refunded");
    assert.equal(await auditCount("refund.executed", orderId), 1);
  });

  // ── R2: 부분 사용 부분 환불 ──────────────────────────────────────────────
  await check("R2 부분 사용 부분 환불 → 원금 소진분만 차감, 회수는 잔여 전체", async () => {
    // 원금 10000, 보너스 0. 3000 소진 → 소진 3000(전부 원금). 환불 = 10000 - 3000 = 7000, 회수 = 잔여 7000.
    const { userId, walletId, orderId, paymentId } = await seedPaidOrder({ amountKrw: 10000, credits: 10000 });
    await creditRepo.applyLedgerEntry(userId, {
      walletId,
      entryType: "usage_capture",
      amountCredits: -3000,
      idempotencyKey: `usage:${crypto.randomUUID()}`,
      actorType: "user",
      actorId: userId,
    });
    assert.equal(await walletBalance(walletId), 7000);

    const outcome = await executeRefund(orderId, { reason: "청약철회 부분사용" }, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({
        payment: { id: paymentId, status: "PAID", amount: { total: 10000, paid: 10000, cancelled: null } },
        cancelResult: { id: "cancel_r2", status: "SUCCEEDED", totalAmount: 7000, reason: null },
      }),
      actorId: "admin_1",
      actorType: "admin",
    });
    assert.equal(outcome.kind, "executed");
    if (outcome.kind === "executed") {
      assert.equal(outcome.refundKrw, 7000);
      assert.equal(outcome.recovered, 7000);
    }
    assert.equal(await walletBalance(walletId), 0);
    // refundKrw(7000) < amountKrw(10000) → fullRefund=false → partial_refunded. 회수는 잔여 7000 전체.
    assert.equal(await orderStatus(orderId), "partial_refunded");
  });

  // ── R3: 임의 환불(7일 초과) 보너스 회수 ──────────────────────────────────
  await check("R3 임의 환불(7일 초과) → 보너스 전액 회수 후 잔여 원금 부분 환불", async () => {
    // 원금 10000 + 보너스 1000 = 11000 지급. 7일 초과. 미사용.
    // 임의 환불: 보너스 1000 회수 후 잔여 원금 10000 환불. 회수 = 11000, 환불 = min(amount, 10000)=10000.
    const { walletId, orderId, paymentId } = await seedPaidOrder({ amountKrw: 10000, credits: 10000, bonus: 1000, paidDaysAgo: 10 });
    assert.equal(await walletBalance(walletId), 11000);

    const preview = await previewRefund(orderId, { payment: paymentRepo, system: systemRepo, portone: stubPortone({ payment: { status: "PAID" } }) });
    assert.equal(preview.calc?.kind, "discretionary");
    assert.equal(preview.calc?.refundable, true);
    assert.equal(preview.calc?.refundKrw, 10000);
    assert.equal(preview.calc?.recoverCredits, 11000);

    const outcome = await executeRefund(orderId, { reason: "임의 환불" }, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({
        payment: { id: paymentId, status: "PAID", amount: { total: 10000, paid: 10000, cancelled: null } },
        cancelResult: { id: "cancel_r3", status: "SUCCEEDED", totalAmount: 10000, reason: null },
      }),
      actorId: "admin_1",
      actorType: "admin",
    });
    assert.equal(outcome.kind, "executed");
    if (outcome.kind === "executed") assert.equal(outcome.recovered, 11000);
    assert.equal(await walletBalance(walletId), 0);
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 1);
  });

  // ── R4: 환불 불가(보너스 lot 뿐 = admin_grant/promo만) ──────────────────
  await check("R4 유료 lot 없음(admin_grant/promo/signup 만) → 환불 불가(실행 안 함)", async () => {
    // paid 주문이지만 이 주문의 lot 이 admin_grant 로만 구성된 상황을 시뮬한다(비정상이지만 배제 규칙 검증).
    const { userId, walletId, orderId } = await seedPaidOrder({ amountKrw: 5000, credits: 5000 });
    // 이 주문의 purchase lot 을 admin_grant 로 바꿔 유료 lot 을 없앤다(source 배제 검증).
    await client`UPDATE credit_lots SET source = 'admin_grant' WHERE wallet_id = ${walletId} AND source = 'purchase'`;
    void userId;

    const preview = await previewRefund(orderId, { payment: paymentRepo, system: systemRepo, portone: stubPortone({ payment: { status: "PAID" } }) });
    assert.equal(preview.calc?.refundable, false);

    const outcome = await executeRefund(orderId, { reason: "환불 요청" }, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({ payment: { id: "x", status: "PAID", amount: { total: 5000, paid: 5000, cancelled: null } } }),
      actorId: "admin_1",
      actorType: "admin",
    });
    assert.equal(outcome.kind, "not_refundable");
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 0); // 실행 안 함.
    assert.equal(await orderStatus(orderId), "paid"); // 그대로.
  });

  // ── R5: REQUESTED → 분개 없음·대기 → 이후 Cancelled 웹훅으로 완결(멱등) ──
  await check("R5 REQUESTED → 분개 없음·대기 → 이후 Cancelled 웹훅으로 완결(합류·멱등)", async () => {
    const { walletId, orderId, paymentId } = await seedPaidOrder({ amountKrw: 8000, credits: 8000 });

    // 실행 → REQUESTED. 분개 없음.
    const outcome = await executeRefund(orderId, { reason: "비동기 환불" }, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({
        payment: { id: paymentId, status: "PAID", amount: { total: 8000, paid: 8000, cancelled: null } },
        cancelResult: { id: "cancel_r5", status: "REQUESTED", totalAmount: 8000, reason: null },
      }),
      actorId: "admin_1",
      actorType: "admin",
    });
    assert.equal(outcome.kind, "pending");
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 0); // 분개 없음(대기).
    assert.equal(await orderStatus(orderId), "paid");

    // 이후 Transaction.Cancelled 웹훅 → syncRefundFromPortone 로 완결.
    const portone = stubPortone({
      payment: {
        id: paymentId,
        status: "CANCELLED",
        amount: { total: 8000, paid: 0, cancelled: 8000 },
        cancellations: [{ id: "cancel_r5", status: "SUCCEEDED", totalAmount: 8000, reason: "async_done" }],
      },
    });
    await handlePortoneWebhook(`wh_${crypto.randomUUID()}`, { type: "Transaction.Cancelled", data: { paymentId } }, {
      payment: paymentRepo,
      subscription: subscriptionRepo,
      system: systemRepo,
      portone,
    });
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 1); // 웹훅이 완결.
    assert.equal(await walletBalance(walletId), 0);
    assert.equal(await orderStatus(orderId), "refunded");
  });

  // ── R6: FAILED → 오류 + refund.failed audit ─────────────────────────────
  await check("R6 FAILED → 오류 + refund.failed audit(분개 없음)", async () => {
    const { walletId, orderId, paymentId } = await seedPaidOrder({ amountKrw: 5000, credits: 5000 });
    const outcome = await executeRefund(orderId, { reason: "환불 시도" }, {
      payment: paymentRepo,
      system: systemRepo,
      portone: stubPortone({
        payment: { id: paymentId, status: "PAID", amount: { total: 5000, paid: 5000, cancelled: null } },
        cancelResult: { id: "cancel_r6", status: "FAILED", totalAmount: null, reason: "gateway_error" },
      }),
      actorId: "admin_1",
      actorType: "admin",
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 0);
    assert.equal(await orderStatus(orderId), "paid");
    assert.equal(await auditCount("refund.failed", orderId), 1);
  });

  // ── R7: 동일 주문 재실행 멱등 ────────────────────────────────────────────
  await check("R7 동일 주문 SUCCEEDED 재실행 → refund_deduct 1건 유지(멱등)", async () => {
    const { walletId, orderId, paymentId } = await seedPaidOrder({ amountKrw: 6000, credits: 6000 });
    const portone = stubPortone({
      payment: { id: paymentId, status: "PAID", amount: { total: 6000, paid: 6000, cancelled: null } },
      cancelResult: { id: "cancel_r7", status: "SUCCEEDED", totalAmount: 6000, reason: null },
    });
    const deps = { payment: paymentRepo, system: systemRepo, portone, actorId: "admin_1", actorType: "admin" as const };
    await executeRefund(orderId, { reason: "환불" }, deps);
    // 재실행: 이미 refunded 상태라 not_refundable_status 로 막힌다(멱등 방어의 1선).
    const again = await executeRefund(orderId, { reason: "환불 재시도" }, deps);
    assert.equal(again.kind, "not_refundable_status");
    assert.equal(await ledgerCount(walletId, "refund_deduct"), 1);
    assert.equal(await walletBalance(walletId), 0);
  });

  console.log(`\n환불 실행 통합: ${passed} passed`);
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
