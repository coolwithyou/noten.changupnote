/**
 * 결제(충전) 도메인 포트 — P3 (설계 7장 / 9.1).
 *
 * ★ 시스템 경로(4.13): verifyAndGrant·웹훅·주문 cron 은 user 세션이 없다.
 *   주문에 userId 가 있으므로, 지급(purchase_grant)은 그 userId 로 user 컨텍스트를 세팅해
 *   applyLedgerEntry 를 경유한다(단일 진입점). 이 포트는 그 오케스트레이션에 필요한
 *   조회·상태전이·감사 로그 원자 연산을 제공한다.
 *
 * 이 포트의 메서드는 세션 검증을 하지 않는다(내부 함수). 세션 소유권 검증(레드팀 M2)은
 * API 라우트 계층(checkout/complete)이 order.userId === session.userId 로 별도 수행한다.
 */

import type { CreditLotSource } from "./ports.js";

export type CreditOrderStatus =
  | "created"
  | "pending"
  | "paid"
  | "failed"
  | "expired"
  | "refunded"
  | "partial_refunded";

export type CreditOrderType = "credit_topup" | "plan_initial" | "plan_renewal";

/** 충전 상품(4.8). */
export interface CreditProductRecord {
  id: string;
  code: string;
  name: string;
  amountKrw: number;
  credits: number;
  bonusCredits: number;
  isActive: boolean;
  displayOrder: number;
}

/** 주문(4.8). */
export interface CreditOrderRecord {
  id: string;
  paymentId: string;
  walletId: string;
  userId: string;
  orderType: CreditOrderType;
  productId: string | null;
  planSubscriptionId: string | null;
  amountKrw: number;
  creditsToGrant: number;
  krwPerCreditSnapshot: number;
  status: CreditOrderStatus;
  portoneStatus: string | null;
  portoneTxId: string | null;
  payMethod: string | null;
  paidAt: Date | null;
  failReason: string | null;
  refundedAmountKrw: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** 환불 계산에 쓰는 주문 lot 스냅샷(source·잔여). */
export interface OrderLotSnapshot {
  lotId: string;
  source: CreditLotSource;
  initialCredits: number;
  remainingCredits: number;
  status: "active" | "exhausted" | "expired" | "revoked";
}

export interface CreateOrderInput {
  /** 주문 id(server 가 미리 생성 — paymentId 가 이 id 의 hex 로 파생되므로 명시 주입). */
  id: string;
  paymentId: string;
  walletId: string;
  userId: string;
  orderType: CreditOrderType;
  productId: string | null;
  amountKrw: number;
  creditsToGrant: number;
  krwPerCreditSnapshot: number;
  expiresAt: Date;
}

/** paymentId 규약(7.2): `cnord_` + orderId(uuid)에서 하이픈 제거. 6~64자 [a-zA-Z0-9-_]. */
export function paymentIdForOrder(orderId: string): string {
  return `cnord_${orderId.replace(/-/g, "")}`;
}

/**
 * 결제/충전 시스템 경로 포트. 세션 없는 신뢰 서버(라우트 래퍼/웹훅/cron)가 호출.
 */
export interface CreditPaymentRepository {
  // ── 상품 (9.1 products) ────────────────────────────────────────────────
  /** 활성 충전 상품 목록(공개). displayOrder 순. */
  listActiveProducts(): Promise<CreditProductRecord[]>;
  /** 상품 code 로 조회(활성만). checkout 검증용. */
  getActiveProductByCode(code: string): Promise<CreditProductRecord | null>;

  // ── 주문 (7.2 checkout) ────────────────────────────────────────────────
  /**
   * 주문 INSERT. paymentId(cnord_+hex)·스냅샷은 호출측이 계산해 넘긴다.
   * 지갑 frozen 검사·동시 미결제 상한(7.2)은 호출측(라우트)이 별도 수행.
   */
  createOrder(input: CreateOrderInput): Promise<CreditOrderRecord>;
  /** paymentId 로 주문 조회. 웹훅·complete·cron 공통. */
  getOrderByPaymentId(paymentId: string): Promise<CreditOrderRecord | null>;
  /** 내 주문 목록(walletId 스코프, 최신순, 커서). orders API(9.1). */
  listOrdersForWallet(input: {
    walletId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{ orders: CreditOrderRecord[]; nextCursor: string | null; hasMore: boolean }>;

  /** user 의 미결제(created/pending) 주문 수(동시 상한 7.2). */
  countOpenOrdersForUser(userId: string): Promise<number>;
  /** user 의 최근 N초 내 주문 생성 수(분당 레이트리밋 7.2). */
  countRecentOrdersForUser(userId: string, sinceMs: number): Promise<number>;

  // ── verifyAndGrant (7.2) ───────────────────────────────────────────────
  /**
   * PAID 확정 지급을 단일 트랜잭션으로 집행한다.
   *  1. applyLedgerEntry(purchase_grant, +creditsToGrant, key=purchase:{orderId}) — order.userId 컨텍스트.
   *  2. 지급 lot 에 paymentOrderId 연결(source=purchase, 만료=purchase_expiry_days).
   *  3. order UPDATE status=paid, paidAt, portoneTxId, payMethod, portoneStatus.
   *  4. audit_log(action="payment.paid").
   * 멱등(purchase:{orderId})이므로 웹훅·complete·cron 중 누가 먼저 와도 안전.
   * 반환: 지급 후 지갑 balance + 지급 크레딧.
   */
  grantPurchaseForOrder(input: {
    orderId: string;
    portone: { status: string; txId: string | null; payMethod: string | null };
    lotExpiresAt: Date | null;
  }): Promise<{ grantedCredits: number; balance: number }>;

  /** 검증 불일치(7.2): order failed + audit(payment.mismatch). */
  markOrderMismatch(input: {
    orderId: string;
    portoneStatus: string;
    detail: Record<string, unknown>;
  }): Promise<void>;

  /** 확정 실패(FAILED): order failed + fail_reason. */
  markOrderFailed(input: { orderId: string; reason: string; portoneStatus?: string | null }): Promise<void>;

  /** 미결제 확정 만료(cron): order expired. */
  markOrderExpired(orderId: string): Promise<void>;

  /** 만료 대상 주문(status IN created/pending AND expires_at < now). cron 능동 조회용(7.2). */
  listDueOrders(limit: number): Promise<CreditOrderRecord[]>;

  // ── 환불 동기화 (7.4 콘솔 발 취소) ─────────────────────────────────────
  /** 주문의 유료 lot 스냅샷(환불 계산 입력). */
  getOrderLots(orderId: string): Promise<OrderLotSnapshot[]>;

  /**
   * 환불 회수를 단일 트랜잭션으로 집행(콘솔 발 취소 웹훅 동기화 — 7.4 레드팀 M3).
   *  - applyLedgerEntry(refund_deduct, -recoverCredits, key=refund:{orderId}:{cancellationId},
   *    lotSelection={targetLotIds}) — 회수 가능분만(shortfall 허용).
   *  - lot status=revoked(전액 회수 시), order status=refunded|partial_refunded, refundedAmountKrw += .
   *  - shortfall(회수 필요 > 가능) 발생 시: refund.shortfall audit + 지갑 자동 frozen.
   *  - audit_log(action="refund.synced").
   * 멱등(refund 키)이라 웹훅 재전송에 안전.
   */
  syncRefundForOrder(input: {
    orderId: string;
    cancellationId: string;
    targetLotIds: string[];
    recoverCredits: number;
    refundedAmountKrw: number;
    fullRefund: boolean;
    reason: string;
  }): Promise<{ recovered: number; shortfall: number; frozen: boolean }>;

  // ── 웹훅 inbox (7.3) ────────────────────────────────────────────────────
  /**
   * inbox INSERT. webhookId unique 충돌 시 { duplicate: true } 반환(이미 처리 — 멱등).
   * payloadDigest 는 화이트리스트 발췌만(원문 비저장, 레드팀 M5).
   */
  insertWebhookEvent(input: {
    webhookId: string;
    eventType: string;
    paymentId: string | null;
    billingKey: string | null;
    payloadDigest: Record<string, unknown>;
  }): Promise<{ id: string; duplicate: boolean }>;

  /** 웹훅 처리 결과 기록(processed/failed/skipped + error). */
  updateWebhookEvent(input: {
    id: string;
    processingStatus: "processed" | "failed" | "skipped";
    error?: string | null;
  }): Promise<void>;
}
