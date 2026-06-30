import { getAdminRuntimeStatus } from "@/lib/server/admin/runtimeStatus";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { appError } from "@/lib/server/appApi/envelope";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";
import { renderLegalReadinessMarkdown } from "@/lib/server/legal/legalReadinessReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminAccess();
    const { legalReadiness } = getAdminRuntimeStatus();
    return markdownDownloadResponse({
      markdown: renderLegalReadinessMarkdown({ readiness: legalReadiness }),
      filename: "창업노트-운영-법무-readiness.md",
      fallbackFilename: "cunote-legal-readiness.md",
    });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("legal_readiness_report_failed", error instanceof Error ? error.message : "운영 법무 readiness 리포트를 생성하지 못했습니다.");
  }
}
