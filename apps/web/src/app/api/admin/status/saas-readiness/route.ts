import { getAdminRuntimeStatus } from "@/lib/server/admin/runtimeStatus";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { appError } from "@/lib/server/appApi/envelope";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { renderSaasReadinessMarkdown } from "@/lib/server/saas/readinessReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminAccess();
    const { saasReadiness } = getAdminRuntimeStatus();
    return markdownDownloadResponse({
      markdown: renderSaasReadinessMarkdown({ readiness: saasReadiness }),
      filename: "창업노트-SaaS-MVP-readiness.md",
      fallbackFilename: "cunote-saas-readiness.md",
    });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("saas_readiness_report_failed", error instanceof Error ? error.message : "SaaS readiness 리포트를 생성하지 못했습니다.");
  }
}
