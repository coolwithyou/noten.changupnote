import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "support");

    const { orderId } = await context.params;
    void orderId;

    // TODO: P3 완료 후 portone.getPayment(order.payment_id) → verifyAndGrant 로직 연결
    return adminError("not_implemented", "P3/P4 포트원 클라이언트 배선 예정", 501);
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
