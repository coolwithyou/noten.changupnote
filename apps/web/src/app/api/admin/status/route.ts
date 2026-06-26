import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { appData, appError } from "@/lib/server/appApi/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireAdminAccess();
    return appData({
      ok: true,
      role: access.role,
      mode: access.mode,
      surfaces: ["extraction_log", "feedback", "match_events", "golden_set", "eval_runs"],
    });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_status_failed", error instanceof Error ? error.message : "어드민 상태 확인에 실패했습니다.");
  }
}
