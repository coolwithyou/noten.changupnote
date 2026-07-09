import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "admin");

    const body = await readJson(request);
    const orderId = typeof body.orderId === "string" ? body.orderId : null;
    const reason = typeof body.reason === "string" ? body.reason : null;

    if (!orderId) {
      return adminError("order_id_required", "orderId가 필요합니다.", 400, "orderId");
    }
    if (!reason) {
      return adminError("reason_required", "환불 사유가 필요합니다.", 400, "reason");
    }

    // TODO: P3 완료 후 executeRefund 로직 연결
    return adminError("not_implemented", "P3/P4 포트원 클라이언트 배선 예정", 501);
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
