import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { adminData, adminError } from "@/lib/server/http/envelope";
import { callWebInternal, WebInternalUnavailableError } from "@/lib/server/credits/webInternalClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "support"); // 12.3: 주문 포트원 동기화는 support+.

    const { orderId } = await context.params;
    if (!orderId) return adminError("invalid_route_param", "요청 경로를 확인해주세요.", 400);

    // 웹앱 내부 엔드포인트로 위임(포트원·원장 로직은 웹 단일 구현 — 9.3).
    const result = await callWebInternal<{ outcome: string; status: string; refund?: unknown }>(
      `/api/internal/credits/orders/${encodeURIComponent(orderId)}/sync`,
    );

    if (!result.ok) {
      const code = result.error?.code ?? "sync_failed";
      const message = result.error?.message ?? "동기화에 실패했습니다.";
      return adminError(code, message, result.status || 502);
    }

    // 감사: admin 이 주문 동기화를 개시했다는 사실을 기록(원장 완결 audit 은 웹 쪽이 남긴다).
    await insertCreditAuditLog({
      action: "payment.synced",
      actorSession: session,
      targetType: "payment_order",
      targetId: orderId,
      after: { outcome: result.data?.outcome ?? null, status: result.data?.status ?? null },
    });

    return adminData(result.data ?? {});
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof WebInternalUnavailableError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
