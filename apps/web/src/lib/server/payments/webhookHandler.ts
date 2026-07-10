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
import type { CreditPaymentRepository, CreditSystemRepository } from "@cunote/core";
import type { PortoneClient } from "./portone";
import type { PortoneWebhookPayload } from "./portoneWebhook";
import { verifyAndGrant, syncRefundFromPortone } from "./paymentService";

export interface WebhookHandlerDeps {
  payment: CreditPaymentRepository;
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
        const outcome = await verifyAndGrant(paymentId, deps);
        detail = outcome.kind;
        if (outcome.kind === "unknown_order") {
          // "우리가 모르는 결제" — 경보 대상(구독 갱신은 P4 에서 주문 선생성으로 매칭).
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
        // 단건 충전 실패 → 주문 failed. (구독 갱신 실패 분기는 P4 에서 확장 — TODO.)
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
        // ★ 구독 로직 자체는 P4. 이 가드 구조만 지금 작성(레드팀 m6):
        //   payload 의 billingKey 가 구독의 "현재" billingKey 와 일치할 때만 past_due 전환.
        //   (8.5 키 교체가 발생시키는 구 키 Deleted 이벤트에 정상 구독이 강등되는 것 방지.)
        // P4 미구현이므로 현재는 skipped 로 기록(구독 테이블 조회·전이는 P4 에서 추가).
        // TODO(P4): 현재 billingKey 일치 시에만 past_due 전환 + 사용자 알림.
        processingStatus = "skipped";
        detail = "billing_key_deleted_p4";
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
