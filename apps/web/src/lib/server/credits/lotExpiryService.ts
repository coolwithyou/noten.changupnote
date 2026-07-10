// 만료(expiry) 처리 서비스 (설계 5.4). 일일 cron 이 부른다.
//
//   status=active AND expires_at < now() AND remaining > 0 인 lot 마다
//     applyLedgerEntry(expiry, -remaining, key=expiry:{lotId}, lotSelection={targetLotIds:[lotId]})
//     → lot status=expired
//
// ★ 반드시 targetLotIds 모드(레드팀 M1) — consume_order 로 흘리면 만료 대상이 아닌 다른 lot 을 깎아
//   I2·I5 가 붕괴한다. applyLedgerEntryTx 가 targetLotIds 차감 후 remaining 0 이면 status=exhausted 로
//   두므로, 여기서 만료분은 명시적으로 status='expired' 로 덮는다(만료·소진 사유 구분).
//
// ★ pending hold 가 있는 지갑은 이번 회차 스킵(5.4) — capture 만료 유예(레드팀 M8)와 경합하지 않기 위함.
//   다음 회차(24h 뒤)에 hold 정리 후 만료해도 손해 없다.
//
// 시스템 경로지만 원장 변이가 있으므로 각 지갑의 userId 로 withCunoteDbUser 컨텍스트를 세팅해
// 단일 진입점(applyLedgerEntryTx)을 경유한다(4.13 / 5.2. refund·plan_grant 와 동일 패턴).
import { sql } from "drizzle-orm";
import { idempotencyKeys } from "@cunote/core";
import type { CunoteDb } from "@/lib/server/db/client";
import { withCunoteDbUser } from "@/lib/server/db/client";
import { applyLedgerEntryTx } from "@/lib/server/repositories/creditRepository";

export interface ExpireLotsResult {
  lotsExpired: number;
  creditsExpired: number;
  walletsSkippedForPendingHold: number;
  errors: number;
}

interface ExpirableLotRow {
  lot_id: string;
  wallet_id: string;
  user_id: string;
  remaining: string;
  [key: string]: unknown;
}

/**
 * 만료 대상 lot 을 소멸시킨다. 각 lot 당 expiry 분개 1건(targetLotIds) + lot status=expired.
 * @param limit 한 회차 처리 상한(cron 타임아웃 방어).
 */
export async function expireLots(db: CunoteDb, now: Date, limit = 1000): Promise<ExpireLotsResult> {
  // 만료 대상 lot + 소유 지갑·user. ★ pending hold 가 있는 지갑은 제외(5.4 스킵).
  const rows = await db.execute<ExpirableLotRow>(sql`
    SELECT lt.id AS lot_id, lt.wallet_id, w.user_id, lt.remaining_credits::text AS remaining
    FROM credit_lots lt
    JOIN credit_wallets w ON w.id = lt.wallet_id
    WHERE lt.status = 'active'
      AND lt.expires_at IS NOT NULL
      AND lt.expires_at < ${now.toISOString()}::timestamptz
      AND lt.remaining_credits > 0
      AND NOT EXISTS (
        SELECT 1 FROM credit_holds h WHERE h.wallet_id = lt.wallet_id AND h.status = 'pending'
      )
    ORDER BY lt.expires_at ASC
    LIMIT ${limit}
  `);

  // 스킵된(pending hold 보유) 지갑 수 — 관찰용.
  const skippedRows = await db.execute<{ value: string }>(sql`
    SELECT COUNT(DISTINCT lt.wallet_id)::text AS value
    FROM credit_lots lt
    WHERE lt.status = 'active'
      AND lt.expires_at IS NOT NULL
      AND lt.expires_at < ${now.toISOString()}::timestamptz
      AND lt.remaining_credits > 0
      AND EXISTS (
        SELECT 1 FROM credit_holds h WHERE h.wallet_id = lt.wallet_id AND h.status = 'pending'
      )
  `);

  const result: ExpireLotsResult = {
    lotsExpired: 0,
    creditsExpired: 0,
    walletsSkippedForPendingHold: Number(skippedRows[0]?.value ?? "0"),
    errors: 0,
  };

  for (const row of rows) {
    const remaining = Number(row.remaining);
    if (remaining <= 0) continue;
    try {
      await withCunoteDbUser(db, row.user_id, async (tx) => {
        // expiry 분개: 반드시 targetLotIds(레드팀 M1). key=expiry:{lotId} 로 재실행 멱등.
        const entry = await applyLedgerEntryTx(
          tx,
          {
            walletId: row.wallet_id,
            entryType: "expiry",
            amountCredits: -remaining,
            idempotencyKey: idempotencyKeys.expiry(row.lot_id),
            lotSelection: { targetLotIds: [row.lot_id] },
            actorType: "system",
            actorId: "system:expire-lots-cron",
            reason: "lot expired",
          },
          () => now,
        );
        // applyLedgerEntryTx 가 멱등으로 기존 분개를 반환하면 재실행 — 이미 처리된 lot 이므로 상태만 확정.
        // 만료분 lot 은 exhausted 가 아니라 expired 로 마감(사유 구분).
        await tx.execute(sql`
          UPDATE credit_lots
          SET status = 'expired', updated_at = ${now.toISOString()}::timestamptz
          WHERE id = ${row.lot_id}::uuid AND status IN ('active', 'exhausted')
        `);
        // effectiveAmount(shortfall 클램프 반영)로 실제 소멸량 집계.
        result.creditsExpired += -entry.amountCredits;
      });
      result.lotsExpired += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
