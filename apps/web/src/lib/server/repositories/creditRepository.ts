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

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
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
  type CaptureHoldResult,
  type CreditHoldRecord,
  type CreditLedgerEntryRecord,
  type CreditLotRecord,
  type CreditRepository,
  type CreditSystemRepository,
  type CreditWalletRecord,
  type LedgerListRow,
  type LotBreakdownLine,
  type LotSelection,
  type PricingRule,
  type ReversalTargetLot,
  type TokenUsage,
  type UsageListRow,
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

/** hold 설정 폴백(4.7). credit_settings 부재 시 사용. */
const HOLD_TTL_SECONDS_FALLBACK = 600;
const HOLD_BUFFER_RATIO_FALLBACK = 1.2;

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

  // ── 5.3 hold 알고리즘 ────────────────────────────────────────────────

  async acquireHold(
    userId: string,
    input: { walletId: string; usageEventId: string; estimatedCredits: number; excludeBonusLots?: boolean },
  ): Promise<CreditHoldRecord> {
    requireUserId(userId, "acquireHold");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      await assertWalletOwned(tx, input.walletId, userId);
      const at = this.now();

      // 1. 지갑 FOR UPDATE — 직렬화 지점.
      const [wallet] = await tx.execute<{ id: string; balance_credits: number; status: string; frozen_reason: string | null }>(
        sql`SELECT id, balance_credits, status, frozen_reason FROM credit_wallets WHERE id = ${input.walletId} FOR UPDATE`,
      );
      if (!wallet) throw new InvalidLedgerEntryError("지갑을 찾을 수 없습니다.", { walletId: input.walletId });
      // frozen: 신규 hold 차단(4.1).
      if (wallet.status === "frozen") throw new WalletFrozenError(input.walletId, wallet.frozen_reason);

      // 2. Σ pending holds (bigint → Number 캐스팅, 레드팀 m5).
      const [holdSum] = await tx.execute<{ pending: number }>(
        sql`SELECT COALESCE(SUM(held_credits),0)::bigint AS pending FROM credit_holds WHERE wallet_id = ${input.walletId} AND status = 'pending'`,
      );
      const pendingHolds = Number(holdSum?.pending ?? 0);

      let balanceBasis = Number(wallet.balance_credits);
      // 13.1: 보너스 소모 상한 초과 hold 는 signup_bonus lot 잔량을 available 에서 제외한다.
      if (input.excludeBonusLots) {
        const [bonus] = await tx.execute<{ bonus: number }>(
          sql`SELECT COALESCE(SUM(remaining_credits),0)::bigint AS bonus
              FROM credit_lots
              WHERE wallet_id = ${input.walletId} AND status = 'active' AND source = 'signup_bonus'
                AND (expires_at IS NULL OR expires_at > ${at.toISOString()}::timestamptz)`,
        );
        balanceBasis -= Number(bonus?.bonus ?? 0);
      }

      const available = balanceBasis - pendingHolds;
      const bufferRatio = await readNumericSettingTx(tx, "hold_buffer_ratio", HOLD_BUFFER_RATIO_FALLBACK);
      const ttlSeconds = await readNumericSettingTx(tx, "hold_ttl_seconds", HOLD_TTL_SECONDS_FALLBACK);
      const held = Math.ceil(input.estimatedCredits * bufferRatio);

      if (available < held) {
        throw new InsufficientCreditsError({ required: held, available: Math.max(0, available) });
      }

      const expiresAt = new Date(at.getTime() + ttlSeconds * 1000);
      const [row] = await tx
        .insert(schema.creditHolds)
        .values({
          walletId: input.walletId,
          usageEventId: input.usageEventId,
          heldCredits: held,
          status: "pending",
          expiresAt,
          releasedReason: input.excludeBonusLots ? "exclude_bonus" : null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      return toHoldRecord(row!);
    });
  }

  async captureHold(
    userId: string,
    input: { holdId: string; actualCredits: number; pricingSnapshot?: Record<string, unknown> | null; excludeBonusLots?: boolean },
  ): Promise<CaptureHoldResult> {
    requireUserId(userId, "captureHold");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      const at = this.now();
      // 1. hold FOR UPDATE.
      const [hold] = await tx.execute<{
        id: string; wallet_id: string; usage_event_id: string; held_credits: number;
        captured_credits: number | null; status: string; expires_at: Date; released_reason: string | null; created_at: Date;
      }>(sql`SELECT id, wallet_id, usage_event_id, held_credits, captured_credits, status, expires_at, released_reason, created_at
             FROM credit_holds WHERE id = ${input.holdId}::uuid FOR UPDATE`);
      if (!hold) throw new InvalidLedgerEntryError("hold 를 찾을 수 없습니다.", { holdId: input.holdId });
      await assertWalletOwned(tx, hold.wallet_id, userId);

      const holdCreatedAt = new Date(hold.created_at);
      const ttlExpired = new Date(hold.expires_at).getTime() < at.getTime();
      const excludeBonus = input.excludeBonusLots || hold.released_reason === "exclude_bonus";

      // 이미 captured → 멱등 no-op(이미 정산됨).
      if (hold.status === "captured") {
        const captured = Number(hold.captured_credits ?? 0);
        return {
          hold: toHoldRecordRaw(hold),
          creditsCharged: captured,
          shortfall: 0,
          capturedLate: false,
        };
      }

      // 2. 정산 분개(usage:{usageEventId} 멱등). released/expired 여도 진행(레드팀 B3).
      //    lot 만료 유예: expires_at > hold.createdAt(레드팀 M8) → 전용 배분.
      const need = Math.max(0, input.actualCredits);
      let lotBreakdown: LotBreakdownLine[] = [];
      let shortfall = 0;

      // 멱등: usage:{usageEventId} 분개가 이미 있으면 재계산 없이 그 값을 신뢰.
      const idempotencyKey = idempotencyKeys.usage(hold.usage_event_id);
      const [existingEntry] = await tx
        .select({ amountCredits: schema.creditLedger.amountCredits })
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.idempotencyKey, idempotencyKey))
        .limit(1);

      let creditsCharged: number;
      if (existingEntry) {
        creditsCharged = -Number(existingEntry.amountCredits);
      } else {
        // lot 배분(만료 유예 기준시각 = hold.createdAt).
        const { lines, shortfall: sf } = await allocateForCapture(tx, hold.wallet_id, need, holdCreatedAt, excludeBonus);
        lotBreakdown = lines;
        shortfall = sf;
        const effectiveNeed = need - shortfall; // shortfall 클램프(잔액 0). 음수 잔액 금지(4.1).
        creditsCharged = effectiveNeed;

        // lot remaining 차감.
        for (const line of lines) {
          await tx.execute(sql`
            UPDATE credit_lots
            SET remaining_credits = remaining_credits - ${line.amount},
                status = CASE WHEN remaining_credits - ${line.amount} <= 0 THEN 'exhausted'::credit_lot_status ELSE status END,
                updated_at = now()
            WHERE id = ${line.lotId}::uuid
          `);
        }

        if (effectiveNeed > 0) {
          // 분개 INSERT — chainHash 포함. (effectiveNeed=0 이면 분개 없이 정산 완료 처리)
          await insertUsageCaptureEntry(tx, {
            walletId: hold.wallet_id,
            amountCredits: -effectiveNeed,
            lotBreakdown,
            usageEventId: hold.usage_event_id,
            idempotencyKey,
            pricingSnapshot: input.pricingSnapshot ?? null,
            actorId: userId,
            at,
          });
        }
      }

      // shortfall 기록(5.3): usage_events.context_ref.shortfall + audit_log(usage.shortfall).
      if (shortfall > 0) {
        await tx.execute(sql`
          UPDATE usage_events
          SET context_ref = jsonb_set(COALESCE(context_ref,'{}'::jsonb), '{shortfall}', ${String(shortfall)}::jsonb, true),
              updated_at = now()
          WHERE id = ${hold.usage_event_id}::uuid
        `);
        await insertAuditLog(tx, {
          action: "usage.shortfall",
          actorType: "user",
          actorId: userId,
          targetType: "wallet",
          targetId: hold.wallet_id,
          after: { usageEventId: hold.usage_event_id, shortfall, actualCredits: input.actualCredits },
          at,
        });
      }

      // 3. hold UPDATE captured. TTL 경과 정산이면 releasedReason=captured_late 유지(레드팀 B3).
      await tx.execute(sql`
        UPDATE credit_holds
        SET status = 'captured', captured_credits = ${creditsCharged},
            released_reason = ${ttlExpired ? "captured_late" : hold.released_reason},
            updated_at = now()
        WHERE id = ${input.holdId}::uuid
      `);

      // 4. usage_events UPDATE settled, creditsCharged=실차감액. (만료 cron 이 failed 로 바꿨어도 settled 로 복귀)
      await tx.execute(sql`
        UPDATE usage_events
        SET status = 'settled', credits_charged = ${creditsCharged}, error_code = NULL, updated_at = now()
        WHERE id = ${hold.usage_event_id}::uuid
      `);

      // TTL 경과 정산 audit(빈도 관찰용).
      if (ttlExpired) {
        await insertAuditLog(tx, {
          action: "usage.capture_after_expiry",
          actorType: "user",
          actorId: userId,
          targetType: "wallet",
          targetId: hold.wallet_id,
          after: { usageEventId: hold.usage_event_id, holdId: input.holdId },
          at,
        });
      }

      const [fresh] = await tx.execute<{
        id: string; wallet_id: string; usage_event_id: string; held_credits: number;
        captured_credits: number | null; status: string; expires_at: Date; released_reason: string | null; created_at: Date;
      }>(sql`SELECT id, wallet_id, usage_event_id, held_credits, captured_credits, status, expires_at, released_reason, created_at
             FROM credit_holds WHERE id = ${input.holdId}::uuid`);

      return {
        hold: toHoldRecordRaw(fresh!),
        creditsCharged,
        shortfall,
        capturedLate: ttlExpired,
      };
    });
  }

  async releaseHold(userId: string, input: { holdId: string; reason: string }): Promise<CreditHoldRecord> {
    requireUserId(userId, "releaseHold");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      const [hold] = await tx.execute<{
        id: string; wallet_id: string; usage_event_id: string; held_credits: number;
        captured_credits: number | null; status: string; expires_at: Date; released_reason: string | null; created_at: Date;
      }>(sql`SELECT id, wallet_id, usage_event_id, held_credits, captured_credits, status, expires_at, released_reason, created_at
             FROM credit_holds WHERE id = ${input.holdId}::uuid FOR UPDATE`);
      if (!hold) throw new InvalidLedgerEntryError("hold 를 찾을 수 없습니다.", { holdId: input.holdId });
      await assertWalletOwned(tx, hold.wallet_id, userId);
      // 이미 captured 면 no-op — release 가 정산을 되돌리지 않는다(5.3).
      if (hold.status === "captured") return toHoldRecordRaw(hold);
      await tx.execute(sql`
        UPDATE credit_holds SET status = 'released', released_reason = ${input.reason}, updated_at = now()
        WHERE id = ${input.holdId}::uuid AND status = 'pending'
      `);
      const [fresh] = await tx.execute<{
        id: string; wallet_id: string; usage_event_id: string; held_credits: number;
        captured_credits: number | null; status: string; expires_at: Date; released_reason: string | null; created_at: Date;
      }>(sql`SELECT id, wallet_id, usage_event_id, held_credits, captured_credits, status, expires_at, released_reason, created_at
             FROM credit_holds WHERE id = ${input.holdId}::uuid`);
      return toHoldRecordRaw(fresh!);
    });
  }

  // ── 6.2 usage_events 라이프사이클 ─────────────────────────────────────

  async createPendingUsageEvent(
    userId: string,
    input: {
      walletId: string; companyId: string | null; featureCode: string; provider: string;
      model: string | null; pricingRuleId: string | null; requestId: string; contextRef?: Record<string, unknown>;
    },
  ): Promise<{ id: string }> {
    requireUserId(userId, "createPendingUsageEvent");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      await assertWalletOwned(tx, input.walletId, userId);
      const [row] = await tx
        .insert(schema.usageEvents)
        .values({
          walletId: input.walletId,
          userId,
          companyId: input.companyId,
          featureCode: input.featureCode,
          provider: input.provider,
          model: input.model,
          pricingRuleId: input.pricingRuleId,
          status: "pending",
          requestId: input.requestId,
          contextRef: input.contextRef ?? {},
        })
        .returning({ id: schema.usageEvents.id });
      return { id: row!.id };
    });
  }

  async recordUsageTokens(
    userId: string,
    input: { usageEventId: string; usage: TokenUsage; providerCostUsdMicros?: number | null },
  ): Promise<void> {
    requireUserId(userId, "recordUsageTokens");
    await withCunoteDbUser(this.client, userId, async (tx) => {
      await tx.execute(sql`
        UPDATE usage_events
        SET input_tokens = ${input.usage.inputTokens},
            output_tokens = ${input.usage.outputTokens},
            cache_read_tokens = ${input.usage.cacheReadTokens},
            cache_write_tokens = ${input.usage.cacheWriteTokens},
            provider_cost_usd_micros = ${input.providerCostUsdMicros ?? null},
            updated_at = now()
        WHERE id = ${input.usageEventId}::uuid
      `);
    });
  }

  async markUsageEventFailed(userId: string, input: { usageEventId: string; errorCode: string }): Promise<void> {
    requireUserId(userId, "markUsageEventFailed");
    await withCunoteDbUser(this.client, userId, async (tx) => {
      await tx.execute(sql`
        UPDATE usage_events SET status = 'failed', error_code = ${input.errorCode}, updated_at = now()
        WHERE id = ${input.usageEventId}::uuid
      `);
    });
  }

  async sumCompanyBonusConsumption(userId: string, companyId: string): Promise<number> {
    requireUserId(userId, "sumCompanyBonusConsumption");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      // 이 companyId 의 usage_capture 분개들이 signup_bonus lot 에서 깎은 누적량.
      // usage_events.companyId 로 이벤트를 좁히고, 대응 usage_capture 분개의 lotBreakdown 중
      // signup_bonus lot 을 참조하는 라인의 amount 를 합산한다.
      const [row] = await tx.execute<{ consumed: number }>(sql`
        SELECT COALESCE(SUM((elem->>'amount')::bigint),0)::bigint AS consumed
        FROM usage_events ue
        JOIN credit_ledger l ON l.usage_event_id = ue.id AND l.entry_type = 'usage_capture'
        JOIN jsonb_array_elements(l.lot_breakdown) elem ON true
        JOIN credit_lots lt ON lt.id = (elem->>'lotId')::uuid AND lt.source = 'signup_bonus'
        WHERE ue.company_id = ${companyId}::uuid
      `);
      return Number(row?.consumed ?? 0);
    });
  }

  // ── 조회 API (9.1) ───────────────────────────────────────────────────

  async sumPendingHolds(userId: string, walletId: string): Promise<number> {
    requireUserId(userId, "sumPendingHolds");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      await assertWalletOwned(tx, walletId, userId);
      const [row] = await tx.execute<{ pending: number }>(
        sql`SELECT COALESCE(SUM(held_credits),0)::bigint AS pending FROM credit_holds WHERE wallet_id = ${walletId} AND status = 'pending'`,
      );
      return Number(row?.pending ?? 0);
    });
  }

  async listLedgerForUser(
    userId: string,
    input: { walletId: string; limit: number; cursor?: string | null; entryType?: string | null },
  ): Promise<{ entries: LedgerListRow[]; nextCursor: string | null; hasMore: boolean }> {
    requireUserId(userId, "listLedgerForUser");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      await assertWalletOwned(tx, input.walletId, userId);
      const limit = clampLimit(input.limit);
      const cursor = parseCursor(input.cursor);
      const typeClause = input.entryType ? sql`AND entry_type = ${input.entryType}` : sql.raw("");
      const cursorClause = cursor
        ? sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : sql.raw("");
      const rows = await tx.execute<{
        id: string; entry_type: string; amount_credits: number; balance_after: number; reason: string | null; created_at: Date;
      }>(sql`
        SELECT id, entry_type, amount_credits, balance_after, reason, created_at
        FROM credit_ledger
        WHERE wallet_id = ${input.walletId}
          ${typeClause}
          ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const entries: LedgerListRow[] = page.map((r) => ({
        id: r.id,
        entryType: r.entry_type as CreditLedgerEntryRecord["entryType"],
        amountCredits: Number(r.amount_credits),
        balanceAfter: Number(r.balance_after),
        reason: r.reason,
        createdAt: new Date(r.created_at),
      }));
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(new Date(last.created_at), last.id) : null;
      return { entries, nextCursor, hasMore };
    });
  }

  async listUsageForUser(
    userId: string,
    input: { walletId: string; from?: Date | null; to?: Date | null; featureCode?: string | null; limit: number; cursor?: string | null },
  ): Promise<{
    events: UsageListRow[];
    summary: { totalCredits: number; byFeature: Array<{ featureCode: string; credits: number; count: number }> };
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    requireUserId(userId, "listUsageForUser");
    return withCunoteDbUser(this.client, userId, async (tx) => {
      await assertWalletOwned(tx, input.walletId, userId);
      const limit = clampLimit(input.limit);
      const cursor = parseCursor(input.cursor);
      const fromClause = input.from ? sql`AND created_at >= ${input.from.toISOString()}::timestamptz` : sql.raw("");
      const toClause = input.to ? sql`AND created_at <= ${input.to.toISOString()}::timestamptz` : sql.raw("");
      const featureClause = input.featureCode ? sql`AND feature_code = ${input.featureCode}` : sql.raw("");
      const cursorClause = cursor
        ? sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : sql.raw("");

      const rows = await tx.execute<{
        id: string; feature_code: string; credits_charged: number; status: string;
        model: string | null; input_tokens: number; output_tokens: number; context_ref: Record<string, unknown>; created_at: Date;
      }>(sql`
        SELECT id, feature_code, credits_charged, status, model, input_tokens, output_tokens, context_ref, created_at
        FROM usage_events
        WHERE wallet_id = ${input.walletId}
          ${fromClause} ${toClause} ${featureClause}
          ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const events: UsageListRow[] = page.map((r) => ({
        id: r.id,
        featureCode: r.feature_code,
        creditsCharged: Number(r.credits_charged),
        status: r.status as UsageListRow["status"],
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        contextRef: (r.context_ref ?? {}) as Record<string, unknown>,
        createdAt: new Date(r.created_at),
      }));
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(new Date(last.created_at), last.id) : null;

      // 기간 합계(byFeature) — 커서 무관, from/to/feature 필터만 적용.
      const summaryRows = await tx.execute<{ feature_code: string; credits: number; count: number }>(sql`
        SELECT feature_code, COALESCE(SUM(credits_charged),0)::bigint AS credits, COUNT(*)::int AS count
        FROM usage_events
        WHERE wallet_id = ${input.walletId} ${fromClause} ${toClause} ${featureClause}
        GROUP BY feature_code
        ORDER BY credits DESC
      `);
      const byFeature = summaryRows.map((r) => ({
        featureCode: r.feature_code,
        credits: Number(r.credits),
        count: Number(r.count),
      }));
      const totalCredits = byFeature.reduce((s, f) => s + f.credits, 0);
      return { events, summary: { totalCredits, byFeature }, nextCursor, hasMore };
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

  async readNumericSetting(key: string, fallback: number): Promise<number> {
    // 결제·정산 경로는 캐시 무시 직독(4.7). 시스템 신뢰 경로.
    const [row] = await this.client
      .select({ value: schema.creditSettings.value })
      .from(schema.creditSettings)
      .where(eq(schema.creditSettings.key, key))
      .limit(1);
    return readNumericSetting(row?.value, fallback);
  }

  async recordOpsUsageEvent(input: {
    featureCode: string;
    provider: string;
    model: string | null;
    usage: TokenUsage | null;
    providerCostUsdMicros?: number | null;
    requestId?: string | null;
    contextRef?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    // 운영 배치·무과금 미터링(walletId=null, user 컨텍스트 없음). 시스템 경로(4.13).
    const [row] = await this.client
      .insert(schema.usageEvents)
      .values({
        walletId: null,
        userId: null,
        companyId: null,
        featureCode: input.featureCode,
        provider: input.provider,
        model: input.model,
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
        providerCostUsdMicros: input.providerCostUsdMicros ?? null,
        status: "free",
        creditsCharged: 0,
        requestId: input.requestId ?? null,
        contextRef: input.contextRef ?? {},
      })
      .returning({ id: schema.usageEvents.id });
    return { id: row!.id };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 트랜잭션 내부 집행 (5.2). tx 는 이미 withCunoteDbUser 로 user 컨텍스트가 세팅된 세션.
// ─────────────────────────────────────────────────────────────────────────────

export async function applyLedgerEntryTx(
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
        AND (expires_at IS NULL OR expires_at > ${at.toISOString()}::timestamptz)
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

// ── hold/capture 헬퍼 (5.3) ────────────────────────────────────────────

/** 지갑 소유 검증(user 컨텍스트). 타인 지갑 조작 차단. */
async function assertWalletOwned(tx: CunoteDbSession, walletId: string, userId: string): Promise<void> {
  const [owned] = await tx
    .select({ id: schema.creditWallets.id })
    .from(schema.creditWallets)
    .where(and(eq(schema.creditWallets.id, walletId), eq(schema.creditWallets.userId, userId)))
    .limit(1);
  if (!owned) {
    throw new InvalidLedgerEntryError("본인 지갑이 아니거나 지갑이 없습니다.", { walletId });
  }
}

/** tx 내 settings 직독(4.7 — 정산 경로는 캐시 무시). */
async function readNumericSettingTx(tx: CunoteDbSession, key: string, fallback: number): Promise<number> {
  const [row] = await tx
    .select({ value: schema.creditSettings.value })
    .from(schema.creditSettings)
    .where(eq(schema.creditSettings.key, key))
    .limit(1);
  return readNumericSetting(row?.value, fallback);
}

/**
 * capture 차감의 lot 배분(5.3): 만료 유예 필터 = expires_at > hold.createdAt(레드팀 M8).
 * hold 시점에 살아있던 lot 은 capture 시점에 만료됐어도 소진 가능.
 * excludeBonus(13.1) 이면 signup_bonus lot 을 배분에서 제외한다.
 */
async function allocateForCapture(
  tx: CunoteDbSession,
  walletId: string,
  need: number,
  holdCreatedAt: Date,
  excludeBonus: boolean,
): Promise<{ lines: LotBreakdownLine[]; shortfall: number }> {
  if (need <= 0) return { lines: [], shortfall: 0 };
  const graceCutoff = holdCreatedAt.toISOString();
  const rows = excludeBonus
    ? await tx.execute<{
        id: string; remaining_credits: number; expires_at: Date | null; created_at: Date; source: string;
      }>(sql`
        SELECT id, remaining_credits, expires_at, created_at, source
        FROM credit_lots
        WHERE wallet_id = ${walletId} AND status = 'active' AND remaining_credits > 0
          AND (expires_at IS NULL OR expires_at > ${graceCutoff}::timestamptz)
          AND source <> 'signup_bonus'
        ORDER BY expires_at ASC NULLS LAST, created_at ASC
        FOR UPDATE
      `)
    : await tx.execute<{
        id: string; remaining_credits: number; expires_at: Date | null; created_at: Date; source: string;
      }>(sql`
        SELECT id, remaining_credits, expires_at, created_at, source
        FROM credit_lots
        WHERE wallet_id = ${walletId} AND status = 'active' AND remaining_credits > 0
          AND (expires_at IS NULL OR expires_at > ${graceCutoff}::timestamptz)
        ORDER BY expires_at ASC NULLS LAST, created_at ASC
        FOR UPDATE
      `);
  const lots: AllocatableLot[] = rows.map((r) => ({
    id: r.id,
    remainingCredits: Number(r.remaining_credits),
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    createdAt: new Date(r.created_at),
  }));
  const { lines, shortfall } = allocateFromLots(sortLotsForConsumption(lots), need);
  return { lines, shortfall };
}

/** usage_capture 분개 INSERT(chainHash 포함) + 지갑 balance 갱신. capture 전용(5.3). */
async function insertUsageCaptureEntry(
  tx: CunoteDbSession,
  input: {
    walletId: string;
    amountCredits: number; // 음수
    lotBreakdown: LotBreakdownLine[];
    usageEventId: string;
    idempotencyKey: string;
    pricingSnapshot: Record<string, unknown> | null;
    actorId: string;
    at: Date;
  },
): Promise<void> {
  const [wallet] = await tx.execute<{ balance_credits: number }>(
    sql`SELECT balance_credits FROM credit_wallets WHERE id = ${input.walletId} FOR UPDATE`,
  );
  const balanceBefore = Number(wallet!.balance_credits);
  const balanceAfter = balanceBefore + input.amountCredits;
  if (balanceAfter < 0) {
    throw new InvalidLedgerEntryError("잔액이 음수가 될 수 없습니다.", { balanceBefore, amount: input.amountCredits });
  }

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
    entryType: "usage_capture",
    amountCredits: input.amountCredits,
    balanceAfter,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.at,
  });

  try {
    await tx.insert(schema.creditLedger).values({
      id: entryId,
      walletId: input.walletId,
      entryType: "usage_capture",
      amountCredits: input.amountCredits,
      balanceAfter,
      lotBreakdown: input.lotBreakdown,
      usageEventId: input.usageEventId,
      pricingSnapshot: input.pricingSnapshot,
      actorType: "user",
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      chainHash,
      createdAt: input.at,
    });
  } catch (error) {
    // 동시 중복(usage 키 충돌) → 이미 정산됨. 이 경우 lot 차감을 방금 이중으로 했으므로 롤백을 위해 rethrow.
    // (호출측 tx 가 롤백된다 — 멱등 경쟁은 상위에서 existingEntry 조회로 걸러진다.)
    if (isUniqueViolation(error)) {
      throw new InvalidLedgerEntryError("정산 분개가 이미 존재합니다(멱등 경쟁).", { idempotencyKey: input.idempotencyKey });
    }
    throw error;
  }

  await tx
    .update(schema.creditWallets)
    .set({ balanceCredits: balanceAfter, updatedAt: input.at })
    .where(eq(schema.creditWallets.id, input.walletId));
}

/** credit_audit_logs INSERT(12.2). system/user 경로 공용. */
export async function insertAuditLog(
  tx: CunoteDbSession,
  input: {
    action: string;
    actorType: "user" | "admin" | "system";
    actorId: string | null;
    targetType: string;
    targetId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
    at: Date;
  },
): Promise<void> {
  await tx.insert(schema.creditAuditLogs).values({
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    targetType: input.targetType,
    targetId: input.targetId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    createdAt: input.at,
  });
}

function toHoldRecord(row: typeof schema.creditHolds.$inferSelect): CreditHoldRecord {
  return {
    id: row.id,
    walletId: row.walletId,
    usageEventId: row.usageEventId,
    heldCredits: row.heldCredits,
    capturedCredits: row.capturedCredits,
    status: row.status,
    expiresAt: row.expiresAt,
    releasedReason: row.releasedReason,
    createdAt: row.createdAt,
  };
}

/** raw SQL 결과(snake_case)를 CreditHoldRecord 로. */
function toHoldRecordRaw(row: {
  id: string; wallet_id: string; usage_event_id: string; held_credits: number;
  captured_credits: number | null; status: string; expires_at: Date; released_reason: string | null; created_at: Date;
}): CreditHoldRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    usageEventId: row.usage_event_id,
    heldCredits: Number(row.held_credits),
    capturedCredits: row.captured_credits === null ? null : Number(row.captured_credits),
    status: row.status as CreditHoldRecord["status"],
    expiresAt: new Date(row.expires_at),
    releasedReason: row.released_reason,
    createdAt: new Date(row.created_at),
  };
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

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

/** 커서 = base64("{ISO createdAt}|{id}"). (created_at, id) 복합 키 기반 keyset 페이지네이션. */
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

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
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
