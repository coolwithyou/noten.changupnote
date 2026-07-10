// POST /api/webhooks/portone (설계 7.3)
//
// 1. rawBody = await request.text()  — JSON 파싱 전 원문(서명 검증).
// 2. 서명 검증 실패 → 401(본문 처리 없음).
// 3. inbox INSERT(webhookId unique) → 충돌=이미 처리(멱등) → 200.
// 4. eventType 분기.
// 5. 항상 200(재시도 폭주 방지). 서명 실패만 401. 진실은 항상 GET /payments/{id} 재조회.
import { NextResponse } from "next/server";
import { getServiceRepositories } from "@/lib/server/serviceData";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { verifyPortoneWebhook, WebhookVerificationError } from "@/lib/server/payments/portoneWebhook";
import { handlePortoneWebhook } from "@/lib/server/payments/webhookHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();

  // 서명 검증 — 실패 시 401(본문 처리 없음).
  let payload;
  let webhookId: string;
  try {
    payload = verifyPortoneWebhook(rawBody, request.headers);
    webhookId = request.headers.get("webhook-id") ?? "";
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: 401 });
    }
    // 알 수 없는 검증 오류도 401(검증 불가 웹훅은 처리하지 않는다).
    return NextResponse.json(
      { ok: false, error: { code: "webhook_verify_failed", message: "웹훅 검증 실패" } },
      { status: 401 },
    );
  }

  try {
    const repositories = getServiceRepositories();
    const result = await handlePortoneWebhook(webhookId, payload, {
      payment: repositories.creditsPayment,
      system: repositories.creditsSystem,
      portone: getPortoneClient(),
    });
    // 항상 200 — 처리 실패(processingStatus=failed)도 200(재시도 폭주 방지, cron 이 재처리).
    return NextResponse.json(result, { status: 200 });
  } catch {
    // 예기치 못한 오류도 200 — 재시도 폭주 방지(cron/inbox 재처리 경로가 복구).
    return NextResponse.json({ ok: true, processingStatus: "failed" }, { status: 200 });
  }
}
