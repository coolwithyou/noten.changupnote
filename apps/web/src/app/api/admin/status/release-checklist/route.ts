import { getAdminRuntimeStatus } from "@/lib/server/admin/runtimeStatus";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { appError } from "@/lib/server/appApi/envelope";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { buildSaasReleaseChecklist } from "@/lib/server/saas/releaseChecklist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminAccess();
    const runtime = getAdminRuntimeStatus();
    const checklist = buildSaasReleaseChecklist({
      legalReadiness: runtime.legalReadiness,
      saasReadiness: runtime.saasReadiness,
      runtime,
    });
    return markdownDownloadResponse({
      markdown: checklist.markdown,
      filename: checklist.filename,
      fallbackFilename: checklist.fallbackFilename,
    });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("saas_release_checklist_failed", error instanceof Error ? error.message : "SaaS release checklist를 생성하지 못했습니다.");
  }
}
