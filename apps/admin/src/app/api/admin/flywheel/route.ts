import { getOpsFlywheelSnapshot } from "@/lib/server/admin/flywheel";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "viewer");
    return Response.json({ data: await getOpsFlywheelSnapshot() });
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return Response.json({
      error: {
        code: "admin_flywheel_failed",
        message: error instanceof Error ? error.message : "운영 지표를 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
