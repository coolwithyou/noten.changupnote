// POST /api/internal/credits/subscriptions/[id]/force-cancel (설계 9.3 / 8.5 강제 해지)
//
// { reason, adminActor } → forceCancelSubscription:
//   cancelSchedules 선행(3.1 불변 규칙 — 미소진 예약 전부 취소) → 즉시 canceled 전이 + audit.
// admin(apps/admin) 이 서버 간 시크릿으로만 호출한다.
import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/server/auth/internalAuth";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient, PortoneNotConfiguredError } from "@/lib/server/payments/portone";
import { forceCancelSubscription } from "@/lib/server/payments/subscriptionService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const auth = authorizeInternalRequest(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ ok: false, error: { code: "subscription_id_required", message: "구독 id가 필요합니다." } }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const adminActor = typeof body.adminActor === "string" && body.adminActor.trim() ? body.adminActor.trim() : "system:admin-cancel";
  if (!reason) {
    return NextResponse.json({ ok: false, error: { code: "reason_required", message: "강제 해지 사유가 필요합니다." } }, { status: 400 });
  }

  const repositories = getServiceRepositories();
  const portone = getPortoneClient();
  // 예약 취소를 위해 포트원이 필요하다. 미설정 시 예약이 살아있을 수 있으므로 503 으로 실패(수동 확인).
  if (!portone.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않아 예약 취소를 보장할 수 없습니다." } },
      { status: 503 },
    );
  }

  try {
    const outcome = await forceCancelSubscription(
      { subscriptionId: id, reason, actorId: adminActor },
      {
        subscription: repositories.creditsSubscription,
        payment: repositories.creditsPayment,
        system: repositories.creditsSystem,
        portone,
      },
    );

    switch (outcome.kind) {
      case "not_found":
        return NextResponse.json({ ok: false, error: { code: "subscription_not_found", message: "구독을 찾을 수 없습니다." } }, { status: 404 });
      case "already_terminal":
        return NextResponse.json({ ok: true, data: { kind: "already_terminal", status: outcome.status } });
      case "canceled":
        return NextResponse.json({ ok: true, data: { kind: "canceled", previousStatus: outcome.previousStatus } });
    }
  } catch (error) {
    if (error instanceof PortoneNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: { code: "payment_unavailable", message: "결제 서비스가 설정되지 않았습니다." } },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "force_cancel_error", message: error instanceof Error ? error.message : "강제 해지 실패" } },
      { status: 502 },
    );
  }
}
