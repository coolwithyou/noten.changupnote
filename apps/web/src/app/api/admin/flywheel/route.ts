import { appData, appError } from "@/lib/server/appApi/envelope";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { getAdminFlywheelSnapshot } from "@/lib/server/admin/flywheelStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdminAccess();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 8);
    const snapshot = await getAdminFlywheelSnapshot(Number.isFinite(limit) ? limit : 8);
    return appData(snapshot);
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_flywheel_failed", error instanceof Error ? error.message : "플라이휠 상태를 불러오지 못했습니다.");
  }
}
