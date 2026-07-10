// 주문 만료·지연 구제 cron (설계 7.2 / 9.2). 매 10분 주기.
//
//   status IN (created,pending) AND expires_at < now() 인 주문마다:
//     포트원 능동 조회 1회(GET /payments/{id}) →
//       PAID → verifyAndGrant(지연 완료 구제)
//       미결제 확정(FAILED/미결제 상태) → expired
//   ★ 조회가 에러(네트워크·5xx)면 expired 로 확정하지 말고 보류(레드팀 m7).
//     조회 실패를 미결제로 오판하면 결제된 주문이 expired 로 방치된다.
//
// 시스템 경로(user 컨텍스트 없음, 4.13): CRON_SECRET Bearer 로 보호.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient, PortoneNotConfiguredError } from "@/lib/server/payments/portone";
import { verifyAndGrant } from "@/lib/server/payments/paymentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const limit = boundedIntParam(params.get("limit"), 200, 1, 1000);
  const startedAt = Date.now();

  const repositories = getServiceRepositories();
  const portone = getPortoneClient();

  // 결제 채널 미설정이면 능동 조회 불가 — 주문을 만료시키지 않고 조기 반환(m7 정신).
  if (!portone.isConfigured()) {
    return NextResponse.json({
      ok: true,
      summary: { skipped: "payment_unavailable", granted: 0, expired: 0, held: 0 },
      elapsedMs: Date.now() - startedAt,
    });
  }

  let granted = 0;
  let expired = 0;
  let held = 0; // 조회 에러로 보류한 주문 수(다음 회차 재시도).

  try {
    const due = await repositories.creditsPayment.listDueOrders(limit);
    for (const order of due) {
      try {
        const outcome = await verifyAndGrant(order.paymentId, {
          payment: repositories.creditsPayment,
          system: repositories.creditsSystem,
          portone,
        });
        if (outcome.kind === "granted") {
          granted += 1;
        } else if (outcome.kind === "pending") {
          // 아직 결제 대기 — 만료하지 않고 다음 회차로 보류.
          held += 1;
        } else if (outcome.kind === "failed" || outcome.kind === "mismatch") {
          // 확정 실패 — verifyAndGrant 가 이미 failed 로 표기함. expired 로 덮지 않는다.
          expired += 0;
        } else if (outcome.kind === "already") {
          // 이미 처리(paid/refunded 등) — 스킵.
        } else {
          // unknown_order 등 — 미결제 확정으로 간주해 만료.
          await repositories.creditsPayment.markOrderExpired(order.id);
          expired += 1;
        }
      } catch (error) {
        // ★ 조회 에러(네트워크·5xx)면 보류(레드팀 m7). 결제 미설정도 보류.
        if (error instanceof PortoneNotConfiguredError) {
          held += 1;
          continue;
        }
        // 네트워크/5xx → 보류(만료 확정 금지). 다음 회차에 재시도.
        held += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      summary: { candidates: due.length, granted, expired, held },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "expire_orders_failed",
          message: error instanceof Error ? error.message : "주문 만료 스윕에 실패했습니다.",
        },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

function boundedIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
