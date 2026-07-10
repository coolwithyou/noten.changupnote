/**
 * 크레딧 원장 불변식 검증 (I1~I9 + chainHash 체인).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md 5.1 / 14.2.
 *
 * 실행: pnpm exec tsx packages/core/scripts/verify-credit-invariants.ts
 *   (tsx 실행, 기존 verify-* 스타일. DATABASE_URL 은 .env/.env.local 에서 로드.)
 *
 * 주의(프로젝트 메모리): verify 스크립트가 프로세스 미종료할 수 있는 기존 현상 —
 *   출력 완주(SUMMARY 라인)로 판정하고, 이 스크립트는 명시적으로 sql.end() 후 exit 한다.
 *
 * 불변식:
 *   I1 wallet.balance = Σ ledger.amount (지갑별)
 *   I2 wallet.balance = Σ lot.remaining (status=active)
 *   I3 음수 분개: Σ lotBreakdown.amount = -amount
 *   I4 양수(지급) 분개: lotBreakdown = [{lotId, initial}] (정확히 1개 lot)
 *   I5 lot: initial - remaining = Σ(해당 lot 참조 음수 분개 배분량)
 *   I6 usage(settled).credits_charged = -usage_capture.amount (shortfall 예외: +context_ref.shortfall)
 *   I7 paid 주문마다 purchase_grant/plan_grant 정확히 1건
 *   I8 available(= balance - Σ pending holds) >= 0
 *   I9 balance_after = 지갑 분개 createdAt·id 누적값
 *   I10 chainHash 체인 재계산 일치 (변조 탐지)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { recomputeWalletChain, type LedgerEntryForChain } from "../src/index.js";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!k || process.env[k] !== undefined) continue;
    process.env[k] = v.replace(/^['"]|['"]$/g, "");
  }
}

interface Violation {
  invariant: string;
  detail: string;
}

async function main() {
  loadEnvFile(".env");
  loadEnvFile(".env.local");
  const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!url) {
    console.error("DATABASE_URL 이 필요합니다.");
    process.exitCode = 1;
    return;
  }
  const sql = postgres(url, { prepare: false, max: 1 });
  const violations: Violation[] = [];
  const checks: string[] = [];

  try {
    // I1: wallet.balance = Σ ledger.amount
    checks.push("I1");
    const i1 = await sql`
      SELECT w.id, w.balance_credits::bigint AS balance,
             COALESCE((SELECT SUM(l.amount_credits) FROM credit_ledger l WHERE l.wallet_id = w.id), 0)::bigint AS ledger_sum
      FROM credit_wallets w
    `;
    for (const r of i1) {
      if (Number(r.balance) !== Number(r.ledger_sum)) {
        violations.push({ invariant: "I1", detail: `wallet ${r.id}: balance ${r.balance} != Σledger ${r.ledger_sum}` });
      }
    }

    // I2: wallet.balance = Σ lot.remaining (active)
    checks.push("I2");
    const i2 = await sql`
      SELECT w.id, w.balance_credits::bigint AS balance,
             COALESCE((SELECT SUM(lt.remaining_credits) FROM credit_lots lt WHERE lt.wallet_id = w.id AND lt.status = 'active'), 0)::bigint AS lot_sum
      FROM credit_wallets w
    `;
    for (const r of i2) {
      if (Number(r.balance) !== Number(r.lot_sum)) {
        violations.push({ invariant: "I2", detail: `wallet ${r.id}: balance ${r.balance} != Σactive_lots ${r.lot_sum}` });
      }
    }

    // I3: 음수 분개 Σ lotBreakdown.amount = -amount
    checks.push("I3");
    const i3 = await sql`
      SELECT id, amount_credits::bigint AS amount,
             COALESCE((SELECT SUM((elem->>'amount')::bigint) FROM jsonb_array_elements(lot_breakdown) elem), 0)::bigint AS breakdown_sum
      FROM credit_ledger
      WHERE amount_credits < 0
    `;
    for (const r of i3) {
      if (Number(r.breakdown_sum) !== -Number(r.amount)) {
        violations.push({ invariant: "I3", detail: `entry ${r.id}: Σbreakdown ${r.breakdown_sum} != ${-Number(r.amount)}` });
      }
    }

    // I4: 양수(지급) 분개 lotBreakdown = [{lotId, initial}] (정확히 1개)
    // reversal 은 지급 계열이 아니다(4.3). 양수 reversal 은 원분개 lot 복원/대체라 lot 을 새로 1개 생성하지
    // 않으며 breakdown 이 여러 라인일 수 있으므로 I4 대상에서 제외한다(레드팀 M5).
    checks.push("I4");
    const i4 = await sql`
      SELECT id, amount_credits::bigint AS amount, jsonb_array_length(lot_breakdown) AS n,
             COALESCE((SELECT SUM((elem->>'amount')::bigint) FROM jsonb_array_elements(lot_breakdown) elem), 0)::bigint AS breakdown_sum
      FROM credit_ledger
      WHERE amount_credits > 0 AND entry_type <> 'reversal'
    `;
    for (const r of i4) {
      if (Number(r.n) !== 1 || Number(r.breakdown_sum) !== Number(r.amount)) {
        violations.push({ invariant: "I4", detail: `entry ${r.id}: n=${r.n}, Σbreakdown ${r.breakdown_sum} vs amount ${r.amount}` });
      }
    }

    // I5: lot: initial - remaining = Σ(음수 분개 배분량) - Σ(그 lot 을 복원한 양수 reversal 배분량)
    // 음수 분개는 remaining 을 깎고(소비), 원 lot 을 되돌리는 양수 reversal 은 remaining 을 복원한다.
    // 순소비 = 음수 배분 합 - reversal 복원 합. 단 reversal 복원 차감은 "음수 분개가 참조한 적 있는 lot"
    // 에만 적용한다 — reversal 이 만든 대체(replace) lot 은 새 grant 처럼 consumed=0 이므로 차감하면 안 된다.
    checks.push("I5");
    const i5 = await sql`
      SELECT lt.id, (lt.initial_credits - lt.remaining_credits)::bigint AS consumed,
             (COALESCE((
               SELECT SUM((elem->>'amount')::bigint)
               FROM credit_ledger l, jsonb_array_elements(l.lot_breakdown) elem
               WHERE l.amount_credits < 0 AND (elem->>'lotId') = lt.id::text
             ), 0)
             - CASE WHEN EXISTS (
                 SELECT 1 FROM credit_ledger l, jsonb_array_elements(l.lot_breakdown) elem
                 WHERE l.amount_credits < 0 AND (elem->>'lotId') = lt.id::text
               ) THEN COALESCE((
                 SELECT SUM((elem->>'amount')::bigint)
                 FROM credit_ledger l, jsonb_array_elements(l.lot_breakdown) elem
                 WHERE l.amount_credits > 0 AND l.entry_type = 'reversal' AND (elem->>'lotId') = lt.id::text
               ), 0) ELSE 0 END)::bigint AS allocated
      FROM credit_lots lt
    `;
    for (const r of i5) {
      if (Number(r.consumed) !== Number(r.allocated)) {
        violations.push({ invariant: "I5", detail: `lot ${r.id}: consumed ${r.consumed} != Σallocated ${r.allocated}` });
      }
    }

    // I6: usage(settled).credits_charged = -usage_capture.amount (shortfall 예외)
    checks.push("I6");
    const i6 = await sql`
      SELECT ue.id, ue.credits_charged::bigint AS charged, (-l.amount_credits)::bigint AS captured,
             COALESCE((ue.context_ref->>'shortfall')::bigint, 0)::bigint AS shortfall
      FROM usage_events ue
      JOIN credit_ledger l ON l.usage_event_id = ue.id AND l.entry_type = 'usage_capture'
      WHERE ue.status = 'settled'
    `;
    for (const r of i6) {
      if (Number(r.charged) !== Number(r.captured)) {
        violations.push({ invariant: "I6", detail: `usage ${r.id}: charged ${r.charged} != -capture ${r.captured}` });
      }
    }

    // I7: paid 주문마다 purchase_grant/plan_grant 정확히 1건
    checks.push("I7");
    const i7 = await sql`
      SELECT o.id, o.order_type,
             (SELECT COUNT(*) FROM credit_ledger l WHERE l.payment_order_id = o.id AND l.entry_type IN ('purchase_grant','plan_grant'))::int AS grants
      FROM credit_payment_orders o
      WHERE o.status = 'paid'
    `;
    for (const r of i7) {
      if (Number(r.grants) !== 1) {
        violations.push({ invariant: "I7", detail: `order ${r.id} (${r.order_type}): grant count ${r.grants} != 1` });
      }
    }

    // I8: available(= balance - Σ pending holds) >= 0
    checks.push("I8");
    const i8 = await sql`
      SELECT w.id, w.balance_credits::bigint AS balance,
             COALESCE((SELECT SUM(h.held_credits) FROM credit_holds h WHERE h.wallet_id = w.id AND h.status = 'pending'), 0)::bigint AS pending
      FROM credit_wallets w
    `;
    for (const r of i8) {
      if (Number(r.balance) - Number(r.pending) < 0) {
        violations.push({ invariant: "I8", detail: `wallet ${r.id}: balance ${r.balance} - pending ${r.pending} < 0` });
      }
    }

    // I9 + I10: balance_after 누적 일치 + chainHash 체인 재계산.
    // ★ 대사 cron(14.1)과 동일한 검증 코어(recomputeWalletChain)를 공유한다(14.2).
    checks.push("I9");
    checks.push("I10");
    const wallets = await sql`SELECT id FROM credit_wallets`;
    for (const w of wallets) {
      const rows = await sql`
        SELECT id, entry_type, amount_credits::bigint AS amount, balance_after::bigint AS balance_after,
               idempotency_key, chain_hash, created_at
        FROM credit_ledger
        WHERE wallet_id = ${w.id}
        ORDER BY created_at ASC, id ASC
      `;
      const entries: LedgerEntryForChain[] = rows.map((e) => ({
        id: e.id as string,
        entryType: e.entry_type as string,
        amountCredits: Number(e.amount),
        balanceAfter: Number(e.balance_after),
        idempotencyKey: e.idempotency_key as string,
        chainHash: e.chain_hash as string,
        createdAt: new Date(e.created_at as string),
      }));
      const result = recomputeWalletChain(w.id as string, entries);
      for (const m of result.balanceMismatches) {
        violations.push({ invariant: "I9", detail: `entry ${m.entryId}: running ${m.running} != balance_after ${m.balanceAfter}` });
      }
      for (const m of result.chainMismatches) {
        violations.push({ invariant: "I10", detail: `entry ${m.entryId}: chainHash mismatch (변조 의심)` });
      }
    }

    // 출력
    if (violations.length > 0) {
      console.error(`크레딧 불변식 위반 ${violations.length}건:`);
      for (const v of violations) console.error(`  [${v.invariant}] ${v.detail}`);
      process.exitCode = 1;
    }
    console.log(`SUMMARY: checks=[${checks.join(",")}] violations=${violations.length} ${violations.length === 0 ? "OK" : "FAIL"}`);
  } catch (error) {
    console.error("verify-credit-invariants error:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
