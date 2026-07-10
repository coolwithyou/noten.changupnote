// POST /api/internal/credits/subscriptions/cancel-schedules-for-user (설계 9.3 / 4.1 freeze 연동)
//
// { userId } → 해당 유저의 활성(active/past_due) 구독의 미소진 포트원 예약을 전부 취소한다.
// ★ 구독 자체는 유지(canceled 로 만들지 않는다). 동결 시 "다음 예약결제만 막는" 것이 목적(4.1).
// admin(apps/admin) 이 지갑 동결 시 서버 간 시크릿으로 호출한다.
import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/server/auth/internalAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient, PortoneNotConfiguredError } from "@/lib/server/payments/portone";
import { cancelSchedulesForUser } from "@/lib/server/payments/subscriptionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const userId = typeof body.userId === "string" ? body.userId : null;
  if (!userId) {
    return NextResponse.json({ ok: false, error: { code: "user_id_required", message: "userId가 필요합니다." } }, { status: 400 });
  }

  const repositories = getServiceRepositories();
  const portone = getPortoneClient();
  if (!portone.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않아 예약 취소를 보장할 수 없습니다." } },
      { status: 503 },
    );
  }

  try {
    const outcome = await cancelSchedulesForUser(
      { userId },
      {
        subscription: repositories.creditsSubscription,
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
      },
    );
    return NextResponse.json({
      ok: true,
      data:
        outcome.kind === "no_subscription"
          ? { kind: "no_subscription", canceledSchedules: false }
          : { kind: "schedules_canceled", canceledSchedules: true, subscriptionId: outcome.subscriptionId },
    });
  } catch (error) {
    if (error instanceof PortoneNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "cancel_schedules_error", message: error instanceof Error ? error.message : "예약 취소 실패" } },
      { status: 502 },
    );
  }
}
