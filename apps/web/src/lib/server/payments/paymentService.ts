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
import type {
  CreditPaymentRepository,
  CreditSystemRepository,
  CreditOrderRecord,
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
