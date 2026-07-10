/**
 * 대사(reconciliation) + lot 만료 cron 통합 테스트 (실제 Postgres 필요, 설계 14.1 / 5.4 / 16.2).
 *
 * ★ 안전장치: DATABASE_URL 호스트가 pooler.supabase.com/supabase.co 면 즉시 abort.
 *   실서비스 공용 DB 에 절대 쓰지 않는다. 일회용 컨테이너에서만 실행한다.
 *
 * 셋업(공용 DB 스키마 덤프 → 컨테이너 복원, refund.integration.test.ts 와 동일):
 *   1) pg_dump --schema-only --no-owner --no-privileges → /tmp/schema.sql
 *   2) docker run --rm -d --name cunote-recon-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:17
 *   3) psql "postgres://postgres:test@127.0.0.1:54340/cunote" -f /tmp/schema.sql
 *   4) DATABASE_URL=postgres://postgres:test@127.0.0.1:54340/cunote pnpm test:credits-reconcile-integration
 *
 * 커버(16.2 P7 + G1/G2):
 *   C1  정상 데이터: 5 scope 전부 ok(포트원 미주입 → portone_orders 만 error)
 *   C2  트리거: credit_ledger UPDATE 시도 → append-only 트리거 예외
 *   C3  chainHash: 트리거 DISABLE 후 amount 변조 → ledger_wallet scope 가 chainHash 로 검출(mismatch)
 *   C4  I1: 지갑 balance 직접 UPDATE → ledger_wallet scope I1 mismatch
 *   C5  holds: 선기록 토큰 있는 released hold + 미정산 → holds scope 가 수동 정산 큐로 리포트
 *   C6  만료 cron: expiry 분개 targetLotIds + lot expired + I1/I2 유지
 *   C7  만료 cron: pending hold 지갑 스킵
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { DrizzleCreditRepository } from "../repositories/creditRepository";
import { runReconciliationScopes } from "./reconciliationService";
import { expireLots } from "./lotExpiryService";

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
const repo = new DrizzleCreditRepository({ client: db });

/** user + wallet 생성 + 실제 지급 분개로 초기 잔액(I1/I9 를 깨지 않기 위해 원장 경유). */
async function seedWallet(input: {
  balance: number;
  lotExpiresAt?: Date | null;
  source?: "signup_bonus" | "purchase" | "plan_grant" | "admin_grant" | "promo";
}): Promise<{ userId: string; walletId: string; lotId: string }> {
  const userId = crypto.randomUUID();
  await client`INSERT INTO users (id, email) VALUES (${userId}, ${`recon-test-${userId}@example.com`})`;
  const walletId = crypto.randomUUID();
  await client`INSERT INTO credit_wallets (id, user_id, balance_credits, status) VALUES (${walletId}, ${userId}, 0, 'active')`;
  const grantSource = input.source ?? "admin_grant";
  const entryType =
    grantSource === "purchase"
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

function scopeStatus(results: Awaited<ReturnType<typeof runReconciliationScopes>>["results"], scope: string): string {
  return results.find((r) => r.scope === scope)?.status ?? "missing";
}

try {
  await client`
    INSERT INTO credit_settings (key, value) VALUES
      ('hold_buffer_ratio', '{"value":1.0}'::jsonb),
      ('hold_ttl_seconds', '{"value":600}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;

  // ── C1: 정상 데이터 → 5 scope 전부 ok(포트원 미주입은 portone_orders 만 error) ──
  await check("C1 정상 데이터: ledger_wallet/lot_ledger/holds/admin_activity=ok, portone=error(키 미설정)", async () => {
    await seedWallet({ balance: 1000 });
    const { results } = await runReconciliationScopes(db, { portone: null });
    assert.equal(scopeStatus(results, "ledger_wallet"), "ok", "ledger_wallet ok");
    assert.equal(scopeStatus(results, "lot_ledger"), "ok", "lot_ledger ok");
    assert.equal(scopeStatus(results, "holds"), "ok", "holds ok");
    assert.equal(scopeStatus(results, "admin_activity"), "ok", "admin_activity ok");
    // 포트원 미주입 → 이 scope 만 error, 나머지는 진행됨(task 규범).
    assert.equal(scopeStatus(results, "portone_orders"), "error", "portone_orders error (미설정)");
  });

  // ── C2: 트리거 — credit_ledger UPDATE 시도 → append-only 예외 ──
  await check("C2 트리거: credit_ledger UPDATE → append-only 예외", async () => {
    const { walletId } = await seedWallet({ balance: 500 });
    const [entry] = await client`SELECT id FROM credit_ledger WHERE wallet_id=${walletId} LIMIT 1`;
    let threw = false;
    try {
      await client`UPDATE credit_ledger SET amount_credits = 999 WHERE id = ${entry!.id}::uuid`;
    } catch {
      threw = true;
    }
    assert.ok(threw, "append-only 트리거가 UPDATE 를 막아야 함");
  });

  // ── C3: chainHash — 트리거 DISABLE 후 amount 변조 → ledger_wallet 이 chainHash 로 검출 ──
  await check("C3 chainHash: 트리거 DISABLE 후 amount 변조 → ledger_wallet mismatch(변조 탐지)", async () => {
    const { walletId } = await seedWallet({ balance: 700 });
    const [entry] = await client`SELECT id FROM credit_ledger WHERE wallet_id=${walletId} LIMIT 1`;
    // 앱 역할이 트리거를 끌 수 있음(BYPASSRLS) — 이 우회를 chainHash 2선이 잡는지 검증(레드팀 M4).
    await client`ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_no_update`;
    try {
      // amount 만 변조(chainHash 는 그대로 → 재계산 불일치). balance_after 도 함께 틀어 I1 도 유도.
      await client`UPDATE credit_ledger SET amount_credits = amount_credits + 100 WHERE id = ${entry!.id}::uuid`;
    } finally {
      await client`ALTER TABLE credit_ledger ENABLE TRIGGER credit_ledger_no_update`;
    }
    const { results } = await runReconciliationScopes(db, { portone: null });
    const scope = results.find((r) => r.scope === "ledger_wallet")!;
    assert.equal(scope.status, "mismatch", "chainHash 변조가 mismatch 로 검출돼야 함");
    assert.ok(
      Number((scope.summary as { i10MismatchCount?: number }).i10MismatchCount ?? 0) > 0,
      "i10ChainMismatches 가 잡혀야 함",
    );
  });

  // ── C4: I1 — 지갑 balance 직접 UPDATE → ledger_wallet I1 mismatch ──
  await check("C4 I1: 지갑 balance 직접 UPDATE → ledger_wallet I1 mismatch", async () => {
    const { walletId } = await seedWallet({ balance: 300 });
    // credit_wallets 에는 append-only 트리거가 없다 — 직접 UPDATE 가능. I1 이 잡는다.
    await client`UPDATE credit_wallets SET balance_credits = balance_credits + 50 WHERE id = ${walletId}::uuid`;
    const { results } = await runReconciliationScopes(db, { portone: null });
    const scope = results.find((r) => r.scope === "ledger_wallet")!;
    assert.equal(scope.status, "mismatch", "balance 변조가 I1 mismatch 로 검출돼야 함");
    const mismatches = (scope.summary as { i1BalanceMismatches?: Array<{ walletId: string }> }).i1BalanceMismatches ?? [];
    assert.ok(mismatches.some((m) => m.walletId === walletId), "해당 지갑이 I1 mismatch 에 포함돼야 함");
  });

  // ── C5: holds — 선기록 토큰 있는 released hold + 미정산 → 수동 정산 큐 리포트(B3) ──
  await check("C5 holds: 선기록 토큰 있는 released hold 미정산 → 수동 정산 큐 리포트", async () => {
    const { userId, walletId } = await seedWallet({ balance: 1000 });
    const { id: usageEventId } = await repo.createPendingUsageEvent(userId, {
      walletId,
      companyId: null,
      featureCode: "application_draft",
      provider: "anthropic",
      model: "claude-sonnet-5",
      pricingRuleId: null,
      requestId: crypto.randomUUID(),
    });
    const hold = await repo.acquireHold(userId, { walletId, usageEventId, estimatedCredits: 300 });
    // 선기록(6.2 d-2): report(usage) 로 토큰이 UPDATE 된 상태를 모사.
    await client`UPDATE usage_events SET input_tokens=1200, output_tokens=800 WHERE id=${usageEventId}::uuid`;
    // hold 를 released 로(정산 없이). usage_capture 분개는 없음.
    await client`UPDATE credit_holds SET status='released', released_reason='ttl_expired' WHERE id=${hold.id}::uuid`;

    const { results } = await runReconciliationScopes(db, { portone: null });
    const scope = results.find((r) => r.scope === "holds")!;
    assert.equal(scope.status, "mismatch", "미정산 후보가 있으면 holds mismatch");
    const candidates =
      (scope.summary as { unsettledWithPreRecordedTokens?: Array<{ usageEventId: string }> })
        .unsettledWithPreRecordedTokens ?? [];
    assert.ok(candidates.some((c) => c.usageEventId === usageEventId), "선기록 토큰 미정산 후보로 리포트돼야 함");
  });

  // ── C6: 만료 cron — expiry 분개 targetLotIds + lot expired + I1/I2 유지 ──
  await check("C6 만료 cron: expiry 분개(targetLotIds) + lot expired + I1/I2 유지", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // 어제 만료.
    const { walletId, lotId } = await seedWallet({ balance: 400, lotExpiresAt: past, source: "plan_grant" });
    const result = await expireLots(db, new Date());
    assert.ok(result.lotsExpired >= 1, "만료 lot 이 처리돼야 함");
    // expiry 분개가 targetLotIds(해당 lot)로만 배분됐는지.
    const [led] = await client`
      SELECT lot_breakdown FROM credit_ledger
      WHERE wallet_id=${walletId} AND entry_type='expiry' ORDER BY created_at DESC LIMIT 1`;
    const breakdown = led!.lot_breakdown as Array<{ lotId: string; amount: number }>;
    assert.equal(breakdown.length, 1, "expiry 분개는 대상 lot 1개만 배분");
    assert.equal(breakdown[0]!.lotId, lotId, "지정 lot 만 깎임(targetLotIds)");
    // lot status=expired.
    const [lot] = await client`SELECT status, remaining_credits::bigint AS rem FROM credit_lots WHERE id=${lotId}::uuid`;
    assert.equal(lot!.status, "expired", "lot 은 expired 로 마감");
    assert.equal(Number(lot!.rem), 0, "remaining 0");
    // I1: balance = Σledger, I2: balance = Σactive lot(=0).
    const [w] = await client`
      SELECT balance_credits::bigint AS bal,
             COALESCE((SELECT SUM(amount_credits) FROM credit_ledger WHERE wallet_id=${walletId}),0)::bigint AS ledsum,
             COALESCE((SELECT SUM(remaining_credits) FROM credit_lots WHERE wallet_id=${walletId} AND status='active'),0)::bigint AS lotsum
      FROM credit_wallets WHERE id=${walletId}`;
    assert.equal(Number(w!.bal), Number(w!.ledsum), "I1 유지");
    assert.equal(Number(w!.bal), Number(w!.lotsum), "I2 유지");
    assert.equal(Number(w!.bal), 0, "만료 후 잔액 0");
  });

  // ── C7: 만료 cron — pending hold 지갑 스킵 ──
  await check("C7 만료 cron: pending hold 지갑은 이번 회차 스킵(5.4)", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { userId, walletId, lotId } = await seedWallet({ balance: 500, lotExpiresAt: past, source: "plan_grant" });
    // pending hold 를 만든다.
    const { id: usageEventId } = await repo.createPendingUsageEvent(userId, {
      walletId,
      companyId: null,
      featureCode: "application_draft",
      provider: "anthropic",
      model: "claude-sonnet-5",
      pricingRuleId: null,
      requestId: crypto.randomUUID(),
    });
    await repo.acquireHold(userId, { walletId, usageEventId, estimatedCredits: 100 });

    const before = await client`SELECT status FROM credit_lots WHERE id=${lotId}::uuid`;
    assert.equal(before[0]!.status, "active", "실행 전 active");
    await expireLots(db, new Date());
    const after = await client`SELECT status FROM credit_lots WHERE id=${lotId}::uuid`;
    assert.equal(after[0]!.status, "active", "pending hold 지갑의 lot 은 스킵되어 active 유지");
    // 이 지갑에는 expiry 분개가 없어야 한다.
    const [n] = await client`SELECT COUNT(*)::int AS c FROM credit_ledger WHERE wallet_id=${walletId} AND entry_type='expiry'`;
    assert.equal(Number(n!.c), 0, "스킵된 지갑에는 expiry 분개 없음");
  });

  console.log(JSON.stringify({ ok: true, suite: "credits/reconciliation-integration", passed }, null, 2));
} catch (error) {
  console.error("INTEGRATION TEST FAILED:", error instanceof Error ? error.message : String(error));
  const cause = (error as { cause?: unknown }).cause;
  if (cause)
    console.error(
      "CAUSE:",
      cause instanceof Error ? cause.message : String(cause),
      (cause as { code?: string }).code,
      (cause as { detail?: string }).detail,
    );
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
