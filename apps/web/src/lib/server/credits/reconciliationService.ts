/**
 * 크레딧 일일 대사 서비스 (설계 14.1 / 14.3).
 *
 * 5 scope 를 각각 실행해 결과를 반환한다. 실제 기록(credit_reconciliation_runs INSERT + recon.mismatch
 * audit_log)은 runReconciliation 이 트랜잭션 밖에서 수행한다. 이 모듈은 ★ 읽기 + recon_runs INSERT +
 * audit INSERT 만 한다 — wallet/lot/ledger 원장 변이는 절대 하지 않는다(대사는 관찰자).
 *
 * scope (임의 변경 금지 — task 규범):
 *   1 ledger_wallet   I1(Σledger=balance) + chainHash 체인 재계산(I9/I10, 삭제·수정·삽입 변조 탐지)
 *   2 lot_ledger      I2(Σactive lot=balance) + I5(lot 소비량 = 참조 음수 분개 배분)
 *   3 holds           TTL 누락 pending, captured-미정산, ★ released/expired 인데 usage 에 선기록 토큰(6.2 d-2)
 *                     있고 분개 없는 "서비스 제공 후 미정산" 후보(B3 안전망)
 *   4 portone_orders  최근 48h 주문 ↔ 포트원 GET /payments 대조. ★ 주문 테이블에 없는 결제 = 고아 최우선 경보.
 *                     포트원 클라이언트 미주입(키 미설정) 시 이 scope 만 error 로 기록하고 나머지는 진행.
 *   5 admin_activity  기간 내 admin_grant 발행 총량 임계 초과 경보 + capture_after_expiry 빈도 +
 *                     동일 companyId 신규 멤버 급증(13.1 — 초과 시 usage.anomaly audit 기록).
 *
 * 검증 코어는 @cunote/core 의 recomputeWalletChain 을 verify 스크립트(14.2)와 공유한다.
 */

import { sql } from "drizzle-orm";
import {
  recomputeWalletChain,
  RECONCILE_SCOPES,
  type LedgerEntryForChain,
  type ReconcileScope,
  type ReconcileScopeResult,
  type ReconcileStatus,
} from "@cunote/core";
import type { CunoteDb } from "@/lib/server/db/client";
import type { PortoneClient } from "@/lib/server/payments/portone";

/** 대사 실행 옵션. */
export interface ReconcileOptions {
  /** 실행할 scope. 미지정이면 5 scope 전부. 수동 재실행(11.8)에서 특정 scope 만 돌릴 때 사용. */
  scopes?: ReconcileScope[];
  /** 포트원 클라이언트(scope 4). 미주입이면 portone_orders 만 error 기록. */
  portone?: PortoneClient | null;
  /** 실행 시각(테스트 주입). */
  now?: () => Date;
  /** admin_grant 총량 임계(scope 5). settings 미조회 시 기본. */
  adminGrantAlertThreshold?: number;
  /** 동일 companyId 신규 멤버 급증 창(일)·임계(명) (13.1). */
  companyNewMemberWindowDays?: number;
  companyNewMemberThreshold?: number;
}

const DEFAULT_ADMIN_GRANT_THRESHOLD = 50000; // admin_grant_review_threshold 기본(4.7)
const DEFAULT_COMPANY_MEMBER_WINDOW_DAYS = 7; // 13.1
const DEFAULT_COMPANY_MEMBER_THRESHOLD = 5; // 13.1 (7일 내 5인 초과)
const PORTONE_ORDER_WINDOW_MS = 48 * 60 * 60 * 1000; // 최근 48h(14.1 scope 4)

// ── scope 1: ledger_wallet ────────────────────────────────────────────
async function reconcileLedgerWallet(db: CunoteDb): Promise<ReconcileScopeResult> {
  // I1: 지갑별 balance = Σledger.
  const balanceRows = await db.execute<{ id: string; balance: string; ledger_sum: string }>(sql`
    SELECT w.id,
           w.balance_credits::bigint AS balance,
           COALESCE((SELECT SUM(l.amount_credits) FROM credit_ledger l WHERE l.wallet_id = w.id), 0)::bigint AS ledger_sum
    FROM credit_wallets w
  `);

  const i1Mismatches: Array<{ walletId: string; balance: number; ledgerSum: number }> = [];
  for (const r of balanceRows) {
    if (Number(r.balance) !== Number(r.ledger_sum)) {
      i1Mismatches.push({ walletId: r.id, balance: Number(r.balance), ledgerSum: Number(r.ledger_sum) });
    }
  }

  // I9 + I10: chainHash 체인 재계산(공유 코어). 전 지갑 스캔.
  const walletIds = balanceRows.map((r) => r.id);
  const balanceMismatches: Array<{ walletId: string; entryId: string; running: number; balanceAfter: number }> = [];
  const chainMismatches: Array<{ walletId: string; entryId: string }> = [];
  let scannedWallets = 0;
  let scannedEntries = 0;

  for (const walletId of walletIds) {
    const rows = await db.execute<{
      id: string;
      entry_type: string;
      amount: string;
      balance_after: string;
      idempotency_key: string;
      chain_hash: string;
      created_at: string;
    }>(sql`
      SELECT id, entry_type, amount_credits::bigint AS amount, balance_after::bigint AS balance_after,
             idempotency_key, chain_hash, created_at
      FROM credit_ledger
      WHERE wallet_id = ${walletId}
      ORDER BY created_at ASC, id ASC
    `);
    const entries: LedgerEntryForChain[] = rows.map((e) => ({
      id: e.id,
      entryType: e.entry_type,
      amountCredits: Number(e.amount),
      balanceAfter: Number(e.balance_after),
      idempotencyKey: e.idempotency_key,
      chainHash: e.chain_hash,
      createdAt: new Date(e.created_at),
    }));
    const result = recomputeWalletChain(walletId, entries);
    scannedWallets += 1;
    scannedEntries += result.entryCount;
    for (const m of result.balanceMismatches) {
      balanceMismatches.push({ walletId, entryId: m.entryId, running: m.running, balanceAfter: m.balanceAfter });
    }
    for (const m of result.chainMismatches) {
      chainMismatches.push({ walletId, entryId: m.entryId });
    }
  }

  const mismatch = i1Mismatches.length > 0 || balanceMismatches.length > 0 || chainMismatches.length > 0;
  return {
    scope: "ledger_wallet",
    status: mismatch ? "mismatch" : "ok",
    summary: {
      wallets: walletIds.length,
      scannedWallets,
      scannedEntries,
      i1BalanceMismatches: i1Mismatches.slice(0, 50),
      i1MismatchCount: i1Mismatches.length,
      i9BalanceAfterMismatches: balanceMismatches.slice(0, 50),
      i9MismatchCount: balanceMismatches.length,
      i10ChainMismatches: chainMismatches.slice(0, 50),
      i10MismatchCount: chainMismatches.length,
    },
  };
}

// ── scope 2: lot_ledger (I2, I5) ──────────────────────────────────────
async function reconcileLotLedger(db: CunoteDb): Promise<ReconcileScopeResult> {
  // I2: 지갑별 balance = Σ active lot remaining.
  const i2Rows = await db.execute<{ id: string; balance: string; lot_sum: string }>(sql`
    SELECT w.id, w.balance_credits::bigint AS balance,
           COALESCE((SELECT SUM(lt.remaining_credits) FROM credit_lots lt WHERE lt.wallet_id = w.id AND lt.status = 'active'), 0)::bigint AS lot_sum
    FROM credit_wallets w
  `);
  const i2Mismatches: Array<{ walletId: string; balance: number; lotSum: number }> = [];
  for (const r of i2Rows) {
    if (Number(r.balance) !== Number(r.lot_sum)) {
      i2Mismatches.push({ walletId: r.id, balance: Number(r.balance), lotSum: Number(r.lot_sum) });
    }
  }

  // I5: lot 소비량(initial - remaining) = Σ(참조 음수 분개 배분) - Σ(원위치 복원 reversal 배분).
  // verify-credit-invariants.ts I5 와 동일 SQL.
  const i5Rows = await db.execute<{ id: string; consumed: string; allocated: string }>(sql`
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
  `);
  const i5Mismatches: Array<{ lotId: string; consumed: number; allocated: number }> = [];
  for (const r of i5Rows) {
    if (Number(r.consumed) !== Number(r.allocated)) {
      i5Mismatches.push({ lotId: r.id, consumed: Number(r.consumed), allocated: Number(r.allocated) });
    }
  }

  const mismatch = i2Mismatches.length > 0 || i5Mismatches.length > 0;
  return {
    scope: "lot_ledger",
    status: mismatch ? "mismatch" : "ok",
    summary: {
      lots: i5Rows.length,
      i2Mismatches: i2Mismatches.slice(0, 50),
      i2MismatchCount: i2Mismatches.length,
      i5Mismatches: i5Mismatches.slice(0, 50),
      i5MismatchCount: i5Mismatches.length,
    },
  };
}

// ── scope 3: holds ────────────────────────────────────────────────────
async function reconcileHolds(db: CunoteDb): Promise<ReconcileScopeResult> {
  // (a) pending 인데 expires_at 지난 hold(만료 cron 누락 검출).
  const staleRows = await db.execute<{ value: string }>(sql`
    SELECT COUNT(*)::text AS value FROM credit_holds WHERE status = 'pending' AND expires_at < now()
  `);
  const stalePending = Number(staleRows[0]?.value ?? "0");

  // (b) captured 인데 usage_event 가 settled 아닌 것(정합 붕괴).
  const capturedRows = await db.execute<{ id: string; usage_event_id: string; usage_status: string }>(sql`
    SELECT h.id, h.usage_event_id, ue.status AS usage_status
    FROM credit_holds h
    JOIN usage_events ue ON ue.id = h.usage_event_id
    WHERE h.status = 'captured' AND ue.status <> 'settled'
  `);

  // (c) ★ B3 안전망: released/expired hold 인데 usage_event 에 선기록 토큰(6.2 d-2 — input/output_tokens>0)이
  //     있고 usage_capture 분개가 없는 것 = "서비스 제공 후 미정산" 후보. 수동 정산 큐에 리포트.
  const unsettledRows = await db.execute<{
    hold_id: string;
    usage_event_id: string;
    input_tokens: string;
    output_tokens: string;
    feature_code: string;
    wallet_id: string | null;
  }>(sql`
    SELECT h.id AS hold_id, ue.id AS usage_event_id,
           ue.input_tokens::bigint AS input_tokens, ue.output_tokens::bigint AS output_tokens,
           ue.feature_code, ue.wallet_id
    FROM credit_holds h
    JOIN usage_events ue ON ue.id = h.usage_event_id
    WHERE h.status IN ('released', 'expired')
      AND ue.status <> 'settled'
      AND (ue.input_tokens > 0 OR ue.output_tokens > 0)
      AND NOT EXISTS (
        SELECT 1 FROM credit_ledger l WHERE l.usage_event_id = ue.id AND l.entry_type = 'usage_capture'
      )
  `);
  const unsettledWithTokens = unsettledRows.map((r) => ({
    holdId: r.hold_id,
    usageEventId: r.usage_event_id,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    featureCode: r.feature_code,
    walletId: r.wallet_id,
  }));

  const mismatch = stalePending > 0 || capturedRows.length > 0 || unsettledWithTokens.length > 0;
  return {
    scope: "holds",
    status: mismatch ? "mismatch" : "ok",
    summary: {
      stalePendingHolds: stalePending,
      capturedButUnsettled: capturedRows.slice(0, 50),
      capturedButUnsettledCount: capturedRows.length,
      // 수동 정산 큐 후보(B3 안전망).
      unsettledWithPreRecordedTokens: unsettledWithTokens.slice(0, 50),
      unsettledWithPreRecordedTokensCount: unsettledWithTokens.length,
    },
  };
}

// ── scope 4: portone_orders ───────────────────────────────────────────
async function reconcilePortoneOrders(
  db: CunoteDb,
  portone: PortoneClient | null | undefined,
  now: Date,
): Promise<ReconcileScopeResult> {
  if (!portone || !portone.isConfigured()) {
    // 키 미설정 → 이 scope 만 error 로 기록하고 나머지는 진행(task 규범).
    return {
      scope: "portone_orders",
      status: "error",
      summary: {
        error: "portone_not_configured",
        message: "포트원 클라이언트 미설정 — 대조 스킵. PORTONE_API_SECRET·PORTONE_STORE_ID 설정 필요.",
      },
    };
  }

  const since = new Date(now.getTime() - PORTONE_ORDER_WINDOW_MS);
  const orders = await db.execute<{
    id: string;
    payment_id: string;
    status: string;
    amount_krw: string;
    order_type: string;
  }>(sql`
    SELECT id, payment_id, status, amount_krw::text AS amount_krw, order_type
    FROM credit_payment_orders
    WHERE created_at >= ${since.toISOString()}
    ORDER BY created_at DESC
    LIMIT 500
  `);

  const statusMismatches: Array<{ orderId: string; paymentId: string; internal: string; portone: string }> = [];
  const amountMismatches: Array<{ orderId: string; paymentId: string; internalKrw: number; portonePaidKrw: number | null }> = [];
  const lookupErrors: Array<{ orderId: string; paymentId: string; error: string }> = [];
  // ★ 고아 결제 최우선 경보: 포트원에는 PAID 인데 우리 주문 상태가 미결제(created/pending/expired/failed).
  const orphanPaid: Array<{ paymentId: string; internal: string; portone: string }> = [];
  let checked = 0;

  for (const o of orders) {
    let payment: Awaited<ReturnType<PortoneClient["getPayment"]>>;
    try {
      payment = await portone.getPayment(o.payment_id);
    } catch (error) {
      lookupErrors.push({ orderId: o.id, paymentId: o.payment_id, error: error instanceof Error ? error.message : "lookup_failed" });
      continue;
    }
    checked += 1;

    const portoneStatus = payment.status;
    const internalPaid = o.status === "paid";
    const portonePortStatus = portoneStatus === "PAID";

    // 상태 대조: 내부 paid ↔ 포트원 PAID.
    if (internalPaid !== portonePortStatus) {
      statusMismatches.push({ orderId: o.id, paymentId: o.payment_id, internal: o.status, portone: portoneStatus });
      // 포트원 PAID 인데 내부 미결제 = 고아(돈은 나갔는데 우리 장부에 지급 안 됨). 최우선 경보.
      if (portonePortStatus && !internalPaid) {
        orphanPaid.push({ paymentId: o.payment_id, internal: o.status, portone: portoneStatus });
      }
    }

    // 금액 대조: 내부 지급액 ↔ 포트원 결제 금액(paid).
    if (portonePortStatus && payment.amount) {
      const internalKrw = Number(o.amount_krw);
      const portonePaidKrw = payment.amount.paid ?? payment.amount.total;
      if (portonePaidKrw !== internalKrw) {
        amountMismatches.push({ orderId: o.id, paymentId: o.payment_id, internalKrw, portonePaidKrw });
      }
    }
  }

  // pending usage(6.2 부분 실패) 리포트: usage_events 가 pending 인데 hold 가 released/expired.
  const pendingUsageRows = await db.execute<{ value: string }>(sql`
    SELECT COUNT(*)::text AS value
    FROM usage_events ue
    WHERE ue.status = 'pending'
      AND EXISTS (SELECT 1 FROM credit_holds h WHERE h.usage_event_id = ue.id AND h.status IN ('released','expired'))
  `);
  const pendingUsageStuck = Number(pendingUsageRows[0]?.value ?? "0");

  const mismatch =
    statusMismatches.length > 0 || amountMismatches.length > 0 || orphanPaid.length > 0 || pendingUsageStuck > 0;
  return {
    scope: "portone_orders",
    status: mismatch ? "mismatch" : "ok",
    summary: {
      window: "48h",
      ordersScanned: orders.length,
      ordersChecked: checked,
      lookupErrors: lookupErrors.slice(0, 50),
      lookupErrorCount: lookupErrors.length,
      statusMismatches: statusMismatches.slice(0, 50),
      statusMismatchCount: statusMismatches.length,
      amountMismatches: amountMismatches.slice(0, 50),
      amountMismatchCount: amountMismatches.length,
      // 최우선 경보.
      orphanPaid,
      orphanPaidCount: orphanPaid.length,
      pendingUsageStuck,
    },
  };
}

// ── scope 5: admin_activity ───────────────────────────────────────────
async function reconcileAdminActivity(
  db: CunoteDb,
  now: Date,
  opts: Required<Pick<ReconcileOptions, "adminGrantAlertThreshold" | "companyNewMemberWindowDays" | "companyNewMemberThreshold">>,
): Promise<{ result: ReconcileScopeResult; anomalyCompanies: Array<{ companyId: string; newMembers: number }> }> {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  // admin_grant 발행 총량(당일). 임계 초과 시 경보(내부자 통제, M1-보안).
  const grantRows = await db.execute<{ value: string }>(sql`
    SELECT COALESCE(SUM(amount_credits), 0)::text AS value
    FROM credit_ledger
    WHERE entry_type = 'admin_grant' AND created_at >= ${dayStart.toISOString()}
  `);
  const adminGrantToday = Number(grantRows[0]?.value ?? "0");

  // capture_after_expiry 빈도(당일) — hold_ttl 조정 신호.
  const captureLateRows = await db.execute<{ value: string }>(sql`
    SELECT COUNT(*)::text AS value
    FROM credit_audit_logs
    WHERE action = 'usage.capture_after_expiry' AND created_at >= ${dayStart.toISOString()}
  `);
  const captureAfterExpiryToday = Number(captureLateRows[0]?.value ?? "0");

  // 동일 companyId 신규 멤버 급증(13.1) — 창(일) 내 신규 user_company 가 임계 초과인 회사.
  const windowStart = new Date(now.getTime() - opts.companyNewMemberWindowDays * 24 * 60 * 60 * 1000);
  const surgeRows = await db.execute<{ company_id: string; new_members: string }>(sql`
    SELECT company_id, COUNT(*)::text AS new_members
    FROM user_company
    WHERE created_at >= ${windowStart.toISOString()}
    GROUP BY company_id
    HAVING COUNT(*) > ${opts.companyNewMemberThreshold}
    ORDER BY COUNT(*) DESC
    LIMIT 50
  `);
  const anomalyCompanies = surgeRows.map((r) => ({ companyId: r.company_id, newMembers: Number(r.new_members) }));

  const adminGrantAlert = adminGrantToday > opts.adminGrantAlertThreshold;
  const memberSurge = anomalyCompanies.length > 0;
  const mismatch = adminGrantAlert || memberSurge;

  return {
    result: {
      scope: "admin_activity",
      status: mismatch ? "mismatch" : "ok",
      summary: {
        adminGrantToday,
        adminGrantAlertThreshold: opts.adminGrantAlertThreshold,
        adminGrantAlert,
        captureAfterExpiryToday,
        companyNewMemberWindowDays: opts.companyNewMemberWindowDays,
        companyNewMemberThreshold: opts.companyNewMemberThreshold,
        companyMemberSurges: anomalyCompanies,
        companyMemberSurgeCount: anomalyCompanies.length,
      },
    },
    anomalyCompanies,
  };
}

const SCOPE_RUNNERS: Record<ReconcileScope, true> = {
  ledger_wallet: true,
  lot_ledger: true,
  holds: true,
  portone_orders: true,
  admin_activity: true,
};

/**
 * 대사 5 scope(또는 지정 scope)를 실행해 결과를 반환한다. ★ 원장 변이 없음.
 * 호출측(cron/내부 엔드포인트)이 결과를 credit_reconciliation_runs 에 기록하고 mismatch 시 audit 를 남긴다.
 */
export async function runReconciliationScopes(
  db: CunoteDb,
  options: ReconcileOptions = {},
): Promise<{ results: ReconcileScopeResult[]; anomalyCompanies: Array<{ companyId: string; newMembers: number }> }> {
  const now = options.now?.() ?? new Date();
  const requested = options.scopes && options.scopes.length > 0 ? options.scopes : [...RECONCILE_SCOPES];
  const scopes = requested.filter((s): s is ReconcileScope => s in SCOPE_RUNNERS);

  const adminGrantAlertThreshold = options.adminGrantAlertThreshold ?? DEFAULT_ADMIN_GRANT_THRESHOLD;
  const companyNewMemberWindowDays = options.companyNewMemberWindowDays ?? DEFAULT_COMPANY_MEMBER_WINDOW_DAYS;
  const companyNewMemberThreshold = options.companyNewMemberThreshold ?? DEFAULT_COMPANY_MEMBER_THRESHOLD;

  const results: ReconcileScopeResult[] = [];
  let anomalyCompanies: Array<{ companyId: string; newMembers: number }> = [];

  for (const scope of scopes) {
    try {
      if (scope === "ledger_wallet") {
        results.push(await reconcileLedgerWallet(db));
      } else if (scope === "lot_ledger") {
        results.push(await reconcileLotLedger(db));
      } else if (scope === "holds") {
        results.push(await reconcileHolds(db));
      } else if (scope === "portone_orders") {
        results.push(await reconcilePortoneOrders(db, options.portone, now));
      } else if (scope === "admin_activity") {
        const { result, anomalyCompanies: companies } = await reconcileAdminActivity(db, now, {
          adminGrantAlertThreshold,
          companyNewMemberWindowDays,
          companyNewMemberThreshold,
        });
        results.push(result);
        anomalyCompanies = companies;
      }
    } catch (error) {
      results.push({
        scope,
        status: "error",
        summary: { error: error instanceof Error ? error.message : "reconcile_scope_failed" },
      });
    }
  }

  return { results, anomalyCompanies };
}

/**
 * 대사 결과를 기록한다: scope 별 credit_reconciliation_runs INSERT + mismatch 시 recon.mismatch audit +
 * 13.1 회사 멤버 급증 시 usage.anomaly audit. ★ 원장 변이 없음.
 *
 * @param actorId 실행 주체 식별자(cron="system:reconcile-cron", 수동="admin:{id}" 등).
 */
export async function persistReconciliationResults(
  db: CunoteDb,
  input: {
    results: ReconcileScopeResult[];
    anomalyCompanies: Array<{ companyId: string; newMembers: number }>;
    actorId: string;
    runDate?: Date;
  },
): Promise<void> {
  const runDate = input.runDate ?? new Date();

  for (const r of input.results) {
    await db.execute(sql`
      INSERT INTO credit_reconciliation_runs (run_date, scope, status, summary)
      VALUES (${runDate.toISOString()}, ${r.scope}, ${r.status}, ${JSON.stringify(r.summary)}::jsonb)
    `);
    if (r.status === "mismatch") {
      await db.execute(sql`
        INSERT INTO credit_audit_logs (action, actor_type, actor_id, target_type, target_id, after)
        VALUES ('recon.mismatch', 'system', ${input.actorId}, 'reconciliation', ${r.scope},
                ${JSON.stringify({ scope: r.scope, summary: r.summary })}::jsonb)
      `);
    }
  }

  // 13.1: 회사 멤버 급증은 usage.anomaly 로도 기록(11.1 대시보드·CS 추적).
  for (const c of input.anomalyCompanies) {
    await db.execute(sql`
      INSERT INTO credit_audit_logs (action, actor_type, actor_id, target_type, target_id, after)
      VALUES ('usage.anomaly', 'system', ${input.actorId}, 'company', ${c.companyId},
              ${JSON.stringify({ reason: "company_new_member_surge", newMembers: c.newMembers })}::jsonb)
    `);
  }
}

/** cron/내부 엔드포인트가 부르는 단일 진입점: 실행 + 기록. */
export async function runReconciliation(
  db: CunoteDb,
  options: ReconcileOptions & { actorId: string },
): Promise<{ results: ReconcileScopeResult[]; overallStatus: ReconcileStatus }> {
  const { results, anomalyCompanies } = await runReconciliationScopes(db, options);
  await persistReconciliationResults(db, {
    results,
    anomalyCompanies,
    actorId: options.actorId,
    runDate: options.now?.() ?? new Date(),
  });

  const overallStatus: ReconcileStatus = results.some((r) => r.status === "mismatch")
    ? "mismatch"
    : results.some((r) => r.status === "error")
      ? "error"
      : "ok";

  return { results, overallStatus };
}
