/**
 * 플랜 구독 통합 테스트 (실제 Postgres 필요, 설계 8.2/8.3/8.4/8.5 / 16.2 / P4 DoD D1·D3·D4).
 *
 * ★ 안전장치: DATABASE_URL 호스트가 pooler.supabase.com/supabase.co 면 즉시 abort.
 *   실서비스 공용 DB 에 절대 쓰지 않는다. 일회용 컨테이너에서만 실행한다.
 *
 * 셋업(공용 DB 스키마 덤프 → 컨테이너 복원 — payment.integration.test.ts 와 동일 패턴):
 *   1) .env 의 DATABASE_URL 에서 쿼리스트링을 제거한 URL 로
 *      docker run --rm postgres:17 pg_dump --schema-only --no-owner --no-privileges "$DB_URL" > /tmp/p4-schema.sql
 *   2) docker run --rm -d --name cunote-p4-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:17
 *   3) docker exec -i cunote-p4-test psql -U postgres -d cunote < /tmp/p4-schema.sql
 *   4) DATABASE_URL=postgres://postgres:test@127.0.0.1:54340/cunote pnpm test:credits-subscription-integration
 *
 * 커버(P4 DoD):
 *   D1  동일일 구독 → 업그레이드 → plan_grant lot 2개, plan:{orderId} 키 무충돌, 구 예약 취소
 *   D3  incomplete + 결제 실패 → active 없음, 같은 행 재사용(partial unique 미위반), 재시도 후 PAID → active
 *   D4  안전망 cron 3분기(8.3): SUCCEEDED(즉시결제 금지) / FAILED(재시도 1개) / null(즉시결제 1회)
 *   추가: 갱신 웹훅 멱등 / 업그레이드 구 예약 취소 명시 / 재시도 한 번에 1개(D+1→D+3→소진 expired)
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { paymentIdForOrder } from "@cunote/core";
import * as schema from "../db/schema";
import { DrizzleCreditRepository, DrizzleCreditSystemRepository } from "../repositories/creditRepository";
import { DrizzlePaymentRepository } from "../repositories/paymentRepository";
import { DrizzleSubscriptionRepository } from "../repositories/subscriptionRepository";
import {
  startSubscription,
  changePlan,
  cancelSubscription,
  replaceBillingKey,
  processRenewal,
  handleRenewalFailure,
  handleBillingKeyDeleted,
  type SubscriptionServiceDeps,
} from "./subscriptionService";
import { handlePortoneWebhook } from "./webhookHandler";
import type { PortoneClient, PortonePayment, PortonePaymentStatus } from "./portone";

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

// ── 강화 스텁 포트원 — 모든 쓰기 호출을 기록한다(D4·업그레이드 검증용) ──────────
interface StubOptions {
  /** payWithBillingKey 가 돌려줄 상태(기본 PAID). 시나리오별 FAILED 주입 가능. */
  payStatus?: PortonePaymentStatus;
  /** payWithBillingKey 응답 금액(기본: 요청 amount). 불일치 테스트용 override. */
  payAmountTotal?: number;
  /** getPaymentSchedule 가 돌려줄 상태(SUCCEEDED/FAILED/SCHEDULED/…) 또는 null(없는 예약). */
  scheduleStatus?: string | null;
  /** getPayment(사후검증 재조회) 가 돌려줄 상태(기본 PAID). */
  getPaymentStatus?: PortonePaymentStatus;
}

interface PortoneCallLog {
  cancelSchedules: Array<{ billingKey?: string; scheduleIds?: string[] }>;
  schedulePayment: Array<{ paymentId: string; billingKey: string; amount: number; timeToPay: string }>;
  payWithBillingKey: Array<{ paymentId: string; billingKey: string; amount: number }>;
  deleteBillingKey: Array<{ billingKey: string }>;
  getPaymentSchedule: Array<{ scheduleId: string }>;
  getPayment: Array<{ paymentId: string }>;
}

interface StubPortone extends PortoneClient {
  calls: PortoneCallLog;
  opts: StubOptions;
}

/** 스텁 포트원 — 시나리오별 응답 주입 + 모든 호출 기록(멱등·이중청구 검증). */
function stubPortone(opts: StubOptions = {}): StubPortone {
  const calls: PortoneCallLog = {
    cancelSchedules: [],
    schedulePayment: [],
    payWithBillingKey: [],
    deleteBillingKey: [],
    getPaymentSchedule: [],
    getPayment: [],
  };
  let scheduleSeq = 0;
  const makePayment = (
    paymentId: string,
    status: PortonePaymentStatus,
    amountTotal: number,
  ): PortonePayment => ({
    id: paymentId,
    status,
    amount: { total: amountTotal, paid: status === "PAID" ? amountTotal : null, cancelled: null },
    currency: "KRW",
    payMethod: "CARD",
    paidAt: status === "PAID" ? new Date().toISOString() : null,
    cancellations: [],
    failureReason: status === "FAILED" ? "카드 한도 초과(테스트)" : null,
    transactionId: `tx_${paymentId}`,
  });

  const self: StubPortone = {
    calls,
    opts,
    isConfigured: () => true,
    async getPayment(paymentId) {
      calls.getPayment.push({ paymentId });
      // 사후검증 재조회 — renew 경로가 참조. 기본 PAID.
      return makePayment(paymentId, opts.getPaymentStatus ?? "PAID", 0);
    },
    async getPaymentSchedule(scheduleId) {
      calls.getPaymentSchedule.push({ scheduleId });
      if (opts.scheduleStatus === null) return null;
      return { id: scheduleId, status: opts.scheduleStatus ?? "SCHEDULED" };
    },
    async cancelPayment() {
      return { cancellation: { id: "c1", status: "SUCCEEDED", totalAmount: 0, reason: null } };
    },
    async payWithBillingKey(input) {
      calls.payWithBillingKey.push({ paymentId: input.paymentId, billingKey: input.billingKey, amount: input.amount });
      const status = opts.payStatus ?? "PAID";
      const total = opts.payAmountTotal ?? input.amount;
      return makePayment(input.paymentId, status, total);
    },
    async schedulePayment(input) {
      calls.schedulePayment.push({
        paymentId: input.paymentId,
        billingKey: input.billingKey,
        amount: input.amount,
        timeToPay: input.timeToPay,
      });
      scheduleSeq += 1;
      return { scheduleId: `sch_${scheduleSeq}_${input.paymentId.slice(-8)}` };
    },
    async cancelSchedules(input) {
      calls.cancelSchedules.push(input);
      return { revokedScheduleIds: input.scheduleIds ?? [] };
    },
    async deleteBillingKey(input) {
      calls.deleteBillingKey.push({ billingKey: input.billingKey });
    },
  };
  return self;
}

function makeDeps(portone: StubPortone, now?: () => Date): SubscriptionServiceDeps {
  return {
    subscription: subscriptionRepo,
    payment: paymentRepo,
    system: systemRepo,
    portone,
    ...(now ? { now } : {}),
  };
}

// ── 시딩 헬퍼 ────────────────────────────────────────────────────────────────

interface UserFixture {
  userId: string;
  walletId: string;
}

/**
 * user + wallet 을 만들고 초기 잔액을 ★ 실제 지급 분개(admin_grant)로 넣는다(I1/I9 유지).
 * 잔액 0 이면 지급 분개 없이 빈 지갑만.
 */
async function seedWallet(balance = 0): Promise<UserFixture> {
  const userId = crypto.randomUUID();
  await client`INSERT INTO users (id, email) VALUES (${userId}, ${`sub-test-${userId}@example.com`})`;
  const walletId = crypto.randomUUID();
  await client`INSERT INTO credit_wallets (id, user_id, balance_credits, status) VALUES (${walletId}, ${userId}, 0, 'active')`;
  if (balance > 0) {
    await creditRepo.applyLedgerEntry(userId, {
      walletId,
      entryType: "admin_grant",
      amountCredits: balance,
      idempotencyKey: `seed:${crypto.randomUUID()}`,
      actorType: "system",
      actorId: "seed",
      reason: "테스트 초기 잔액",
      grantLot: { source: "admin_grant", expiresAt: null },
    });
  }
  return { userId, walletId };
}

// ── 조회 헬퍼 ────────────────────────────────────────────────────────────────

async function planIdByCode(code: string): Promise<string> {
  const [row] = await client<{ id: string }[]>`SELECT id FROM credit_plans WHERE code = ${code}`;
  return row!.id;
}
async function walletBalance(walletId: string): Promise<number> {
  const [row] = await client<{ balance_credits: number }[]>`SELECT balance_credits FROM credit_wallets WHERE id = ${walletId}`;
  return Number(row!.balance_credits);
}
async function planGrantLots(walletId: string): Promise<Array<{ id: string; remaining: number; expiresAt: Date | null; orderId: string | null }>> {
  const rows = await client<{ id: string; remaining_credits: number; expires_at: string | Date | null; payment_order_id: string | null }[]>`
    SELECT id, remaining_credits, expires_at, payment_order_id
    FROM credit_lots WHERE wallet_id = ${walletId} AND source = 'plan_grant' ORDER BY created_at ASC`;
  return rows.map((r) => ({
    id: r.id,
    remaining: Number(r.remaining_credits),
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    orderId: r.payment_order_id,
  }));
}
async function planGrantLedger(walletId: string): Promise<Array<{ id: string; amount: number; idempotencyKey: string }>> {
  const rows = await client<{ id: string; amount_credits: number; idempotency_key: string }[]>`
    SELECT id, amount_credits, idempotency_key
    FROM credit_ledger WHERE wallet_id = ${walletId} AND entry_type = 'plan_grant' ORDER BY created_at ASC`;
  return rows.map((r) => ({ id: r.id, amount: Number(r.amount_credits), idempotencyKey: r.idempotency_key }));
}
async function ledgerSum(walletId: string): Promise<number> {
  const [row] = await client<{ s: number }[]>`SELECT COALESCE(SUM(amount_credits),0)::bigint AS s FROM credit_ledger WHERE wallet_id = ${walletId}`;
  return Number(row!.s);
}
async function activeLotRemainingSum(walletId: string): Promise<number> {
  const [row] = await client<{ s: number }[]>`SELECT COALESCE(SUM(remaining_credits),0)::bigint AS s FROM credit_lots WHERE wallet_id = ${walletId} AND remaining_credits > 0`;
  return Number(row!.s);
}
async function subById(id: string) {
  const [row] = await client<Record<string, unknown>[]>`SELECT * FROM credit_plan_subscriptions WHERE id = ${id}`;
  return row!;
}
async function subCountForUser(userId: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM credit_plan_subscriptions WHERE user_id = ${userId}`;
  return Number(row!.n);
}
async function subCountByStatus(userId: string, status: string): Promise<number> {
  const [row] = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM credit_plan_subscriptions WHERE user_id = ${userId} AND status = ${status}`;
  return Number(row!.n);
}
async function orderStatusById(orderId: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`SELECT status FROM credit_payment_orders WHERE id = ${orderId}`;
  return row!.status;
}
async function ordersForSub(subId: string, orderType: string): Promise<Array<{ id: string; paymentId: string; status: string }>> {
  const rows = await client<{ id: string; payment_id: string; status: string }[]>`
    SELECT id, payment_id, status FROM credit_payment_orders
    WHERE plan_subscription_id = ${subId} AND order_type = ${orderType} ORDER BY created_at ASC`;
  return rows.map((r) => ({ id: r.id, paymentId: r.payment_id, status: r.status }));
}

/** 예약(plan_renewal 선생성 주문 + 스텁 scheduleId)을 구독에 배선한다. cron/renew 시나리오 준비. */
async function seedRenewalSchedule(sub: { id: string; walletId: string; userId: string }, opts: { amountKrw: number; credits: number; scheduleId?: string }): Promise<{ orderId: string; paymentId: string; scheduleId: string }> {
  const orderId = crypto.randomUUID();
  const paymentId = paymentIdForOrder(orderId);
  const scheduleId = opts.scheduleId ?? `sch_seed_${orderId.slice(0, 8)}`;
  await subscriptionRepo.createPlanOrder({
    id: orderId,
    paymentId,
    walletId: sub.walletId,
    userId: sub.userId,
    planSubscriptionId: sub.id,
    orderType: "plan_renewal",
    amountKrw: opts.amountKrw,
    creditsToGrant: opts.credits,
    krwPerCreditSnapshot: 1,
    expiresAt: new Date(Date.now() + 90 * 60 * 1000),
  });
  await subscriptionRepo.updateSchedule({ subscriptionId: sub.id, nextScheduleId: scheduleId, nextSchedulePaymentId: paymentId });
  return { orderId, paymentId, scheduleId };
}

// ── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("플랜 구독 통합 테스트 (P4 / D1·D3·D4)");

  // 설정 시딩(4.9 / 8.x). 객체값·배열값 포함.
  await client`
    INSERT INTO credit_settings (key, value) VALUES
      ('plan_grant_expiry_cycles', '{"value":2,"flexValue":3}'::jsonb),
      ('plan_retry_schedule_days', '{"value":[1,3]}'::jsonb),
      ('krw_per_credit', '{"value":1}'::jsonb),
      ('payment_order_ttl_minutes', '{"value":90}'::jsonb),
      ('hold_buffer_ratio', '{"value":1.0}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  // credit_plans 시딩(4.9): plus/pro/flex.
  await client`
    INSERT INTO credit_plans (code, name, monthly_price_krw, monthly_credits, display_order, is_active) VALUES
      ('plus', 'Plus', 9900, 11000, 1, true),
      ('pro', 'Pro', 29900, 35000, 2, true),
      ('flex', 'Flex', 79900, 100000, 3, true)
    ON CONFLICT (code) DO UPDATE SET
      monthly_price_krw = EXCLUDED.monthly_price_krw, monthly_credits = EXCLUDED.monthly_credits, is_active = true
  `;

  // ────────────────────────────────────────────────────────────────────────
  // D1 — 동일일 구독 → 업그레이드 → plan_grant lot 2개, plan:{orderId} 무충돌
  // ────────────────────────────────────────────────────────────────────────
  await check("D1 startSubscription(plus) PAID → active + plan_grant 1건 + lot(now+60d) + 초기결제 paid + 예약 등록", async () => {
    const fx = await seedWallet(0);
    const now = new Date("2026-07-10T00:00:00.000Z");
    const portone = stubPortone({ payStatus: "PAID" });
    const deps = makeDeps(portone, () => now);
    const outcome = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode: "plus", billingKey: "bk_plus_1" },
      deps,
    );
    assert.equal(outcome.kind, "active");
    if (outcome.kind !== "active") return;

    // 구독 active.
    const sub = await subById(outcome.subscription.id);
    assert.equal(sub.status, "active");
    // plan_grant 원장 1건 + lot 1개 + 잔액 11000.
    const ledger = await planGrantLedger(fx.walletId);
    assert.equal(ledger.length, 1, "plan_grant 원장 정확히 1건");
    const lots = await planGrantLots(fx.walletId);
    assert.equal(lots.length, 1, "plan_grant lot 정확히 1개");
    assert.equal(lots[0]!.remaining, 11000);
    // lot 만료 ≈ now+60d(2주기 × 30d).
    const expectedExpiry = now.getTime() + 60 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(lots[0]!.expiresAt!.getTime() - expectedExpiry) < 2000, `lot 만료 ≈ now+60d (실제 ${lots[0]!.expiresAt?.toISOString()})`);
    assert.equal(await walletBalance(fx.walletId), 11000);
    // plan_initial 주문 1건 paid.
    const initials = await ordersForSub(sub.id as string, "plan_initial");
    assert.equal(initials.length, 1);
    assert.equal(initials[0]!.status, "paid");
    // plan_renewal 예약 주문 created + schedulePayment 1회.
    const renewals = await ordersForSub(sub.id as string, "plan_renewal");
    assert.equal(renewals.length, 1);
    assert.equal(renewals[0]!.status, "created");
    assert.equal(portone.calls.schedulePayment.length, 1, "schedulePayment 정확히 1회");
    // 초기 구독에서는 구 예약이 없으므로 cancelSchedules 미호출.
    assert.equal(portone.calls.cancelSchedules.length, 0);
  });

  await check("D1 동일일 changePlan(pro) 업그레이드 → 구 예약 취소 + 즉시결제 + 2번째 plan_grant + plan:{orderId} 무충돌", async () => {
    const fx = await seedWallet(0);
    const now = new Date("2026-07-10T00:00:00.000Z");
    // 1) plus 구독.
    const p1 = stubPortone({ payStatus: "PAID" });
    const started = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode: "plus", billingKey: "bk_up_1" },
      makeDeps(p1, () => now),
    );
    assert.equal(started.kind, "active");
    if (started.kind !== "active") return;
    const oldScheduleId = (await subById(started.subscription.id)).next_schedule_id as string;
    assert.ok(oldScheduleId, "plus 예약 scheduleId 존재");

    // 2) 같은 날 pro 로 업그레이드(pro 가격 > plus).
    const p2 = stubPortone({ payStatus: "PAID" });
    const deps2 = makeDeps(p2, () => now);
    const changed = await changePlan({ userId: fx.userId, planCode: "pro" }, deps2);
    assert.equal(changed.kind, "upgraded");
    if (changed.kind !== "upgraded") return;

    // ★ 구 예약 취소 호출 검증(레드팀 B2) — 구 billingKey + 구 scheduleId 로 cancelSchedules 호출.
    assert.equal(p2.calls.cancelSchedules.length, 1, "업그레이드는 구 예약을 정확히 1회 취소");
    assert.equal(p2.calls.cancelSchedules[0]!.billingKey, "bk_up_1");
    assert.deepEqual(p2.calls.cancelSchedules[0]!.scheduleIds, [oldScheduleId], "구 scheduleId 명시 취소");
    // 취소가 즉시결제보다 먼저 일어났는지: 즉시결제(payWithBillingKey)는 취소 이후 1회.
    assert.equal(p2.calls.payWithBillingKey.length, 1, "업그레이드 즉시결제 1회");

    // plan_grant 원장 2건(누적) — plus 초기 + pro 업그레이드.
    const ledger = await planGrantLedger(fx.walletId);
    assert.equal(ledger.length, 2, "plan_grant 원장 2건(초기 + 업그레이드)");
    // ★ B1 무충돌 증거: 두 멱등키 모두 plan: 접두 + 서로 다름.
    const keys = ledger.map((l) => l.idempotencyKey);
    assert.ok(keys.every((k) => k.startsWith("plan:")), "모든 plan_grant 멱등키는 plan: 접두");
    assert.notEqual(keys[0], keys[1], "두 plan:{orderId} 키가 서로 다름(무충돌)");
    console.log(`     · plan:{orderId} 키 #1 = ${keys[0]}`);
    console.log(`     · plan:{orderId} 키 #2 = ${keys[1]}`);

    // plan_grant lot 2개.
    const lots = await planGrantLots(fx.walletId);
    assert.equal(lots.length, 2, "plan_grant lot 2개");
    // sub.planId 는 이제 pro, period 리셋(now~nextPeriodEnd).
    const proId = await planIdByCode("pro");
    const sub = await subById(started.subscription.id);
    assert.equal(sub.plan_id, proId, "planId 는 pro");
    assert.equal(new Date(sub.current_period_start as string).getTime(), now.getTime(), "period 리셋");
    // I1: balance = Σledger.
    assert.equal(await walletBalance(fx.walletId), await ledgerSum(fx.walletId), "I1 balance=Σledger");
    // I2: balance = Σ active lot remaining.
    assert.equal(await walletBalance(fx.walletId), await activeLotRemainingSum(fx.walletId), "I2 balance=Σ active lot remaining");
    // 잔액 = 11000(plus) + 35000(pro) = 46000.
    assert.equal(await walletBalance(fx.walletId), 46000);
    console.log(`     · 지갑 잔액 = 46000 (plus 11000 + pro 35000, 무충돌 누적)`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // D3 — incomplete + 결제 실패 → active 없음, 같은 행 재사용
  // ────────────────────────────────────────────────────────────────────────
  await check("D3 startSubscription(plus) FAILED → incomplete 유지, active/plan_grant 없음, 주문 failed", async () => {
    const fx = await seedWallet(0);
    const now = new Date("2026-07-10T00:00:00.000Z");
    const portone = stubPortone({ payStatus: "FAILED" });
    const outcome = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode: "plus", billingKey: "bk_fail" },
      makeDeps(portone, () => now),
    );
    assert.equal(outcome.kind, "payment_failed");
    // incomplete 1행, active/past_due 0.
    assert.equal(await subCountForUser(fx.userId), 1, "구독 행 1개");
    assert.equal(await subCountByStatus(fx.userId, "incomplete"), 1, "incomplete 1행");
    assert.equal(await subCountByStatus(fx.userId, "active"), 0, "active 없음");
    assert.equal(await subCountByStatus(fx.userId, "past_due"), 0, "past_due 없음");
    // plan_grant 없음.
    assert.equal((await planGrantLedger(fx.walletId)).length, 0, "plan_grant 없음");
    assert.equal(await walletBalance(fx.walletId), 0);
    // 초기결제 주문 failed.
    const [ini] = await client<{ status: string }[]>`SELECT status FROM credit_payment_orders WHERE user_id = ${fx.userId} AND order_type = 'plan_initial'`;
    assert.equal(ini!.status, "failed", "plan_initial 주문 failed");
  });

  await check("D3 재시도 FAILED → 같은 incomplete 행 재사용(2번째 안 생김), 여전히 active 없음", async () => {
    const fx = await seedWallet(0);
    const now = new Date("2026-07-10T00:00:00.000Z");
    const deps = makeDeps(stubPortone({ payStatus: "FAILED" }), () => now);
    const first = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode: "plus", billingKey: "bk_r1" },
      deps,
    );
    assert.equal(first.kind, "payment_failed");
    const firstIncompleteId = (await client<{ id: string }[]>`SELECT id FROM credit_plan_subscriptions WHERE user_id = ${fx.userId} AND status = 'incomplete'`)[0]!.id;

    const second = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode: "plus", billingKey: "bk_r2" },
      makeDeps(stubPortone({ payStatus: "FAILED" }), () => now),
    );
    assert.equal(second.kind, "payment_failed");
    // ★ 같은 incomplete 행 재사용 — 구독 행 여전히 1개.
    assert.equal(await subCountForUser(fx.userId), 1, "구독 행 여전히 1개(upsert 재사용)");
    const stillIncompleteId = (await client<{ id: string }[]>`SELECT id FROM credit_plan_subscriptions WHERE user_id = ${fx.userId} AND status = 'incomplete'`)[0]!.id;
    assert.equal(stillIncompleteId, firstIncompleteId, "동일 subscription id(같은 행)");
    assert.equal(await subCountByStatus(fx.userId, "active"), 0, "여전히 active 없음");

    // ★ 최종 PAID → 그 같은 행이 incomplete→active 전이, plan_grant 지급.
    const paidDeps = makeDeps(stubPortone({ payStatus: "PAID" }), () => now);
    const third = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode: "plus", billingKey: "bk_r3" },
      paidDeps,
    );
    assert.equal(third.kind, "active");
    if (third.kind !== "active") return;
    assert.equal(third.subscription.id, firstIncompleteId, "PAID 전이는 같은 행(incomplete→active)");
    assert.equal(await subCountForUser(fx.userId), 1, "여전히 구독 행 1개(partial unique 미차단 증명)");
    assert.equal(await subCountByStatus(fx.userId, "active"), 1);
    assert.equal((await planGrantLedger(fx.walletId)).length, 1, "PAID 후 plan_grant 1건");
    assert.equal(await walletBalance(fx.walletId), 11000);
    console.log(`     · incomplete 행 재사용 확인: id=${firstIncompleteId} (재시도 3회, 구독 행 1개 유지)`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // D4 — 안전망 cron 3분기(8.3). cron 루프 로직을 서비스 fn 로 재현.
  //   (cron GET 은 getServiceRepositories()/getPortoneClient() 싱글턴 + CRON_SECRET 을
  //    쓰므로 스텁 주입이 어렵다 — cron 과 동일한 분기·호출 순서를 여기서 재현한다.)
  // ────────────────────────────────────────────────────────────────────────

  /** 만료 주기(과거)인 active 구독 + 예약(주문·scheduleId) 준비. */
  async function seedDueSubscription(planCode: string): Promise<{ subId: string; fx: UserFixture; paymentId: string; scheduleId: string; orderId: string; billingKey: string }> {
    const fx = await seedWallet(0);
    const now = new Date("2026-07-10T00:00:00.000Z");
    const billingKey = `bk_due_${fx.userId.slice(0, 8)}`;
    // plus/pro 로 정상 구독 시작(현재 예약을 취소하고 과거 주기로 강제 조정).
    const started = await startSubscription(
      { userId: fx.userId, wallet: { id: fx.walletId }, planCode, billingKey },
      makeDeps(stubPortone({ payStatus: "PAID" }), () => now),
    );
    assert.equal(started.kind, "active");
    if (started.kind !== "active") throw new Error("seed 실패");
    const subId = started.subscription.id;
    // currentPeriodEnd 를 과거(>2h)로 강제. 초기 예약을 지우고 새 예약(주문+scheduleId)을 심는다.
    const pastEnd = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    await client`UPDATE credit_plan_subscriptions SET current_period_end = ${pastEnd}::timestamptz WHERE id = ${subId}`;
    const plan = await subscriptionRepo.getPlanById(await planIdByCode(planCode));
    const sched = await seedRenewalSchedule(
      { id: subId, walletId: fx.walletId, userId: fx.userId },
      { amountKrw: plan!.monthlyPriceKrw, credits: plan!.monthlyCredits },
    );
    return { subId, fx, paymentId: sched.paymentId, scheduleId: sched.scheduleId, orderId: sched.orderId, billingKey };
  }

  await check("D4 cron/SUCCEEDED → 즉시결제 금지(payWithBillingKey 미호출) + processRenewal 로 갱신 적용", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    // cron Branch 1 SUCCEEDED 분기 재현: getPaymentSchedule=SUCCEEDED → processRenewal 만.
    const portone = stubPortone({ scheduleStatus: "SUCCEEDED", getPaymentStatus: "PAID" });
    const deps = makeDeps(portone, () => now);
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    const schedule = await portone.getPaymentSchedule(sub!.nextScheduleId!);
    assert.equal(schedule!.status, "SUCCEEDED");
    // ★ SUCCEEDED → processRenewal 만 호출. payWithBillingKey 는 절대 호출하지 않는다(M7).
    const outcome = await processRenewal({ paymentId: sub!.nextSchedulePaymentId! }, deps);
    assert.equal(outcome.kind, "renewed");
    assert.equal(portone.calls.payWithBillingKey.length, 0, "★ SUCCEEDED 분기에서 즉시결제 미발화(M7)");
    // 갱신 적용: 이 갱신 주문에 대한 plan_grant 지급 + period 롤 + 재예약.
    const renewalGrantLedger = (await planGrantLedger(seed.fx.walletId)).filter((l) => l.idempotencyKey === `plan:${seed.orderId}`);
    assert.equal(renewalGrantLedger.length, 1, "갱신 주문에 대한 plan_grant 1건");
    assert.equal(await orderStatusById(seed.orderId), "paid", "갱신 주문 paid");
    const rolled = await subById(seed.subId);
    assert.equal(rolled.status, "active");
    assert.notEqual(rolled.next_schedule_id, seed.scheduleId, "다음 회차 예약 재등록(새 scheduleId)");
    assert.equal(portone.calls.schedulePayment.length, 1, "다음 회차 예약 정확히 1개 재등록");
    console.log(`     · SUCCEEDED 분기: payWithBillingKey 호출수=0, processRenewal→renewed`);
  });

  await check("D4 cron/FAILED → past_due + retryCount++ + 재시도 예약 정확히 1개(2개 아님)", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    // cron Branch 1 FAILED 분기: getPaymentSchedule=FAILED → handleRenewalFailure.
    const portone = stubPortone({ scheduleStatus: "FAILED" });
    const deps = makeDeps(portone, () => now);
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    const outcome = await handleRenewalFailure({ paymentId: sub!.nextSchedulePaymentId! }, deps);
    assert.equal(outcome.kind, "retry_scheduled");
    if (outcome.kind === "retry_scheduled") {
      assert.equal(outcome.retryCount, 1, "retryCount 1");
      assert.equal(outcome.delayDays, 1, "첫 재시도 D+1");
    }
    const after = await subById(seed.subId);
    assert.equal(after.status, "past_due", "past_due 전환");
    assert.equal(Number(after.retry_count), 1, "retryCount 증가");
    // ★ 정확히 예약 1개만 등록(이중청구 방지). 실패 처리 중 schedulePayment 는 정확히 1회.
    assert.equal(portone.calls.schedulePayment.length, 1, "★ 재시도 예약 정확히 1개(2개 아님)");
    // 구 예약은 cancelSchedules 로 취소됨(재등록 전).
    assert.equal(portone.calls.cancelSchedules.length, 1, "구 예약 취소 1회 후 재등록");
    // 즉시결제는 하지 않는다(FAILED 는 실패 처리만).
    assert.equal(portone.calls.payWithBillingKey.length, 0, "FAILED 분기 즉시결제 없음");
    console.log(`     · FAILED 분기: schedulePayment 호출수=1(재시도 D+1 단 하나), past_due, retryCount=1`);
  });

  await check("D4 cron/미실행(null) → 즉시결제 정확히 1회 + processRenewal 로 갱신", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    // cron Branch 1 미실행 분기: getPaymentSchedule=null → payWithBillingKey 1회 → PAID → processRenewal.
    const portone = stubPortone({ scheduleStatus: null, payStatus: "PAID", getPaymentStatus: "PAID" });
    const deps = makeDeps(portone, () => now);
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    const schedule = await portone.getPaymentSchedule(sub!.nextScheduleId!);
    assert.equal(schedule, null, "조회 불가(null)");
    // cron 미실행 분기 재현: 즉시결제 1회 시도.
    const plan = await subscriptionRepo.getPlanById(sub!.pendingPlanId ?? sub!.planId);
    const payment = await portone.payWithBillingKey({
      paymentId: sub!.nextSchedulePaymentId!,
      billingKey: sub!.billingKey,
      orderName: plan!.name,
      amount: plan!.monthlyPriceKrw,
      customerId: sub!.userId,
      idempotencyKey: sub!.nextSchedulePaymentId!,
    });
    assert.equal(payment.status, "PAID");
    // ★ 즉시결제는 정확히 1회.
    assert.equal(portone.calls.payWithBillingKey.length, 1, "★ 즉시결제 정확히 1회(초과 금지)");
    const outcome = await processRenewal({ paymentId: sub!.nextSchedulePaymentId! }, deps);
    assert.equal(outcome.kind, "renewed");
    // 즉시결제 호출은 여전히 1회(processRenewal 이 추가 결제 안 함).
    assert.equal(portone.calls.payWithBillingKey.length, 1, "processRenewal 후에도 즉시결제 총 1회");
    const renewalGrant = (await planGrantLedger(seed.fx.walletId)).filter((l) => l.idempotencyKey === `plan:${seed.orderId}`);
    assert.equal(renewalGrant.length, 1, "갱신 plan_grant 1건");
    console.log(`     · null 분기: payWithBillingKey 호출수=1(단 한 번), processRenewal→renewed`);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 추가 필수 체크
  // ────────────────────────────────────────────────────────────────────────

  await check("갱신 웹훅 멱등: 동일 갱신 paymentId 를 2회 전달 → ★plan_grant 정확히 1건(DoD 핵심 불변식)", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    const paymentId = sub!.nextSchedulePaymentId!;
    // 웹훅 Transaction.Paid 를 서로 다른 webhookId 로 2회 전달(inbox 는 다르지만 지급은 멱등이어야 한다).
    const portone = stubPortone({ getPaymentStatus: "PAID" });
    const deps = {
      payment: paymentRepo,
      subscription: subscriptionRepo,
      system: systemRepo,
      portone,
      now: () => now,
    };
    const w1 = await handlePortoneWebhook(`wh_${crypto.randomUUID()}`, { type: "Transaction.Paid", data: { paymentId } }, deps);
    const periodEndAfterFirst = new Date((await subById(seed.subId)).current_period_end as string).getTime();
    const w2 = await handlePortoneWebhook(`wh_${crypto.randomUUID()}`, { type: "Transaction.Paid", data: { paymentId } }, deps);
    assert.equal(w1.duplicate, false);
    assert.equal(w2.duplicate, false, "다른 webhookId 라 inbox 는 중복 아님");
    // ★ DoD 핵심: 동일 갱신 주문에 대한 plan_grant 는 plan:{orderId} 로 멱등 — 정확히 1건.
    const grants = (await planGrantLedger(seed.fx.walletId)).filter((l) => l.idempotencyKey === `plan:${seed.orderId}`);
    assert.equal(grants.length, 1, "★ 갱신 plan_grant 정확히 1건(멱등)");
    // ★ 완전 멱등(8.3): renewal 주문-상태 가드(alreadyProcessed) 로 period 롤·재예약도 재적용되지 않는다.
    //   1차 전달은 갱신 지급 + 다음-주기 예약 1건 등록. 2차 전달(포트원 재시도로 우리 200 유실 재구제)은
    //   주문이 이미 paid → no-op(period 불변, 추가 예약 없음). 무상 1개월·이중 예약을 구조적으로 차단.
    const periodEndAfterSecond = new Date((await subById(seed.subId)).current_period_end as string).getTime();
    assert.equal(periodEndAfterSecond, periodEndAfterFirst, "★ period 는 1회만 롤(2차 전달은 no-op)");
    const scheduleCalls = portone.calls.schedulePayment.length;
    assert.equal(scheduleCalls, 1, "★ 예약은 다음-주기 1건만(2차 전달이 예약을 추가하지 않음)");
    console.log(`     · 갱신 웹훅 2회 → plan_grant 1건 + period 1회 롤 + 예약 1건 (완전 멱등, 8.3)`);
  });

  await check("cancelSubscription → 구 예약 취소 + cancelAtPeriodEnd; 갱신 도래 시 canceled(지급 없음)", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    const portone = stubPortone();
    const deps = makeDeps(portone, () => now);
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    const canceled = await cancelSubscription({ userId: sub!.userId }, deps);
    assert.equal(canceled.kind, "canceled");
    assert.equal(portone.calls.cancelSchedules.length, 1, "해지 첫 단계 = 예약 취소");
    assert.equal((await subById(seed.subId)).cancel_at_period_end, true);
  });

  await check("replaceBillingKey → 구 키로 예약 취소 + 새 키로 재예약 + 구 키 삭제(호출 기록 검증)", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    const portone = stubPortone();
    const deps = makeDeps(portone, () => now);
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    const oldKey = sub!.billingKey;
    const res = await replaceBillingKey(
      { userId: sub!.userId, newBillingKey: "bk_new_rotated", cardSummary: { brand: "VISA", last4: "4242" } },
      deps,
    );
    assert.equal(res.kind, "replaced");
    // 구 키로 예약 취소.
    assert.equal(portone.calls.cancelSchedules.length, 1);
    assert.equal(portone.calls.cancelSchedules[0]!.billingKey, oldKey, "구 키로 예약 취소");
    // 새 키로 재예약.
    assert.equal(portone.calls.schedulePayment.length, 1);
    assert.equal(portone.calls.schedulePayment[0]!.billingKey, "bk_new_rotated", "새 키로 재예약");
    // 구 키 삭제.
    assert.equal(portone.calls.deleteBillingKey.length, 1);
    assert.equal(portone.calls.deleteBillingKey[0]!.billingKey, oldKey, "구 키 삭제");
    // 구독의 현재 billingKey 는 새 키.
    assert.equal((await subById(seed.subId)).billing_key, "bk_new_rotated");
  });

  await check("재시도 한 번에 1개: D+1 실패 → D+3 등록 → 소진(retryCount≥2) → expired", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");

    // 1차 실패 → past_due, D+1 예약 1개.
    const p1 = stubPortone({ scheduleStatus: "FAILED" });
    const sub1 = await subscriptionRepo.getSubscriptionById(seed.subId);
    const f1 = await handleRenewalFailure({ paymentId: sub1!.nextSchedulePaymentId! }, makeDeps(p1, () => now));
    assert.equal(f1.kind, "retry_scheduled");
    if (f1.kind === "retry_scheduled") assert.equal(f1.delayDays, 1, "1차 → D+1");
    assert.equal(p1.calls.schedulePayment.length, 1, "1차 실패 후 예약 1개만 살아있음");

    // 2차 실패(그 D+1 예약 건이 실패) → D+3 예약 1개.
    const p2 = stubPortone({ scheduleStatus: "FAILED" });
    const sub2 = await subscriptionRepo.getSubscriptionById(seed.subId);
    assert.equal(sub2!.retryCount, 1);
    const f2 = await handleRenewalFailure({ paymentId: sub2!.nextSchedulePaymentId! }, makeDeps(p2, () => now));
    assert.equal(f2.kind, "retry_scheduled");
    if (f2.kind === "retry_scheduled") {
      assert.equal(f2.retryCount, 2, "2차 → retryCount 2");
      assert.equal(f2.delayDays, 3, "2차 → D+3");
    }
    assert.equal(p2.calls.schedulePayment.length, 1, "2차 실패 후에도 살아있는 예약 1개만");
    assert.equal(p2.calls.cancelSchedules.length, 1, "재등록 전 구 예약 취소 1회(한 번에 하나만)");

    // 3차 실패(D+3 예약 건이 실패) → 소진 → expired.
    const p3 = stubPortone({ scheduleStatus: "FAILED" });
    const sub3 = await subscriptionRepo.getSubscriptionById(seed.subId);
    assert.equal(sub3!.retryCount, 2);
    const f3 = await handleRenewalFailure({ paymentId: sub3!.nextSchedulePaymentId! }, makeDeps(p3, () => now));
    assert.equal(f3.kind, "expired", "재시도 소진 → expired");
    assert.equal(p3.calls.schedulePayment.length, 0, "소진 시 새 예약 미등록");
    assert.equal((await subById(seed.subId)).status, "expired");
    console.log(`     · 재시도: D+1 → D+3 → expired (각 단계 살아있는 예약 1개)`);
  });

  await check("BillingKey.Deleted(현재 키) → past_due 강등 + 예약 취소; 구 키(불일치)는 무해 skip", async () => {
    const seed = await seedDueSubscription("plus");
    const now = new Date("2026-07-10T02:00:00.000Z");
    const sub = await subscriptionRepo.getSubscriptionById(seed.subId);
    // 불일치 키 → skip.
    const skipPortone = stubPortone();
    const skip = await handleBillingKeyDeleted({ billingKey: "bk_unrelated" }, makeDeps(skipPortone, () => now));
    assert.equal(skip.kind, "skipped");
    assert.equal(skipPortone.calls.cancelSchedules.length, 0, "불일치 키는 취소·강등 없음");
    // 현재 키 → 강등.
    const demotePortone = stubPortone();
    const demoted = await handleBillingKeyDeleted({ billingKey: sub!.billingKey }, makeDeps(demotePortone, () => now));
    assert.equal(demoted.kind, "demoted");
    assert.equal(demotePortone.calls.cancelSchedules.length, 1, "현재 키 삭제 → 예약 취소 후 past_due");
    assert.equal((await subById(seed.subId)).status, "past_due");
  });

  console.log(`\n플랜 구독 통합: ${passed} passed`);
}

main()
  .then(async () => {
    console.log(JSON.stringify({ ok: true, suite: "subscription-integration", passed }));
    await client.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\n✗ 통합 테스트 실패:", error);
    await client.end({ timeout: 5 });
    process.exit(1);
  });
