import { getOpsFlywheelSnapshot } from "@/lib/server/admin/flywheel";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminSession();
    return Response.json({ data: await getOpsFlywheelSnapshot() });
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return Response.json({
      error: {
        code: "admin_flywheel_failed",
        message: error instanceof Error ? error.message : "운영 지표를 불러오지 못했습니다.",
      },
    }, { status: 500 });
  }
}
