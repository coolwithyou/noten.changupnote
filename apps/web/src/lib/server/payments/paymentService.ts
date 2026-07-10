/**
 * 결제 검증·지급 오케스트레이션 (설계 7.2 verifyAndGrant / 7.4 환불 동기화).
 *
 * ★ verifyAndGrant 는 세션 없는 내부 함수다(웹훅과 공유). balance 는 세션 검증을 통과한
 *   경로(checkout/complete 라우트)만 반환한다(레드팀 M2). 이 서비스는 balance 를 포함해
 *   반환하되, 세션 없는 웹훅/cron 호출자는 그 값을 클라이언트로 흘리지 않는다.
 *
 * ★ 상태 가드(레드팀 M2): paid/refunded/partial_refunded → no-op 현재 상태.
 *   created/pending/expired → 검증 진행(expired→paid 지연 구제 허용).
 *   READY/PENDING/VIRTUAL_ACCOUNT_ISSUED → "대기"(절대 failed 로 만들지 않는다).
 *   금액·통화 불일치 → failed + audit(payment.mismatch) + mismatch 결과(라우트가 409).
 */
import {
  calculateRefund,
  type CreditPaymentRepository,
  type CreditSystemRepository,
  type CreditOrderRecord,
  type OrderLotSnapshot,
  type RefundCalcResult,
  type RefundLotSnapshot,
} from "@cunote/core";
import type { PortoneClient } from "./portone";

export type VerifyAndGrantOutcome =
  | { kind: "granted"; grantedCredits: number; balance: number; status: "paid" }
  | { kind: "already"; status: CreditOrderRecord["status"]; grantedCredits: number; balance: number | null }
  | { kind: "pending"; status: "pending" }
  | { kind: "failed"; status: "failed"; reason: string }
  | { kind: "mismatch"; status: "failed" }
  | { kind: "unknown_order" };

const PURCHASE_EXPIRY_DAYS_FALLBACK = 1825; // 5년(4.7).

export interface VerifyAndGrantDeps {
  payment: CreditPaymentRepository;
  system: CreditSystemRepository;
  portone: PortoneClient;
  now?: () => Date;
}

/**
 * 7.2 verifyAndGrant. 세션 없는 내부 함수.
 * @param paymentId 포트원 paymentId(=cnord_...).
 */
export async function verifyAndGrant(
  paymentId: string,
  deps: VerifyAndGrantDeps,
): Promise<VerifyAndGrantOutcome> {
  const now = deps.now?.() ?? new Date();

  // 1. 주문 조회(없으면 unknown_order — "우리가 모르는 결제" 경보 대상).
  const order = await deps.payment.getOrderByPaymentId(paymentId);
  if (!order) return { kind: "unknown_order" };

  // 0. 상태 가드(레드팀 M2). 확정 상태는 no-op 로 현재 상태 반환.
  if (order.status === "paid" || order.status === "refunded" || order.status === "partial_refunded") {
    return {
      kind: "already",
      status: order.status,
      grantedCredits: order.creditsToGrant,
      balance: null, // 재조회 없이 상태만. 라우트가 필요하면 balance 를 별도 조회한다.
    };
  }
  // created/pending/expired → 검증 진행(expired→paid 지연 구제 허용).

  // 2. 진실은 항상 GET /payments/{id} 재조회.
  const payment = await deps.portone.getPayment(paymentId);

  // 3. 상태별 분기.
  switch (payment.status) {
    case "PAID": {
      // 대조: 금액·통화. 서버 API 는 접두 없는 "KRW".
      const total = payment.amount?.total ?? -1;
      if (total !== order.amountKrw || payment.currency !== "KRW") {
        await deps.payment.markOrderMismatch({
          orderId: order.id,
          portoneStatus: payment.status,
          detail: {
            expectedAmount: order.amountKrw,
            actualAmount: total,
            expectedCurrency: "KRW",
            actualCurrency: payment.currency,
          },
        });
        return { kind: "mismatch", status: "failed" };
      }
      // 지급(멱등 purchase:{orderId}).
      const expiryDays = await deps.system.readNumericSetting(
        "purchase_expiry_days",
        PURCHASE_EXPIRY_DAYS_FALLBACK,
      );
      const lotExpiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
      const result = await deps.payment.grantPurchaseForOrder({
        orderId: order.id,
        portone: {
          status: payment.status,
          txId: payment.transactionId,
          payMethod: payment.payMethod,
        },
        lotExpiresAt,
      });
      return {
        kind: "granted",
        grantedCredits: result.grantedCredits,
        balance: result.balance,
        status: "paid",
      };
    }
    case "READY":
    case "PENDING":
    case "VIRTUAL_ACCOUNT_ISSUED":
      // 결제 대기 — 절대 failed 로 만들지 않는다.
      return { kind: "pending", status: "pending" };
    case "FAILED": {
      const reason = payment.failureReason ?? "결제 실패";
      await deps.payment.markOrderFailed({ orderId: order.id, reason, portoneStatus: payment.status });
      return { kind: "failed", status: "failed", reason };
    }
    case "CANCELLED":
    case "PARTIAL_CANCELLED":
      // 7.4 환불 동기화로 위임(웹훅 경로에서 syncRefundFromPortone 호출).
      return { kind: "already", status: order.status, grantedCredits: order.creditsToGrant, balance: null };
    default:
      return { kind: "pending", status: "pending" };
  }
}

export interface RefundSyncOutcome {
  kind: "synced" | "noop" | "unknown_order";
  recovered?: number;
  shortfall?: number;
  frozen?: boolean;
}

/**
 * 7.4 콘솔 발 취소(Transaction.Cancelled/PartialCancelled 웹훅) 동기화.
 *
 * 포트원 콘솔에서 직접 취소하면 우리 정책 검사를 우회한 채 돈이 먼저 나간다. 이 함수는
 * 진실(GET /payments)을 재조회해 취소된 금액만큼의 크레딧을 주문 lot 에서 회수한다.
 *   - 회수 크레딧 = 취소 원화 / krwPerCreditSnapshot (스냅샷 환율).
 *   - 회수는 반드시 targetLotIds(레드팀 M1). 회수 가능분만(shortfall 허용).
 *   - shortfall 시 지갑 자동 frozen + refund.shortfall audit(리포지토리가 처리).
 *   - 멱등: refund:{orderId}:{cancellationId} 키(같은 취소 웹훅 재전송에 안전).
 */
export async function syncRefundFromPortone(
  paymentId: string,
  deps: VerifyAndGrantDeps,
): Promise<RefundSyncOutcome> {
  const order = await deps.payment.getOrderByPaymentId(paymentId);
  if (!order) return { kind: "unknown_order" };

  const payment = await deps.portone.getPayment(paymentId);
  // SUCCEEDED 취소만 처리(REQUESTED 는 대기 — 이후 웹훅/조회에서 확정).
  const succeeded = payment.cancellations.filter((c) => c.status === "SUCCEEDED");
  if (succeeded.length === 0) return { kind: "noop" };

  // 아직 우리 원장에 반영되지 않은 취소만(멱등 키는 리포지토리가 최종 방어).
  // 취소 총액과 전액 여부.
  const cancelledKrw = succeeded.reduce((s, c) => s + (c.totalAmount ?? 0), 0);
  const fullRefund = payment.status === "CANCELLED" || cancelledKrw >= order.amountKrw;

  const krwPerCredit = order.krwPerCreditSnapshot > 0 ? order.krwPerCreditSnapshot : 1;
  // 회수할 크레딧(취소 원화의 크레딧 환산). 잔여 부족 시 리포지토리가 회수 가능분만 회수.
  const recoverCredits = Math.ceil(cancelledKrw / krwPerCredit);

  // 회수 대상 lot(이 주문이 지급한 유료 lot). targetLotIds 강제.
  const lots = await deps.payment.getOrderLots(order.id);
  const targetLotIds = lots.filter((l) => l.source === "purchase" || l.source === "plan_grant").map((l) => l.lotId);

  // 최신 취소 id 를 멱등 키에 사용(콘솔 취소는 보통 1건).
  const cancellationId = succeeded[succeeded.length - 1]!.id;

  const result = await deps.payment.syncRefundForOrder({
    orderId: order.id,
    cancellationId,
    targetLotIds,
    recoverCredits,
    refundedAmountKrw: cancelledKrw,
    fullRefund,
    reason: "console_cancel_sync",
  });
  return { kind: "synced", ...result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 환불 미리보기·실행 (7.4 executeRefund — admin 발)
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 주문의 환불 정책을 계산한다(실행 없음 — 11.5 "서버가 계산해 표시").
 *
 * lot.source 검사로 purchase(및 plan_grant)만 대상(레드팀 M1). 보너스는 주문의 product.bonusCredits
 * 를 유료 lot 에 귀속시켜 원금/보너스를 분리한다(충전분). plan_grant 는 보너스 개념이 없어 0.
 */
export interface RefundPreview {
  kind: "preview" | "unknown_order" | "not_refundable_status";
  order?: {
    id: string;
    orderType: CreditOrderRecord["orderType"];
    amountKrw: number;
    status: CreditOrderRecord["status"];
    paidAt: Date | null;
  };
  calc?: RefundCalcResult;
  reason?: string;
}

export async function previewRefund(
  orderId: string,
  deps: VerifyAndGrantDeps,
): Promise<RefundPreview> {
  const now = deps.now?.() ?? new Date();
  const order = await deps.payment.getOrderById(orderId);
  if (!order) return { kind: "unknown_order" };

  // paid / partial_refunded 만 환불 가능(created/pending/failed/expired/refunded 는 대상 아님).
  if (order.status !== "paid" && order.status !== "partial_refunded") {
    return {
      kind: "not_refundable_status",
      order: toOrderSummary(order),
      reason: `환불 가능한 주문 상태가 아닙니다(현재: ${order.status}).`,
    };
  }

  const calc = await computeRefundCalc(order, now, deps);
  return { kind: "preview", order: toOrderSummary(order), calc };
}

export type ExecuteRefundOutcome =
  | { kind: "unknown_order" }
  | { kind: "not_refundable_status"; status: CreditOrderRecord["status"] }
  | { kind: "not_refundable"; reason: string }
  | {
      kind: "executed";
      cancellation: { id: string; status: string; totalAmount: number | null };
      recovered: number;
      shortfall: number;
      frozen: boolean;
      refundKrw: number;
      refundKind: RefundCalcResult["kind"];
    }
  | {
      kind: "pending";
      cancellation: { id: string; status: string };
      refundKrw: number;
      refundKind: RefundCalcResult["kind"];
    }
  | { kind: "failed"; reason: string };

export interface ExecuteRefundDeps extends VerifyAndGrantDeps {
  /** 감사 로그 actorId(admin_users.id 또는 system). refund.executed/failed audit 에 기록. */
  actorId: string;
  /** actorType — admin 발이면 "admin", cron/시스템이면 "system". */
  actorType?: "admin" | "system";
}

/**
 * 7.4 executeRefund. admin 발 환불 실행(금액은 서버가 정책으로 계산, admin 은 사유·승인만).
 *   1. 주문·lot 검증 + 정책 계산(previewRefund 와 동일).
 *   2. portone.cancelPayment(Idempotency-Key: refund:{orderId}:{n차}).
 *   3. cancellation.status:
 *      - SUCCEEDED → 트랜잭션(refund_deduct targetLotIds + lot revoke + order refunded/partial_refunded)
 *                    + refund.executed audit. 멱등(refund:{orderId}:{cancellationId}).
 *      - REQUESTED(비동기) → 대기(분개 없음 — cancellationId 확정 전). 이후 Transaction.Cancelled 웹훅이
 *                    syncRefundFromPortone 로 완결(멱등 키 refund:{orderId}:{cancellationId} 로 합류).
 *      - FAILED → refund.failed audit + 오류 반환.
 */
export async function executeRefund(
  orderId: string,
  input: { reason: string },
  deps: ExecuteRefundDeps,
): Promise<ExecuteRefundOutcome> {
  const now = deps.now?.() ?? new Date();
  const actorType = deps.actorType ?? "admin";

  const order = await deps.payment.getOrderById(orderId);
  if (!order) return { kind: "unknown_order" };
  if (order.status !== "paid" && order.status !== "partial_refunded") {
    return { kind: "not_refundable_status", status: order.status };
  }

  const calc = await computeRefundCalc(order, now, deps);
  if (!calc.refundable || calc.refundKrw <= 0) {
    return { kind: "not_refundable", reason: calc.reason };
  }

  // 멱등 키 n차 = 이 주문의 지금까지 취소 시도 회차. 부분환불 누적 방어(refund:{orderId}:{n차}).
  // refundedAmountKrw>0 이면 이미 1차 부분환불이 있었음 → 2차.
  const attemptNo = order.refundedAmountKrw > 0 ? 2 : 1;
  const cancelIdempotencyKey = `refund:${order.id}:${attemptNo}`;

  const { cancellation } = await deps.portone.cancelPayment({
    paymentId: order.paymentId,
    amount: calc.refundKrw,
    reason: input.reason,
    idempotencyKey: cancelIdempotencyKey,
  });

  const fullRefund = calc.refundKrw + order.refundedAmountKrw >= order.amountKrw;

  if (cancellation.status === "SUCCEEDED") {
    const result = await deps.payment.executeRefundForOrder({
      orderId: order.id,
      cancellationId: cancellation.id,
      targetLotIds: calc.targetLotIds,
      recoverCredits: calc.recoverCredits,
      refundedAmountKrw: calc.refundKrw,
      fullRefund,
      reason: input.reason,
      actorId: deps.actorId,
      actorType,
    });
    return {
      kind: "executed",
      cancellation: { id: cancellation.id, status: cancellation.status, totalAmount: cancellation.totalAmount },
      recovered: result.recovered,
      shortfall: result.shortfall,
      frozen: result.frozen,
      refundKrw: calc.refundKrw,
      refundKind: calc.kind,
    };
  }

  if (cancellation.status === "REQUESTED") {
    // 비동기 — 분개하지 않는다(cancellationId 확정 전). Transaction.Cancelled 웹훅이 완결.
    return {
      kind: "pending",
      cancellation: { id: cancellation.id, status: cancellation.status },
      refundKrw: calc.refundKrw,
      refundKind: calc.kind,
    };
  }

  // FAILED(및 그 외) → 오류 + refund.failed audit.
  await deps.payment.recordRefundFailedAudit({
    orderId: order.id,
    reason: input.reason,
    detail: { cancellationStatus: cancellation.status, cancellationId: cancellation.id },
    actorId: deps.actorId,
    actorType,
  });
  return { kind: "failed", reason: `포트원 취소 실패(${cancellation.status}).` };
}

/** 주문 + product.bonusCredits + paidAt 로 RefundCalcInput 을 구성해 calculateRefund 를 호출. */
async function computeRefundCalc(
  order: CreditOrderRecord,
  now: Date,
  deps: VerifyAndGrantDeps,
): Promise<RefundCalcResult> {
  const lots = await deps.payment.getOrderLots(order.id);

  // 보너스: 충전 주문은 product.bonusCredits, 플랜 주문은 0. 유료 lot(단일 purchase lot)에 귀속.
  let bonusCredits = 0;
  if (order.orderType === "credit_topup" && order.productId) {
    const product = await deps.payment.getProductById(order.productId);
    bonusCredits = product?.bonusCredits ?? 0;
  }

  const refundLots: RefundLotSnapshot[] = lots.map((l: OrderLotSnapshot) => ({
    lotId: l.lotId,
    source: l.source as RefundLotSnapshot["source"],
    initialCredits: l.initialCredits,
    remainingCredits: l.remainingCredits,
    // 보너스는 유료(purchase) lot 에만 귀속. plan_grant/기타는 0.
    bonusCredits: l.source === "purchase" ? bonusCredits : 0,
  }));

  const paidAt = order.paidAt ?? order.createdAt;
  const daysSincePayment = Math.max(0, Math.floor((now.getTime() - paidAt.getTime()) / MS_PER_DAY));

  return calculateRefund({
    krwPerCredit: order.krwPerCreditSnapshot > 0 ? order.krwPerCreditSnapshot : 1,
    amountKrw: order.amountKrw - order.refundedAmountKrw, // 이미 환불된 분은 상한에서 제외.
    lots: refundLots,
    daysSincePayment,
  });
}

function toOrderSummary(order: CreditOrderRecord): NonNullable<RefundPreview["order"]> {
  return {
    id: order.id,
    orderType: order.orderType,
    amountKrw: order.amountKrw,
    status: order.status,
    paidAt: order.paidAt,
  };
}
