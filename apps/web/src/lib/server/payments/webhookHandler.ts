/**
 * 포트원 웹훅 처리 로직 (설계 7.3). 라우트에서 분리해 테스트 가능하게 한다.
 *
 * 흐름:
 *   1. rawBody 서명 검증(실패 → 401, 본문 처리 없음) — 라우트가 verifyPortoneWebhook 로 먼저 수행.
 *   2. inbox INSERT(webhookId unique) — 충돌 시 이미 처리(멱등) → skip.
 *   3. eventType 분기.
 *   4. 결과 UPDATE(processed/failed/skipped). 항상 200(서명 실패만 401).
 *
 * 진실은 항상 GET /payments/{id} 재조회로 확정(verifyAndGrant/syncRefundFromPortone 내부).
 * payloadDigest 는 화이트리스트 발췌만 저장(원문 비저장 — 레드팀 M5 PII).
 */
import type {
  CreditPaymentRepository,
  CreditSubscriptionRepository,
  CreditSystemRepository,
} from "@cunote/core";
import type { PortoneClient } from "./portone";
import type { PortoneWebhookPayload } from "./portoneWebhook";
import { verifyAndGrant, syncRefundFromPortone } from "./paymentService";
import {
  processRenewal,
  handleRenewalFailure,
  handleBillingKeyDeleted,
  type SubscriptionServiceDeps,
} from "./subscriptionService";

export interface WebhookHandlerDeps {
  payment: CreditPaymentRepository;
  subscription: CreditSubscriptionRepository;
  system: CreditSystemRepository;
  portone: PortoneClient;
  now?: () => Date;
}

export interface WebhookHandleResult {
  ok: true;
  duplicate: boolean;
  processingStatus: "processed" | "failed" | "skipped" | "duplicate";
  detail?: string;
}

export async function handlePortoneWebhook(
  webhookId: string,
  payload: PortoneWebhookPayload,
  deps: WebhookHandlerDeps,
): Promise<WebhookHandleResult> {
  const eventType = payload.type;
  const paymentId = payload.data?.paymentId ?? null;
  const billingKey = payload.data?.billingKey ?? null;

  // payloadDigest — 화이트리스트 발췌만(원문 비저장, 레드팀 M5).
  const payloadDigest: Record<string, unknown> = {
    type: eventType,
    paymentId,
    transactionId: payload.data?.transactionId ?? null,
    cancellationId: payload.data?.cancellationId ?? null,
    hasBillingKey: Boolean(billingKey),
  };

  // inbox INSERT — 충돌(이미 처리)이면 멱등 skip.
  const inbox = await deps.payment.insertWebhookEvent({
    webhookId,
    eventType,
    paymentId,
    billingKey,
    payloadDigest,
  });
  if (inbox.duplicate) {
    return { ok: true, duplicate: true, processingStatus: "duplicate" };
  }

  // 구독 서비스 deps(P4). 웹훅 deps 를 그대로 전달.
  const subDeps: SubscriptionServiceDeps = {
    subscription: deps.subscription,
    payment: deps.payment,
    system: deps.system,
    portone: deps.portone,
    ...(deps.now ? { now: deps.now } : {}),
  };

  let processingStatus: "processed" | "failed" | "skipped" = "processed";
  let detail: string | undefined;
  try {
    switch (eventType) {
      case "Transaction.Paid": {
        if (!paymentId) {
          processingStatus = "skipped";
          detail = "paymentId 없음";
          break;
        }
        // 주문 유형으로 분기(plan_renewal → 갱신, plan_initial → 멱등 no-op, credit_topup → 충전).
        const order = await deps.payment.getOrderByPaymentId(paymentId);
        if (!order) {
          // "우리가 모르는 결제" — 경보 대상(레드팀 B2).
          processingStatus = "failed";
          detail = "unknown_order";
          break;
        }
        if (order.orderType === "plan_renewal") {
          // 8.3 갱신(웹훅). 멱등(plan:{orderId}). cron 안전망과 공유.
          const renewal = await processRenewal({ paymentId }, subDeps);
          detail = `renewal_${renewal.kind}`;
          if (renewal.kind === "unknown_order" || renewal.kind === "no_subscription") {
            processingStatus = "failed";
          }
          break;
        }
        // plan_initial: 최초 구독은 startSubscription 에서 동기 완료됨. 웹훅이 뒤늦게 와도
        // activateSubscriptionWithGrant 는 plan:{orderId} 로 멱등이므로 재활성화가 안전한 no-op.
        // credit_topup: 기존 verifyAndGrant(멱등 purchase:{orderId}).
        // 둘 다 verifyAndGrant 로 처리(plan_initial 은 order.status=paid 면 already no-op).
        const outcome = await verifyAndGrant(paymentId, deps);
        detail = outcome.kind;
        if (outcome.kind === "unknown_order") {
          processingStatus = "failed";
          detail = "unknown_order";
        }
        break;
      }
      case "Transaction.Failed": {
        if (!paymentId) {
          processingStatus = "skipped";
          break;
        }
        const order = await deps.payment.getOrderByPaymentId(paymentId);
        if (!order) {
          processingStatus = "failed";
          detail = "unknown_order";
          break;
        }
        if (order.orderType === "plan_renewal") {
          // 8.4 갱신 실패 → past_due + 재시도 예약 1개(레드팀 이중청구 방지).
          const failure = await handleRenewalFailure({ paymentId }, subDeps);
          detail = `renewal_failure_${failure.kind}`;
          break;
        }
        // 단건 충전 실패 → 주문 failed.
        await deps.payment.markOrderFailed({
          orderId: order.id,
          reason: "webhook_transaction_failed",
          portoneStatus: "FAILED",
        });
        detail = "order_failed";
        break;
      }
      case "Transaction.Cancelled":
      case "Transaction.PartialCancelled": {
        if (!paymentId) {
          processingStatus = "skipped";
          break;
        }
        // 7.4 환불 동기화(콘솔 발 취소 포함). 회수 가능분만 회수 + shortfall 시 지갑 frozen.
        const refund = await syncRefundFromPortone(paymentId, deps);
        detail = refund.kind + (refund.frozen ? " (frozen)" : "");
        if (refund.kind === "unknown_order") {
          processingStatus = "failed";
        }
        break;
      }
      case "BillingKey.Deleted": {
        // 7.3(레드팀 m6): payload 의 billingKey 가 구독의 "현재" billingKey 와 일치할 때만 past_due 전환.
        // 키 교체(8.5)가 발생시키는 구 키 Deleted 이벤트는 현재 키가 아니므로 강등하지 않는다.
        if (!billingKey) {
          processingStatus = "skipped";
          detail = "no_billing_key";
          break;
        }
        const deleted = await handleBillingKeyDeleted({ billingKey }, subDeps);
        // 매칭·강등이면 processed, 현재 키 불일치(구 키 로테이션)면 skipped.
        processingStatus = deleted.kind === "demoted" ? "processed" : "skipped";
        detail = `billing_key_deleted_${deleted.kind}`;
        break;
      }
      default:
        processingStatus = "skipped";
        detail = "unhandled_event";
        break;
    }
  } catch (error) {
    processingStatus = "failed";
    detail = error instanceof Error ? error.message : "webhook_processing_error";
  }

  await deps.payment.updateWebhookEvent({
    id: inbox.id,
    processingStatus,
    error: processingStatus === "failed" ? (detail ?? "failed") : null,
  });

  const result: WebhookHandleResult = { ok: true, duplicate: false, processingStatus };
  if (detail !== undefined) result.detail = detail;
  return result;
}
