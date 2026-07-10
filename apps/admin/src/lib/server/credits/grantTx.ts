/**
 * 관리자 지급/차감 트랜잭션 순수 헬퍼.
 *
 * adjust / adjust-approve / goodwill 라우트가 공통으로 재사용한다.
 * 실제 트랜잭션 집행(lot INSERT/UPDATE, ledger append-only INSERT, wallet 잔액 갱신)을
 * postgres.js TransactionSql 안에서 수행한다. 감사 로그(insertCreditAuditLog)는
 * 호출측이 트랜잭션 커밋 후 별도로 남긴다(auditLog 헬퍼는 getAdminSql를 쓰므로 tx 밖).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md (4.3 멱등 키·chainHash, 5.2 lot 배분)
 */

import type { TransactionSql } from "postgres";
import {
  computeChainHash,
  genesisHash,
  sortLotsForConsumption,
  allocateFromLots,
  type AllocatableLot,
} from "@cunote/core";

const LEDGER_GRANT_ENTRY_TYPES = new Set(["admin_grant", "promo_grant"]);
const LOT_GRANT_SOURCES = new Set(["admin_grant", "promo"]);

export interface AdminGrantInput {
  /** 지급 대상 회원 userId. */
  userId: string;
  /** 지급 크레딧(양의 정수). */
  credits: number;
  /** 지급 사유(ledger.reason, lot.note에 기록). */
  reason: string;
  /** 만료일수(없으면 무기한). */
  expiryDays?: number | null;
  /** 멱등 nonce(폼 최초 렌더 시 생성). idempotency_key = `admin:${nonce}`. */
  nonce: string;
  /** 지급 관리자 id(actor_id, granted_by_admin_id). */
  actorId: string;
  /** ledger entry_type. 기본 admin_grant. goodwill은 promo_grant. */
  entryType?: "admin_grant" | "promo_grant";
  /** credit_lots.source. 기본 admin_grant. goodwill은 promo. */
  lotSource?: "admin_grant" | "promo";
}

export interface GrantResult {
  entryId: string;
  balanceAfter: number;
  amountCredits: number;
  idempotent: boolean;
  /** 멱등 히트가 아닐 때 생성된 lot id. */
  lotId?: string;
}

export interface AdminDeductInput {
  userId: string;
  /** 차감 요청 크레딧(양의 정수). 실제 차감은 잔액에 클램프된다. */
  credits: number;
  reason: string;
  nonce: string;
  actorId: string;
}

export interface DeductResult {
  entryId: string;
  balanceAfter: number;
  amountCredits: number;
  idempotent: boolean;
  /** 실제 차감된 크레딧(양수). */
  actualDeduct: number;
}

interface WalletRow {
  id: string;
  balance_credits: number;
  status: string;
}

/** 지갑을 FOR UPDATE 로 잠근다. 없으면 throw. */
async function lockWallet(tx: TransactionSql, userId: string): Promise<WalletRow> {
  const rows = await tx<WalletRow[]>`
    SELECT id, balance_credits, status
    FROM credit_wallets
    WHERE user_id = ${userId}
    FOR UPDATE
  `;
  const wallet = rows[0];
  if (!wallet) throw new Error("지갑을 찾을 수 없습니다.");
  return wallet;
}

/** 지갑의 최신 chainHash(prev). 없으면 genesis. */
async function readPrevChainHash(tx: TransactionSql, walletId: string): Promise<string> {
  const rows = await tx<{ chain_hash: string | null }[]>`
    SELECT chain_hash FROM credit_ledger
    WHERE wallet_id = ${walletId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0]?.chain_hash ?? genesisHash(walletId);
}

/**
 * 관리자 지급(양수 분개). admin_grant 또는 promo_grant.
 * lot 1개 생성 + ledger append + wallet 잔액 증가. nonce로 멱등.
 */
export async function applyAdminGrant(
  tx: TransactionSql,
  input: AdminGrantInput,
): Promise<GrantResult> {
  const entryType = input.entryType ?? "admin_grant";
  const lotSource = input.lotSource ?? "admin_grant";
  if (!LEDGER_GRANT_ENTRY_TYPES.has(entryType)) {
    throw new Error(`지급 분개 유형이 올바르지 않습니다: ${entryType}`);
  }
  if (!LOT_GRANT_SOURCES.has(lotSource)) {
    throw new Error(`lot source가 올바르지 않습니다: ${lotSource}`);
  }
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new Error("지급 크레딧은 양의 정수여야 합니다.");
  }

  const wallet = await lockWallet(tx, input.userId);
  const walletId = wallet.id;
  const idemKey = `admin:${input.nonce}`;

  // promo_grant(goodwill)는 frozen 지갑에 지급 불가. admin_grant·admin_deduct는 예외 허용.
  if (wallet.status === "frozen" && entryType === "promo_grant") {
    throw Object.assign(new Error("지갑이 동결 상태입니다. goodwill 지급이 불가합니다."), {
      code: "wallet_frozen",
    });
  }

  const existingRows = await tx<{ id: string; balance_after: number; amount_credits: number }[]>`
    SELECT id, balance_after, amount_credits
    FROM credit_ledger
    WHERE idempotency_key = ${idemKey}
    LIMIT 1
  `;
  const existing = existingRows[0];
  if (existing) {
    return {
      entryId: existing.id,
      balanceAfter: Number(existing.balance_after),
      amountCredits: Number(existing.amount_credits),
      idempotent: true,
    };
  }

  const balBefore = Number(wallet.balance_credits);
  const now = new Date();
  const lotId = crypto.randomUUID();
  const expiresAt =
    input.expiryDays != null ? new Date(now.getTime() + input.expiryDays * 86_400_000) : null;

  await tx`
    INSERT INTO credit_lots
      (id, wallet_id, source, initial_credits, remaining_credits, expires_at,
       status, granted_by_admin_id, note, created_at, updated_at)
    VALUES
      (${lotId}, ${walletId}, ${lotSource}, ${input.credits}, ${input.credits}, ${expiresAt},
       'active', ${input.actorId}, ${input.reason}, ${now}, ${now})
  `;

  const lotBreakdown = [{ lotId, amount: input.credits }];
  const balanceAfter = balBefore + input.credits;
  const amountCredits = input.credits;
  const entryId = crypto.randomUUID();

  const prevChainHash = await readPrevChainHash(tx, walletId);
  const chainHash = computeChainHash({
    prevChainHash,
    id: entryId,
    walletId,
    entryType,
    amountCredits,
    balanceAfter,
    idempotencyKey: idemKey,
    createdAt: now,
  });

  await tx`
    INSERT INTO credit_ledger
      (id, wallet_id, entry_type, amount_credits, balance_after, lot_breakdown,
       actor_type, actor_id, reason, idempotency_key, chain_hash, created_at)
    VALUES
      (${entryId}, ${walletId}, ${entryType}, ${amountCredits}, ${balanceAfter},
       ${JSON.stringify(lotBreakdown)}::jsonb, 'admin', ${input.actorId}, ${input.reason},
       ${idemKey}, ${chainHash}, ${now})
  `;

  await tx`
    UPDATE credit_wallets
    SET balance_credits = ${balanceAfter}, updated_at = ${now}
    WHERE id = ${walletId}
  `;

  return { entryId, balanceAfter, amountCredits, idempotent: false, lotId };
}

/**
 * 관리자 차감(음수 분개). admin_deduct.
 * active + remaining>0 lot에서 소진순으로 배분·차감 + ledger append + wallet 잔액 감소.
 * 잔액 0이면 호출측이 사전 차단해야 하나, 여기서도 actualDeduct=0이면 throw.
 */
export async function applyAdminDeduct(
  tx: TransactionSql,
  input: AdminDeductInput,
): Promise<DeductResult> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new Error("차감 크레딧은 양의 정수여야 합니다.");
  }

  const wallet = await lockWallet(tx, input.userId);
  const walletId = wallet.id;
  const idemKey = `admin:${input.nonce}`;

  const existingRows = await tx<{ id: string; balance_after: number; amount_credits: number }[]>`
    SELECT id, balance_after, amount_credits
    FROM credit_ledger
    WHERE idempotency_key = ${idemKey}
    LIMIT 1
  `;
  const existing = existingRows[0];
  if (existing) {
    const amt = Number(existing.amount_credits);
    return {
      entryId: existing.id,
      balanceAfter: Number(existing.balance_after),
      amountCredits: amt,
      idempotent: true,
      actualDeduct: Math.abs(amt),
    };
  }

  const balBefore = Number(wallet.balance_credits);
  const now = new Date();

  const activeLots = await tx<
    { id: string; remaining_credits: number; expires_at: Date | null; created_at: Date }[]
  >`
    SELECT id, remaining_credits, expires_at, created_at
    FROM credit_lots
    WHERE wallet_id = ${walletId}
      AND status = 'active'
      AND remaining_credits > 0
      AND (expires_at IS NULL OR expires_at > now())
    FOR UPDATE
  `;
  const sorted = sortLotsForConsumption(
    activeLots.map<AllocatableLot>((l) => ({
      id: l.id,
      remainingCredits: Number(l.remaining_credits),
      expiresAt: l.expires_at,
      createdAt: l.created_at,
    })),
  );
  const alloc = allocateFromLots(sorted, input.credits);
  const actualDeduct = alloc.allocated;

  if (actualDeduct <= 0) {
    // amount_credits=0 금지. 차감할 잔액이 없다.
    throw new Error("차감할 잔액이 없습니다.");
  }

  for (const line of alloc.lines) {
    await tx`
      UPDATE credit_lots
      SET remaining_credits = remaining_credits - ${line.amount},
          status = CASE WHEN remaining_credits - ${line.amount} <= 0 THEN 'exhausted' ELSE status END,
          updated_at = ${now}
      WHERE id = ${line.lotId}
    `;
  }

  const lotBreakdown = alloc.lines;
  const balanceAfter = Math.max(0, balBefore - actualDeduct);
  const amountCredits = -(balBefore - balanceAfter);
  const entryId = crypto.randomUUID();
  const entryType = "admin_deduct";

  const prevChainHash = await readPrevChainHash(tx, walletId);
  const chainHash = computeChainHash({
    prevChainHash,
    id: entryId,
    walletId,
    entryType,
    amountCredits,
    balanceAfter,
    idempotencyKey: idemKey,
    createdAt: now,
  });

  await tx`
    INSERT INTO credit_ledger
      (id, wallet_id, entry_type, amount_credits, balance_after, lot_breakdown,
       actor_type, actor_id, reason, idempotency_key, chain_hash, created_at)
    VALUES
      (${entryId}, ${walletId}, ${entryType}, ${amountCredits}, ${balanceAfter},
       ${JSON.stringify(lotBreakdown)}::jsonb, 'admin', ${input.actorId}, ${input.reason},
       ${idemKey}, ${chainHash}, ${now})
  `;

  await tx`
    UPDATE credit_wallets
    SET balance_credits = ${balanceAfter}, updated_at = ${now}
    WHERE id = ${walletId}
  `;

  return { entryId, balanceAfter, amountCredits, idempotent: false, actualDeduct };
}
