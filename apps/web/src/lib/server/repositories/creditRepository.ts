/**
 * 크레딧 리포지토리 — Drizzle 트랜잭션 집행.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 5.2 applyLedgerEntry 단일 진입점 (지갑 FOR UPDATE 직렬화, 멱등, lot 배분)
 *   - 6.6 ensureWalletWithSignupBonus (lazy grant, key=signup:{userId})
 *   - 4.13 코드 레벨 통제(1선): user 컨텍스트 없는 경로에서 크레딧 테이블 접근 시 런타임 예외.
 *     이 리포지토리의 모든 user 진입점은 withCunoteDbUser 경유만 허용한다.
 *     시스템 경로(익명 미터링·요율 조회)는 CreditSystemRepository 로 명시 분리.
 *   - 4.3 chainHash 체인(지갑별). append-only 트리거는 DB 가 강제.
 *
 * ★ 규범: 이 파일과 core 의 ledger/pricing 외의 경로로 wallet/lot/ledger 를 만들지 않는다.
 */

import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  CreditContextRequiredError,
  InsufficientCreditsError,
  InvalidLedgerEntryError,
  WalletFrozenError,
  allocateFromLots,
  allocateFromTargetLots,
  computeChainHash,
  genesisHash,
  grantLotBreakdown,
  idempotencyKeys,
  planReversalRestore,
  sortLotsForConsumption,
  type AllocatableLot,
  type ApplyLedgerEntryInput,
  type CreditLedgerEntryRecord,
  type CreditLotRecord,
  type CreditRepository,
  type CreditSystemRepository,
  type CreditWalletRecord,
  type LotBreakdownLine,
  type LotSelection,
  type PricingRule,
  type ReversalTargetLot,
} from "@cunote/core";
import type { CunoteDb, CunoteDbSession } from "@/lib/server/db/client";
import { withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

// 지급(양수) 분개 유형: lot 생성이 동반된다.
const GRANT_ENTRY_TYPES = new Set([
  "signup_bonus_grant",
  "purchase_grant",
  "plan_grant",
  "admin_grant",
  "promo_grant",
]);

// freeze 예외 허용 목록 (4.1 frozen 의미론 / 5.2). 신규 hold·checkout·지급은 차단하되 아래는 허용.
const FROZEN_ALLOWED_ENTRY_TYPES = new Set([
  "usage_capture",
  "refund_deduct",
  "admin_grant",
  "admin_deduct",
  "reversal",
]);

interface CreditRepoDeps {
  client: CunoteDb;
  now?: () => Date;
}

/** 가입 보너스량·만료 기본값. 시드된 credit_settings 를 신뢰 경로로 읽어 override 가능하되,
 *  P1 안전망: 설정 부재 시 4.7 초기값으로 폴백. */
const SIGNUP_BONUS_FALLBACK = { credits: 1000, expiryDays: 90 };

export class DrizzleCreditRepository implements CreditRepository {
  private readonly client: CunoteDb;
  private readonly now: () => Date;

  constructor(deps: CreditRepoDeps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
  }

  // ── 6.6 lazy grant ───────────────────────────────────────────────────
  async ensureWalletWithSignupBonus(userId: string): Promise<CreditWalletRecord> {
    requireUserId(userId, "ensureWalletWithSignupBonus");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      // 설정(가입 보너스량/만료)은 시스템 신뢰 경로 — 같은 tx 에서 직독(RLS 차단 테이블이나 BYPASSRLS 통과).
      const bonus = await readSignupBonusSettings(tx);
      const wallet = await ensureWalletRow(tx, userId, this.now());
      // 멱등: signup:{userId} 분개가 이미 있으면 no-op.
      await applyLedgerEntryTx(tx, {
        walletId: wallet.id,
        entryType: "signup_bonus_grant",
        amountCredits: bonus.credits,
        idempotencyKey: idempotencyKeys.signup(userId),
        actorType: "system",
        actorId: "system:signup-bonus",
        reason: "가입 보너스 지급",
        grantLot: {
          source: "signup_bonus",
          expiresAt: addDays(this.now(), bonus.expiryDays),
        },
      }, this.now);
      const fresh = await selectWalletById(tx, wallet.id);
      return toWalletRecord(fresh);
    });
  }

  async getWalletForUser(userId: string): Promise<CreditWalletRecord | null> {
    requireUserId(userId, "getWalletForUser");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.creditWallets)
        .where(eq(schema.creditWallets.userId, userId))
        .limit(1);
      return row ? toWalletRecord(row) : null;
    });
  }

  async listActiveLotsForUser(userId: string): Promise<CreditLotRecord[]> {
    requireUserId(userId, "listActiveLotsForUser");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      const [wallet] = await tx
        .select({ id: schema.creditWallets.id })
        .from(schema.creditWallets)
        .where(eq(schema.creditWallets.userId, userId))
        .limit(1);
      if (!wallet) return [];
      const rows = await tx
        .select()
        .from(schema.creditLots)
        .where(and(eq(schema.creditLots.walletId, wallet.id), eq(schema.creditLots.status, "active")));
      const sorted = sortLotsForConsumption(
        rows.map((r) => ({ id: r.id, remainingCredits: r.remainingCredits, expiresAt: r.expiresAt, createdAt: r.createdAt })),
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return sorted.map((s) => toLotRecord(byId.get(s.id)!));
    });
  }

  async applyLedgerEntry(userId: string, input: ApplyLedgerEntryInput): Promise<CreditLedgerEntryRecord> {
    requireUserId(userId, "applyLedgerEntry");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      // 지갑 소유 검증(user 컨텍스트) — 타인 지갑 대상 분개 차단.
      const [owned] = await tx
        .select({ id: schema.creditWallets.id })
        .from(schema.creditWallets)
        .where(and(eq(schema.creditWallets.id, input.walletId), eq(schema.creditWallets.userId, userId)))
        .limit(1);
      if (!owned) {
        throw new InvalidLedgerEntryError("본인 지갑이 아니거나 지갑이 없습니다.", { walletId: input.walletId });
      }
      return applyLedgerEntryTx(tx, input, this.now);
    });
  }
}

/**
 * 크레딧 시스템 경로(4.13 예외): 웹훅·cron·익명 미터링. user 컨텍스트 없이 신뢰 서버가 호출.
 * 이름으로 시스템 경로임을 명시해 감사 가능하게 한다.
 */
export class DrizzleCreditSystemRepository implements CreditSystemRepository {
  private readonly client: CunoteDb;
  private readonly now: () => Date;

  constructor(deps: CreditRepoDeps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
  }

  async recordFreeUsageEvent(input: {
    walletId: string | null;
    userId: string | null;
    companyId: string | null;
    featureCode: string;
    provider: string | null;
    model?: string | null;
    contextRef?: Record<string, unknown>;
    requestId?: string | null;
  }): Promise<{ id: string }> {
    // 시스템 경로: user 컨텍스트를 세팅하지 않는다(익명 랜딩 포함). walletId=null 허용.
    const [row] = await this.client
      .insert(schema.usageEvents)
      .values({
        walletId: input.walletId,
        userId: input.userId,
        companyId: input.companyId,
        featureCode: input.featureCode,
        provider: input.provider,
        model: input.model ?? null,
        status: "free",
        creditsCharged: 0,
        requestId: input.requestId ?? null,
        contextRef: input.contextRef ?? {},
      })
      .returning({ id: schema.usageEvents.id });
    return { id: row!.id };
  }

  async listEffectivePricingRules(at: Date): Promise<PricingRule[]> {
    // 요율은 RLS 차단 테이블 — 시스템 신뢰 경로에서만 조회.
    const rows = await this.client
      .select()
      .from(schema.creditPricingRules)
      .where(
        and(
          sql`${schema.creditPricingRules.effectiveFrom} <= ${at}`,
          or(isNull(schema.creditPricingRules.effectiveUntil), sql`${schema.creditPricingRules.effectiveUntil} > ${at}`),
        ),
      );
    return rows.map(toPricingRule);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 트랜잭션 내부 집행 (5.2). tx 는 이미 withCunoteDbUser 로 user 컨텍스트가 세팅된 세션.
// ─────────────────────────────────────────────────────────────────────────────

async function applyLedgerEntryTx(
  tx: CunoteDbSession,
  input: ApplyLedgerEntryInput,
  now: () => Date,
): Promise<CreditLedgerEntryRecord> {
  if (input.amountCredits === 0) {
    throw new InvalidLedgerEntryError("분개 금액은 0일 수 없습니다.");
  }
  const at = now();

  // 1. 지갑 FOR UPDATE — 직렬화 지점.
  const [wallet] = await tx.execute<{
    id: string; balance_credits: number; status: string; frozen_reason: string | null;
  }>(sql`SELECT id, balance_credits, status, frozen_reason FROM credit_wallets WHERE id = ${input.walletId} FOR UPDATE`);
  if (!wallet) throw new InvalidLedgerEntryError("지갑을 찾을 수 없습니다.", { walletId: input.walletId });

  // frozen 게이트 (4.1 / 5.2 예외 목록).
  if (wallet.status === "frozen" && !FROZEN_ALLOWED_ENTRY_TYPES.has(input.entryType)) {
    throw new WalletFrozenError(input.walletId, wallet.frozen_reason);
  }

  // 2. 멱등 체크.
  const [existing] = await tx
    .select()
    .from(schema.creditLedger)
    .where(eq(schema.creditLedger.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) return toLedgerRecord(existing);

  const isReversal = input.entryType === "reversal";
  const isGrant = input.amountCredits > 0;

  // 부호-유형 정합 (금액 0은 위에서 이미 차단).
  // reversal 은 양/음 모두 허용(4.3) 하므로 이 체크에서 제외한다. reversal 은 원분개 참조·reason 을 별도 강제.
  if (!isReversal && isGrant !== GRANT_ENTRY_TYPES.has(input.entryType)) {
    // 지급 유형은 양수, 나머지 비-reversal 유형은 음수여야 한다.
    throw new InvalidLedgerEntryError("분개 유형과 금액 부호가 일치하지 않습니다.", {
      entryType: input.entryType, amountCredits: input.amountCredits,
    });
  }

  // reversal 앱 레벨 강제(4.3): 원분개 참조 필수 + 존재 검증 + reason 필수.
  let originalEntry: { id: string; amountCredits: number; lotBreakdown: LotBreakdownLine[] } | null = null;
  if (isReversal) {
    if (!input.reversalOfEntryId) {
      throw new InvalidLedgerEntryError("reversal 분개에는 reversalOfEntryId 가 필요합니다.");
    }
    if (!input.reason || input.reason.trim() === "") {
      throw new InvalidLedgerEntryError("reversal 분개에는 reason 이 필요합니다.");
    }
    const [orig] = await tx
      .select({
        id: schema.creditLedger.id,
        walletId: schema.creditLedger.walletId,
        amountCredits: schema.creditLedger.amountCredits,
        lotBreakdown: schema.creditLedger.lotBreakdown,
      })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.id, input.reversalOfEntryId))
      .limit(1);
    if (!orig || orig.walletId !== input.walletId) {
      throw new InvalidLedgerEntryError("정정 대상 원분개를 찾을 수 없습니다.", {
        reversalOfEntryId: input.reversalOfEntryId, walletId: input.walletId,
      });
    }
    originalEntry = {
      id: orig.id,
      amountCredits: Number(orig.amountCredits),
      lotBreakdown: (orig.lotBreakdown ?? []) as LotBreakdownLine[],
    };
  }

  const balanceBefore = Number(wallet.balance_credits);
  let lotBreakdown: LotBreakdownLine[];
  let effectiveAmount = input.amountCredits; // shortfall 클램프 후 실차감 반영(음수 분개)

  if (isReversal && isGrant) {
    // 3-d. 음수 분개의 reversal(양수): 원분개 lot 에 remaining 복원(4.3, 레드팀 M5).
    lotBreakdown = await restoreLotsForReversal(tx, input.walletId, originalEntry!, input.amountCredits, at);
  } else if (isGrant) {
    // 3-a. 지급: lot 생성.
    if (!input.grantLot) {
      throw new InvalidLedgerEntryError("지급 분개에는 grantLot 이 필요합니다.", { entryType: input.entryType });
    }
    const [lot] = await tx
      .insert(schema.creditLots)
      .values({
        walletId: input.walletId,
        source: input.grantLot.source,
        initialCredits: input.amountCredits,
        remainingCredits: input.amountCredits,
        expiresAt: input.grantLot.expiresAt,
        status: "active",
        paymentOrderId: input.grantLot.paymentOrderId ?? null,
        planSubscriptionId: input.grantLot.planSubscriptionId ?? null,
        grantedByAdminId: input.grantLot.grantedByAdminId ?? null,
        note: input.grantLot.note ?? null,
      })
      .returning({ id: schema.creditLots.id });
    lotBreakdown = grantLotBreakdown(lot!.id, input.amountCredits);
  } else {
    // 3-b/3-c. 차감: lot 배분.
    const need = -input.amountCredits;
    const selection: LotSelection = input.lotSelection ?? "consume_order";
    const { lines, shortfall } = await allocateForDeduction(tx, input.walletId, need, selection, at);
    if (shortfall > 0) {
      if (selection === "consume_order") {
        // usage_capture 등은 잔액 0 클램프(5.3). 그 외(부족 시 거부)는 InsufficientCreditsError.
        if (input.entryType === "usage_capture") {
          effectiveAmount = -(need - shortfall);
        } else {
          throw new InsufficientCreditsError({ required: need, available: need - shortfall });
        }
      } else {
        // targetLotIds 부족: expiry/refund/reversal 은 회수 가능분만 처리(콘솔 취소 shortfall 등).
        effectiveAmount = -(need - shortfall);
      }
    }
    lotBreakdown = lines;
    // lot remaining 차감.
    for (const line of lines) {
      await tx.execute(sql`
        UPDATE credit_lots
        SET remaining_credits = remaining_credits - ${line.amount},
            status = CASE WHEN remaining_credits - ${line.amount} <= 0 THEN 'exhausted'::credit_lot_status ELSE status END,
            updated_at = now()
        WHERE id = ${line.lotId}
      `);
    }
  }

  const balanceAfter = balanceBefore + effectiveAmount;
  if (balanceAfter < 0) {
    throw new InvalidLedgerEntryError("잔액이 음수가 될 수 없습니다.", { balanceBefore, effectiveAmount });
  }

  // 4. 분개 INSERT — chainHash 계산 포함. 지갑별 직전 분개 조회(이 tx 가 지갑을 lock 중).
  const [prev] = await tx
    .select({ chainHash: schema.creditLedger.chainHash })
    .from(schema.creditLedger)
    .where(eq(schema.creditLedger.walletId, input.walletId))
    .orderBy(desc(schema.creditLedger.createdAt), desc(schema.creditLedger.id))
    .limit(1);
  const prevChainHash = prev?.chainHash ?? genesisHash(input.walletId);

  const entryId = crypto.randomUUID();
  const chainHash = computeChainHash({
    prevChainHash,
    id: entryId,
    walletId: input.walletId,
    entryType: input.entryType,
    amountCredits: effectiveAmount,
    balanceAfter,
    idempotencyKey: input.idempotencyKey,
    createdAt: at,
  });

  let inserted: typeof schema.creditLedger.$inferSelect;
  try {
    const [row] = await tx
      .insert(schema.creditLedger)
      .values({
        id: entryId,
        walletId: input.walletId,
        entryType: input.entryType,
        amountCredits: effectiveAmount,
        balanceAfter,
        lotBreakdown,
        usageEventId: input.usageEventId ?? null,
        paymentOrderId: input.paymentOrderId ?? null,
        reversalOfEntryId: input.reversalOfEntryId ?? null,
        pricingSnapshot: input.pricingSnapshot ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
        chainHash,
        createdAt: at,
      })
      .returning();
    inserted = row!;
  } catch (error) {
    // 동시 중복(unique idempotency 충돌) → no-op 성공(5.2). 기존 분개 반환.
    if (isUniqueViolation(error)) {
      const [again] = await tx
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (again) return toLedgerRecord(again);
    }
    throw error;
  }

  // 5. 지갑 balance 갱신.
  await tx
    .update(schema.creditWallets)
    .set({ balanceCredits: balanceAfter, updatedAt: at })
    .where(eq(schema.creditWallets.id, input.walletId));

  return toLedgerRecord(inserted);
}

/** 차감 배분: consume_order(만료·상태 필터) 또는 targetLotIds(필터 없음). */
async function allocateForDeduction(
  tx: CunoteDbSession,
  walletId: string,
  need: number,
  selection: LotSelection,
  at: Date,
): Promise<{ lines: LotBreakdownLine[]; shortfall: number }> {
  if (selection === "consume_order") {
    const rows = await tx.execute<{
      id: string; remaining_credits: number; expires_at: Date | null; created_at: Date;
    }>(sql`
      SELECT id, remaining_credits, expires_at, created_at
      FROM credit_lots
      WHERE wallet_id = ${walletId} AND status = 'active' AND remaining_credits > 0
        AND (expires_at IS NULL OR expires_at > ${at})
      ORDER BY expires_at ASC NULLS LAST, created_at ASC
      FOR UPDATE
    `);
    const lots: AllocatableLot[] = rows.map((r) => ({
      id: r.id, remainingCredits: Number(r.remaining_credits),
      expiresAt: r.expires_at ? new Date(r.expires_at) : null, createdAt: new Date(r.created_at),
    }));
    const { lines, shortfall } = allocateFromLots(sortLotsForConsumption(lots), need);
    return { lines, shortfall };
  }

  // targetLotIds: 지정 lot 만 FOR UPDATE, 만료·상태 필터 없음(5.2 3-c).
  const ids = selection.targetLotIds;
  if (ids.length === 0) return { lines: [], shortfall: need };
  const rows = await tx.execute<{
    id: string; remaining_credits: number; expires_at: Date | null; created_at: Date;
  }>(sql`
    SELECT id, remaining_credits, expires_at, created_at
    FROM credit_lots
    WHERE id = ANY(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`})
    FOR UPDATE
  `);
  // 지정 순서 보존.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: AllocatableLot[] = ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({
      id: r.id, remainingCredits: Number(r.remaining_credits),
      expiresAt: r.expires_at ? new Date(r.expires_at) : null, createdAt: new Date(r.created_at),
    }));
  const { lines, shortfall } = allocateFromTargetLots(ordered, need);
  return { lines, shortfall };
}

/**
 * 음수 분개의 reversal(양수): 원분개 lotBreakdown 의 lot 들에 remaining 을 복원한다(4.3, 레드팀 M5).
 * - active/exhausted lot: remaining 원위치 복원(exhausted→active). remaining <= initial CHECK 준수.
 * - expired/revoked(또는 조회 불가) lot: 동일 source·만료 조건의 대체 lot 신규 생성.
 * 반환 lotBreakdown 은 실제 복원/생성된 lot 기준(I3/I5 유지). 양수 reversal 은 지급 계열이 아니므로 I4 대상 아님.
 */
async function restoreLotsForReversal(
  tx: CunoteDbSession,
  walletId: string,
  originalEntry: { id: string; amountCredits: number; lotBreakdown: LotBreakdownLine[] },
  reversalAmount: number,
  at: Date,
): Promise<LotBreakdownLine[]> {
  // 원분개는 음수(차감) 분개여야 한다. 양수 원분개의 reversal 은 음수 amount 이므로 이 경로로 오지 않는다.
  if (originalEntry.amountCredits >= 0) {
    throw new InvalidLedgerEntryError("양수 reversal 의 원분개는 차감(음수) 분개여야 합니다.", {
      reversalOfEntryId: originalEntry.id, originalAmount: originalEntry.amountCredits,
    });
  }
  // 복원 총액은 원분개 차감액과 같아야 한다.
  const originalDeducted = -originalEntry.amountCredits;
  if (reversalAmount !== originalDeducted) {
    throw new InvalidLedgerEntryError("reversal 금액이 원분개 차감액과 일치하지 않습니다.", {
      reversalAmount, originalDeducted,
    });
  }

  const lotIds = originalEntry.lotBreakdown.map((l) => l.lotId);
  const currentLots = new Map<string, ReversalTargetLot>();
  // 대체 lot 생성 시 source·만료를 승계하기 위한 원 lot 상세.
  const lotDetail = new Map<string, { source: string; expiresAt: Date | null }>();
  if (lotIds.length > 0) {
    const rows = await tx.execute<{
      id: string; remaining_credits: number; initial_credits: number;
      status: string; source: string; expires_at: Date | null;
    }>(sql`
      SELECT id, remaining_credits, initial_credits, status, source, expires_at
      FROM credit_lots
      WHERE id = ANY(${sql`ARRAY[${sql.join(lotIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})
      FOR UPDATE
    `);
    for (const r of rows) {
      currentLots.set(r.id, {
        id: r.id,
        remainingCredits: Number(r.remaining_credits),
        initialCredits: Number(r.initial_credits),
        status: r.status as ReversalTargetLot["status"],
      });
      lotDetail.set(r.id, {
        source: r.source,
        expiresAt: r.expires_at ? new Date(r.expires_at) : null,
      });
    }
  }

  const plan = planReversalRestore(originalEntry.lotBreakdown, currentLots);
  const breakdown: LotBreakdownLine[] = [];

  for (const action of plan.actions) {
    if (action.kind === "restore") {
      await tx.execute(sql`
        UPDATE credit_lots
        SET remaining_credits = remaining_credits + ${action.amount},
            status = CASE WHEN status = 'exhausted'::credit_lot_status THEN 'active'::credit_lot_status ELSE status END,
            updated_at = now()
        WHERE id = ${action.lotId}::uuid
      `);
      breakdown.push({ lotId: action.lotId, amount: action.amount });
    } else {
      // expired/revoked → 동일 source·만료 조건 대체 lot 신규 생성. source/만료는 원 lot 승계.
      const detail = lotDetail.get(action.replacesLotId);
      const [created] = await tx
        .insert(schema.creditLots)
        .values({
          walletId,
          source: (detail?.source ?? "admin_grant") as typeof schema.creditLots.$inferInsert.source,
          initialCredits: action.amount,
          remainingCredits: action.amount,
          expiresAt: detail?.expiresAt ?? null,
          status: "active",
          note: `reversal 대체 lot (원 lot ${action.replacesLotId} 이 만료/회수됨)`,
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: schema.creditLots.id });
      breakdown.push({ lotId: created!.id, amount: action.amount });
    }
  }
  return breakdown;
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────

async function ensureWalletRow(tx: CunoteDbSession, userId: string, at: Date) {
  const [existing] = await tx
    .select()
    .from(schema.creditWallets)
    .where(eq(schema.creditWallets.userId, userId))
    .limit(1);
  if (existing) return existing;
  try {
    const [created] = await tx
      .insert(schema.creditWallets)
      .values({ userId, balanceCredits: 0, status: "active", createdAt: at, updatedAt: at })
      .returning();
    return created!;
  } catch (error) {
    // 경쟁 삽입(unique user_idx) → 재조회.
    if (isUniqueViolation(error)) {
      const [again] = await tx
        .select()
        .from(schema.creditWallets)
        .where(eq(schema.creditWallets.userId, userId))
        .limit(1);
      if (again) return again;
    }
    throw error;
  }
}

async function selectWalletById(tx: CunoteDbSession, walletId: string) {
  const [row] = await tx
    .select()
    .from(schema.creditWallets)
    .where(eq(schema.creditWallets.id, walletId))
    .limit(1);
  return row!;
}

async function readSignupBonusSettings(tx: CunoteDbSession): Promise<{ credits: number; expiryDays: number }> {
  const rows = await tx
    .select()
    .from(schema.creditSettings)
    .where(
      or(
        eq(schema.creditSettings.key, "signup_bonus_credits"),
        eq(schema.creditSettings.key, "signup_bonus_expiry_days"),
      ),
    );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const credits = readNumericSetting(map.get("signup_bonus_credits"), SIGNUP_BONUS_FALLBACK.credits);
  const expiryDays = readNumericSetting(map.get("signup_bonus_expiry_days"), SIGNUP_BONUS_FALLBACK.expiryDays);
  return { credits, expiryDays };
}

function readNumericSetting(value: unknown, fallback: number): number {
  if (value && typeof value === "object" && "value" in value) {
    const v = (value as { value: unknown }).value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return fallback;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function requireUserId(userId: string | undefined | null, operation: string): asserts userId is string {
  if (!userId || typeof userId !== "string") {
    throw new CreditContextRequiredError(operation);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

// ── 매핑 ──────────────────────────────────────────────────────────────

function toWalletRecord(row: typeof schema.creditWallets.$inferSelect): CreditWalletRecord {
  return {
    id: row.id,
    userId: row.userId,
    balanceCredits: row.balanceCredits,
    status: row.status === "frozen" ? "frozen" : "active",
    frozenReason: row.frozenReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLotRecord(row: typeof schema.creditLots.$inferSelect): CreditLotRecord {
  return {
    id: row.id,
    walletId: row.walletId,
    source: row.source,
    initialCredits: row.initialCredits,
    remainingCredits: row.remainingCredits,
    expiresAt: row.expiresAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function toLedgerRecord(row: typeof schema.creditLedger.$inferSelect): CreditLedgerEntryRecord {
  return {
    id: row.id,
    walletId: row.walletId,
    entryType: row.entryType,
    amountCredits: row.amountCredits,
    balanceAfter: row.balanceAfter,
    lotBreakdown: (row.lotBreakdown ?? []) as LotBreakdownLine[],
    idempotencyKey: row.idempotencyKey,
    chainHash: row.chainHash,
    actorType: row.actorType,
    actorId: row.actorId,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function toPricingRule(row: typeof schema.creditPricingRules.$inferSelect): PricingRule {
  return {
    id: row.id,
    ruleType: row.ruleType as PricingRule["ruleType"],
    featureCode: row.featureCode,
    model: row.model,
    inputMillicreditsPer1k: row.inputMillicreditsPer1k,
    outputMillicreditsPer1k: row.outputMillicreditsPer1k,
    cacheReadMillicreditsPer1k: row.cacheReadMillicreditsPer1k,
    cacheWriteMillicreditsPer1k: row.cacheWriteMillicreditsPer1k,
    flatCredits: row.flatCredits,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
  };
}
