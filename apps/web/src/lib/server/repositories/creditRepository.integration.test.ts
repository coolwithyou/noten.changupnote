/**
 * 크레딧 리포지토리 통합 테스트 (실제 Postgres 필요, 설계 16.2).
 *
 * ★ 안전장치: DATABASE_URL 호스트가 pooler.supabase.com 이면 즉시 abort. 실서비스 공용 DB 에 절대 쓰지 않는다.
 *   일회용 컨테이너에서만 실행한다:
 *     docker run --rm -d --name cunote-credit-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:16
 *     (전체 마이그레이션 적용 후)
 *     DATABASE_URL=postgres://postgres:test@127.0.0.1:54340/cunote \
 *       pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/repositories/creditRepository.integration.test.ts
 *
 * 커버(16.2 중 P2):
 *   - 동시성: 잔액 1,000 에서 600 hold 5개 병렬 → 정확히 1개 성공
 *   - 동시성: 동일 idempotencyKey 분개 2회 병렬 → 1건
 *   - TTL 경과 후 capture(B3): cron 이 failed 로 만든 뒤 capture 도착 → 분개 + settled 복귀 + captured_late
 *   - hold 중 lot 만료(M8): hold 시점 살아있던 lot 이 capture 시점 만료 → 만료 유예 필터로 정상 차감
 *   - capture actual > held(shortfall): 잔액 0 클램프 + creditsCharged=실차감액 + context_ref.shortfall
 *   - capture actual < held: 차액 정상 처리
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { idempotencyKeys } from "@cunote/core";
import * as schema from "../db/schema";
import { DrizzleCreditRepository } from "./creditRepository";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL ?? "";
if (!url) {
  console.error("DATABASE_URL 이 필요합니다 (일회용 테스트 컨테이너).");
  process.exit(1);
}
if (url.includes("pooler.supabase.com") || url.includes("supabase.co")) {
  console.error(`ABORT: 실서비스 공용 DB 로 보이는 호스트입니다. 통합 테스트를 중단합니다.\n  url host=${new URL(url).host}`);
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

// user 컨텍스트를 세팅해 RLS/코드 가드 경로를 실제로 통과시키는 리포지토리.
const repo = new DrizzleCreditRepository({ client: db });

/**
 * 테스트 fixture: user + wallet 을 만들고, 초기 잔액을 ★ 실제 원장 지급 분개로 넣는다
 * (지갑·lot·ledger 를 out-of-band 로 만들면 I1/I9 불변식이 깨지므로, 리포지토리 진입점으로 지급).
 * lotExpiresAt 지정 시 지급 후 해당 lot 의 만료를 조정한다(M8 시나리오).
 */
async function seedWallet(input: { balance: number; lotExpiresAt?: Date | null; source?: string }): Promise<{ userId: string; walletId: string; lotId: string }> {
  const userId = crypto.randomUUID();
  await client`INSERT INTO users (id, email) VALUES (${userId}, ${`credit-test-${userId}@example.com`})`;
  const walletId = crypto.randomUUID();
  await client`INSERT INTO credit_wallets (id, user_id, balance_credits, status) VALUES (${walletId}, ${userId}, 0, 'active')`;
  // 초기 잔액을 실제 지급 분개로(admin_grant). source 기본은 admin_grant, purchase/plan_grant 지정 가능.
  const grantSource = (input.source ?? "admin_grant") as "signup_bonus" | "purchase" | "plan_grant" | "admin_grant" | "promo";
  const entryType = grantSource === "purchase"
    ? "purchase_grant"
    : grantSource === "plan_grant"
      ? "plan_grant"
      : grantSource === "signup_bonus"
        ? "signup_bonus_grant"
        : grantSource === "promo"
          ? "promo_grant"
          : "admin_grant";
  const entry = await repo.applyLedgerEntry(userId, {
    walletId,
    entryType,
    amountCredits: input.balance,
    idempotencyKey: `seed:${crypto.randomUUID()}`,
    actorType: "system",
    actorId: "seed",
    reason: "테스트 초기 잔액",
    grantLot: { source: grantSource, expiresAt: input.lotExpiresAt ?? null },
  });
  const lotId = entry.lotBreakdown[0]!.lotId;
  return { userId, walletId, lotId };
}

/** 과금 파이프라인 진입: pending usage_event 생성 후 hold 획득. */
async function acquire(userId: string, walletId: string, estimatedCredits: number) {
  const { id: usageEventId } = await repo.createPendingUsageEvent(userId, {
    walletId, companyId: null, featureCode: "application_draft", provider: "anthropic",
    model: "claude-sonnet-5", pricingRuleId: null, requestId: crypto.randomUUID(),
  });
  const hold = await repo.acquireHold(userId, { walletId, usageEventId, estimatedCredits });
  return { usageEventId, hold };
}

try {
  // 설정: hold_buffer_ratio=1.0 로 두어 held=estimated 로 단순화(테스트 산정 용이).
  await client`
    INSERT INTO credit_settings (key, value) VALUES
      ('hold_buffer_ratio', '{"value":1.0}'::jsonb),
      ('hold_ttl_seconds', '{"value":600}'::jsonb),
      ('company_bonus_consumption_cap', '{"value":3000}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;

  // ── 동시성 1: 600 hold 5개 병렬 → 정확히 1개 성공 (잔액 1,000) ──────────
  await check("동시성: 잔액 1,000 에서 600 hold 5개 병렬 → 정확히 1개 성공", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => acquire(userId, walletId, 600)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    assert.equal(ok, 1, `정확히 1개 성공해야 함 (실제 ${ok})`);
    assert.equal(rejected, 4, `4개는 402 로 거부돼야 함 (실제 ${rejected})`);
    // I8: available >= 0 유지.
    const [row] = await client`
      SELECT balance_credits::bigint AS balance,
             COALESCE((SELECT SUM(held_credits) FROM credit_holds WHERE wallet_id=${walletId} AND status='pending'),0)::bigint AS pending
      FROM credit_wallets WHERE id=${walletId}`;
    assert.ok(Number(row!.balance) - Number(row!.pending) >= 0, "I8 available >= 0");
  });

  // ── 동시성 2: 동일 idempotencyKey 분개 2회 병렬 → 1건 ──────────────────
  await check("동시성: 동일 idempotencyKey 분개 2회 병렬 → 1건", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const key = idempotencyKeys.admin(crypto.randomUUID());
    const both = await Promise.allSettled([
      repo.applyLedgerEntry(userId, {
        walletId, entryType: "admin_grant", amountCredits: 500, idempotencyKey: key,
        actorType: "admin", actorId: "admin-1", reason: "동시성 테스트",
        grantLot: { source: "admin_grant", expiresAt: null },
      }),
      repo.applyLedgerEntry(userId, {
        walletId, entryType: "admin_grant", amountCredits: 500, idempotencyKey: key,
        actorType: "admin", actorId: "admin-1", reason: "동시성 테스트",
        grantLot: { source: "admin_grant", expiresAt: null },
      }),
    ]);
    const fulfilled = both.filter((r) => r.status === "fulfilled").length;
    assert.ok(fulfilled >= 1, "최소 1개 성공");
    const [cnt] = await client`SELECT COUNT(*)::int AS n FROM credit_ledger WHERE idempotency_key=${key}`;
    assert.equal(Number(cnt!.n), 1, `분개는 정확히 1건이어야 함 (실제 ${cnt!.n})`);
    // 잔액은 500 만 증가(1000 → 1500), 1000 이 아님.
    const [w] = await client`SELECT balance_credits::bigint AS b FROM credit_wallets WHERE id=${walletId}`;
    assert.equal(Number(w!.b), 1500, "멱등: 500 만 지급");
  });

  // ── B3: TTL 경과 후 capture → 분개 + settled 복귀 + captured_late ──────
  await check("B3: TTL 경과 hold 를 cron 이 failed 로 만든 뒤 capture 도착 → settled 복귀 + captured_late", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const { usageEventId, hold } = await acquire(userId, walletId, 300);
    // cron 시뮬레이션: hold 를 released(ttl_expired) + usage failed(hold_expired) 로.
    await client`UPDATE credit_holds SET status='released', released_reason='ttl_expired', expires_at=now()-interval '1 minute' WHERE id=${hold.id}::uuid`;
    await client`UPDATE usage_events SET status='failed', error_code='hold_expired' WHERE id=${usageEventId}::uuid`;

    // 뒤늦은 capture 도착(레드팀 B3): hold 상태 무관하게 정산이 이긴다.
    const cap = await repo.captureHold(userId, { holdId: hold.id, actualCredits: 250 });
    assert.equal(cap.creditsCharged, 250, "실차감 250");
    assert.equal(cap.capturedLate, true, "TTL 경과 후 정산 → capturedLate");

    const [h] = await client`SELECT status, released_reason FROM credit_holds WHERE id=${hold.id}::uuid`;
    assert.equal(h!.status, "captured");
    assert.equal(h!.released_reason, "captured_late", "captured_late 기록");
    const [ue] = await client`SELECT status, credits_charged::bigint AS c, error_code FROM usage_events WHERE id=${usageEventId}::uuid`;
    assert.equal(ue!.status, "settled", "failed → settled 복귀");
    assert.equal(Number(ue!.c), 250);
    assert.equal(ue!.error_code, null, "error_code 해제");
    // 분개 존재 + audit(usage.capture_after_expiry).
    const [led] = await client`SELECT COUNT(*)::int AS n FROM credit_ledger WHERE usage_event_id=${usageEventId}::uuid AND entry_type='usage_capture'`;
    assert.equal(Number(led!.n), 1, "정산 분개 1건");
    const [aud] = await client`SELECT COUNT(*)::int AS n FROM credit_audit_logs WHERE action='usage.capture_after_expiry' AND target_id=${walletId}`;
    assert.ok(Number(aud!.n) >= 1, "capture_after_expiry 감사");
    const [w] = await client`SELECT balance_credits::bigint AS b FROM credit_wallets WHERE id=${walletId}`;
    assert.equal(Number(w!.b), 750, "1000 - 250");
  });

  // ── M8: hold 중 lot 만료 → 만료 유예 필터로 정상 차감 ──────────────────
  await check("M8: hold 시점 살아있던 lot 이 capture 시점 만료 → 만료 유예로 정상 차감", async () => {
    // lot 을 미래 만료로 만들고 hold 획득 → 그 뒤 lot 을 과거 만료로 당긴다.
    const future = new Date(Date.now() + 60_000);
    const { userId, walletId, lotId } = await seedWallet({ balance: 500, lotExpiresAt: future, source: "plan_grant" });
    const { hold } = await acquire(userId, walletId, 300);
    // hold.createdAt 이후로 만료를 당긴다(capture 시점엔 이미 만료). hold.createdAt < now 이므로
    // 만료 유예 필터(expires_at > hold.createdAt)를 만족하도록 hold.createdAt 직후 시각으로 만료 설정.
    const [holdRow] = await client`SELECT created_at FROM credit_holds WHERE id=${hold.id}::uuid`;
    const graceExpiry = new Date(new Date(holdRow!.created_at as string).getTime() + 1); // hold.createdAt + 1ms > hold.createdAt
    await client`UPDATE credit_lots SET expires_at=${graceExpiry.toISOString()}::timestamptz WHERE id=${lotId}::uuid`;
    // 이제 lot 은 now 기준 만료됐지만 expires_at > hold.createdAt 이므로 capture 는 이 lot 을 소진할 수 있어야 한다.
    const cap = await repo.captureHold(userId, { holdId: hold.id, actualCredits: 200 });
    assert.equal(cap.creditsCharged, 200, "만료 유예 lot 에서 정상 차감");
    assert.equal(cap.shortfall, 0, "shortfall 없음");
    const [lot] = await client`SELECT remaining_credits::bigint AS r FROM credit_lots WHERE id=${lotId}::uuid`;
    assert.equal(Number(lot!.r), 300, "500 - 200");
  });

  // ── shortfall: actual > 잔여 lot → 잔액 0 클램프 + context_ref.shortfall ─
  await check("shortfall: actual > 총 잔여 → 클램프 + creditsCharged=실차감 + context_ref.shortfall", async () => {
    const { userId, walletId } = await seedWallet({ balance: 100 });
    const { usageEventId, hold } = await acquire(userId, walletId, 100);
    // 실제 사용이 예상보다 큼(150) — 잔여 100 만 차감 가능.
    const cap = await repo.captureHold(userId, { holdId: hold.id, actualCredits: 150 });
    assert.equal(cap.creditsCharged, 100, "잔액 0 클램프 → 실차감 100");
    assert.equal(cap.shortfall, 50, "부족분 50");
    const [ue] = await client`SELECT credits_charged::bigint AS c, (context_ref->>'shortfall')::bigint AS sf FROM usage_events WHERE id=${usageEventId}::uuid`;
    assert.equal(Number(ue!.c), 100);
    assert.equal(Number(ue!.sf), 50, "context_ref.shortfall=50");
    const [w] = await client`SELECT balance_credits::bigint AS b FROM credit_wallets WHERE id=${walletId}`;
    assert.equal(Number(w!.b), 0, "음수 없이 0 클램프");
    const [aud] = await client`SELECT COUNT(*)::int AS n FROM credit_audit_logs WHERE action='usage.shortfall' AND target_id=${walletId}`;
    assert.ok(Number(aud!.n) >= 1, "usage.shortfall 감사");
  });

  // ── actual < held: 차액 정상 처리 ────────────────────────────────────
  await check("capture actual < held: 실사용만 차감(차액 반환)", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const { hold } = await acquire(userId, walletId, 500); // held=500
    const cap = await repo.captureHold(userId, { holdId: hold.id, actualCredits: 120 });
    assert.equal(cap.creditsCharged, 120);
    assert.equal(cap.shortfall, 0);
    const [w] = await client`SELECT balance_credits::bigint AS b FROM credit_wallets WHERE id=${walletId}`;
    assert.equal(Number(w!.b), 880, "1000 - 120 (held 500 은 예약일 뿐 분개 아님)");
    // hold 는 captured, pending 아님 → available 회복.
    const [h] = await client`SELECT status FROM credit_holds WHERE id=${hold.id}::uuid`;
    assert.equal(h!.status, "captured");
  });

  // ── capture 멱등: 같은 hold 재-capture → no-op ────────────────────────
  await check("capture 멱등: 이미 captured 인 hold 재-capture → no-op", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const { hold } = await acquire(userId, walletId, 300);
    const first = await repo.captureHold(userId, { holdId: hold.id, actualCredits: 200 });
    const second = await repo.captureHold(userId, { holdId: hold.id, actualCredits: 999 }); // 다른 값이어도 no-op.
    assert.equal(first.creditsCharged, 200);
    assert.equal(second.creditsCharged, 200, "재-capture 는 첫 정산값 반환(멱등)");
    const [w] = await client`SELECT balance_credits::bigint AS b FROM credit_wallets WHERE id=${walletId}`;
    assert.equal(Number(w!.b), 800, "이중 차감 없음");
  });

  // ── 트리거: credit_ledger UPDATE 시도 → 예외(append-only) ─────────────
  await check("append-only 트리거: credit_ledger UPDATE → 예외", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    await repo.applyLedgerEntry(userId, {
      walletId, entryType: "admin_grant", amountCredits: 100, idempotencyKey: idempotencyKeys.admin(crypto.randomUUID()),
      actorType: "admin", actorId: "a1", reason: "트리거 테스트", grantLot: { source: "admin_grant", expiresAt: null },
    });
    await assert.rejects(
      () => client`UPDATE credit_ledger SET amount_credits = 999 WHERE wallet_id = ${walletId}`,
      /append-only/,
    );
  });

  // ── hold 만료 cron 로직: pending & 만료 → released + usage failed ──────
  await check("hold 만료 cron: pending & expires<now → released(ttl_expired) + usage failed(hold_expired)", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const { usageEventId, hold } = await acquire(userId, walletId, 200);
    // 만료 시각을 과거로.
    await client`UPDATE credit_holds SET expires_at = now() - interval '1 minute' WHERE id = ${hold.id}::uuid`;
    // cron 라우트와 동일한 스윕 SQL(요약).
    await client`
      WITH due AS (
        SELECT id, usage_event_id FROM credit_holds
        WHERE status='pending' AND expires_at < now() FOR UPDATE SKIP LOCKED
      ), released AS (
        UPDATE credit_holds h SET status='released', released_reason='ttl_expired', updated_at=now()
        FROM due WHERE h.id=due.id RETURNING h.usage_event_id
      )
      UPDATE usage_events SET status='failed', error_code='hold_expired', updated_at=now()
      WHERE id IN (SELECT usage_event_id FROM released) AND status='pending'
    `;
    const [h] = await client`SELECT status, released_reason FROM credit_holds WHERE id=${hold.id}::uuid`;
    assert.equal(h!.status, "released");
    assert.equal(h!.released_reason, "ttl_expired");
    const [ue] = await client`SELECT status, error_code FROM usage_events WHERE id=${usageEventId}::uuid`;
    assert.equal(ue!.status, "failed");
    assert.equal(ue!.error_code, "hold_expired");
    // 원장 분개는 없다(hold 는 분개가 아님).
    const [led] = await client`SELECT COUNT(*)::int AS n FROM credit_ledger WHERE usage_event_id=${usageEventId}::uuid`;
    assert.equal(Number(led!.n), 0);
  });

  console.log(JSON.stringify({ ok: true, suite: "credits/integration", passed }, null, 2));
} catch (error) {
  console.error("INTEGRATION TEST FAILED:", error instanceof Error ? error.message : String(error));
  const cause = (error as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause instanceof Error ? cause.message : String(cause), (cause as { code?: string; detail?: string }).code, (cause as { detail?: string }).detail);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
