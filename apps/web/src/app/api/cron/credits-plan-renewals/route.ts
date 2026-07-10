// 갱신 안전망 cron (설계 8.3 + 7.3 / 9.2). 매 시간 주기.
//
// Branch 1 — listRenewalDueSubscriptions(2h) 각 구독의 nextScheduleId 를 능동 조회:
//   SUCCEEDED → ★ 즉시결제를 쏘지 않는다. processRenewal(nextSchedulePaymentId)(웹훅 유실 구제, 멱등).
//   FAILED    → handleRenewalFailure(nextSchedulePaymentId).
//   미실행(SCHEDULED/STARTED)·조회불가(null) → 즉시결제 1회 시도(payWithBillingKey → processRenewal).
//   조회 네트워크 에러 → 보류(hold, 다음 회차 재시도, m7 정신).
// Branch 2 — listFailedWebhookEvents(48h): eventType 별로 서비스 fn 직접 재실행(모두 멱등) + processed 표기.
//
// 시스템 경로(user 컨텍스트 없음, 4.13): CRON_SECRET Bearer 로 보호.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient, PortoneApiError, PortoneNotConfiguredError } from "@/lib/server/payments/portone";
import {
  processRenewal,
  handleRenewalFailure,
  handleBillingKeyDeleted,
  type SubscriptionServiceDeps,
} from "@/lib/server/payments/subscriptionService";
import { verifyAndGrant } from "@/lib/server/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RENEWAL_GRACE_MS = 2 * 60 * 60 * 1000; // 2h(8.3).
const FAILED_WEBHOOK_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h(7.3).

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const repositories = getServiceRepositories();
  const portone = getPortoneClient();

  // 결제 채널 미설정이면 능동 조회·결제 불가 — 조기 반환(m7 정신, expire-orders 와 동일).
  if (!portone.isConfigured()) {
    return NextResponse.json({
      ok: true,
      summary: {
        skipped: "payment_unavailable",
        candidates: 0,
        renewed: 0,
        pastDue: 0,
        expired: 0,
        immediateCharged: 0,
        reprocessed: 0,
        held: 0,
      },
      elapsedMs: Date.now() - startedAt,
    });
  }

  const deps: SubscriptionServiceDeps = {
    subscription: repositories.creditsSubscription,
    payment: repositories.creditsPayment,
    system: repositories.creditsSystem,
    portone,
  };

  let candidates = 0;
  let renewed = 0;
  let pastDue = 0;
  let expired = 0;
  let immediateCharged = 0;
  let reprocessed = 0;
  let held = 0;

  try {
    // ── Branch 1: 갱신 도래 구독 능동 조회 ─────────────────────────────────
    const due = await repositories.creditsSubscription.listRenewalDueSubscriptions(RENEWAL_GRACE_MS);
    candidates = due.length;

    for (const sub of due) {
      const paymentId = sub.nextSchedulePaymentId;
      const scheduleId = sub.nextScheduleId;
      if (!paymentId || !scheduleId) {
        // 예약이 없는 도래 구독 — 능동 조회 불가. 다음 회차로 보류.
        held += 1;
        continue;
      }

      let scheduleStatus: string | null;
      try {
        const schedule = await portone.getPaymentSchedule(scheduleId);
        scheduleStatus = schedule?.status ?? null;
      } catch (error) {
        // 조회 네트워크·5xx 에러 → 보류(만료·강등 확정 금지). 다음 회차 재시도(m7).
        if (error instanceof PortoneNotConfiguredError) {
          held += 1;
          continue;
        }
        held += 1;
        continue;
      }

      try {
        if (scheduleStatus === "SUCCEEDED") {
          // ★ 즉시결제를 쏘지 않는다 — 웹훅 유실 구제. 멱등(plan:{orderId}).
          const outcome = await processRenewal({ paymentId }, deps);
          if (outcome.kind === "renewed") renewed += 1;
          else if (outcome.kind === "canceled") renewed += 0;
          // unknown/no_subscription/not_renewal 는 카운트하지 않음(경보는 별도).
        } else if (scheduleStatus === "FAILED" || scheduleStatus === "REVOKED") {
          const outcome = await handleRenewalFailure({ paymentId }, deps);
          if (outcome.kind === "expired") expired += 1;
          else if (outcome.kind === "retry_scheduled") pastDue += 1;
        } else {
          // 미실행(SCHEDULED/STARTED/PENDING) 또는 조회 불가(null) → 즉시결제 1회 시도.
          // 선생성된 plan_renewal 주문(paymentId)으로 결제하고 processRenewal 로 지급.
          const plan = await repositories.creditsSubscription.getPlanById(sub.pendingPlanId ?? sub.planId);
          const payment = await portone.payWithBillingKey({
            paymentId,
            billingKey: sub.billingKey,
            orderName: plan?.name ?? "플랜 구독",
            amount: plan?.monthlyPriceKrw ?? 0,
            customerId: sub.userId,
            idempotencyKey: paymentId,
          });
          immediateCharged += 1;
          if (payment.status === "PAID") {
            const outcome = await processRenewal({ paymentId }, deps);
            if (outcome.kind === "renewed") renewed += 1;
          } else {
            const outcome = await handleRenewalFailure({ paymentId }, deps);
            if (outcome.kind === "expired") expired += 1;
            else if (outcome.kind === "retry_scheduled") pastDue += 1;
          }
        }
      } catch (error) {
        // 결제·갱신 처리 중 네트워크·게이트웨이 에러 → 보류(다음 회차).
        if (error instanceof PortoneApiError || error instanceof PortoneNotConfiguredError) {
          held += 1;
          continue;
        }
        held += 1;
      }
    }

    // ── Branch 2: 실패 웹훅 inbox 재처리(48h, 7.3) ─────────────────────────
    // webhookId unique inbox 는 재삽입이 막히므로 handlePortoneWebhook 대신 서비스 fn 을 직접
    // eventType 별로 재실행한다(모든 경로 멱등). 성공 시 processed 로 표기.
    const failedEvents = await repositories.creditsSubscription.listFailedWebhookEvents(FAILED_WEBHOOK_WINDOW_MS);
    for (const ev of failedEvents) {
      try {
        let handled = false;
        if (ev.eventType === "Transaction.Paid" && ev.paymentId) {
          const order = await repositories.creditsPayment.getOrderByPaymentId(ev.paymentId);
          if (order?.orderType === "plan_renewal") {
            await processRenewal({ paymentId: ev.paymentId }, deps);
          } else {
            await verifyAndGrant(ev.paymentId, deps);
          }
          handled = true;
        } else if (ev.eventType === "Transaction.Failed" && ev.paymentId) {
          const order = await repositories.creditsPayment.getOrderByPaymentId(ev.paymentId);
          if (order?.orderType === "plan_renewal") {
            await handleRenewalFailure({ paymentId: ev.paymentId }, deps);
            handled = true;
          }
          // 단건 충전 실패는 verifyAndGrant 경로가 아님 — 원 webhookHandler 가 markOrderFailed 로 이미 종결.
        } else if (ev.eventType === "BillingKey.Deleted" && ev.billingKey) {
          await handleBillingKeyDeleted({ billingKey: ev.billingKey }, deps);
          handled = true;
        }
        if (handled) {
          await repositories.creditsPayment.updateWebhookEvent({ id: ev.id, processingStatus: "processed" });
          reprocessed += 1;
        }
      } catch {
        // 재처리 실패는 failed 로 유지(다음 회차 재시도). 카운트하지 않음.
      }
    }

    return NextResponse.json({
      ok: true,
      summary: { candidates, renewed, pastDue, expired, immediateCharged, reprocessed, held },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "plan_renewals_failed",
          message: error instanceof Error ? error.message : "갱신 안전망 스윕에 실패했습니다.",
        },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}
