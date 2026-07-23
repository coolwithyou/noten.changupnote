import { buildOpsLegalReadiness, markdownDownloadResponse, renderOpsReadinessMarkdown } from "@/lib/server/admin/readiness";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "viewer");
    return markdownDownloadResponse({
      markdown: renderOpsReadinessMarkdown(buildOpsLegalReadiness()),
      filename: "창업노트-Ops-legal-readiness.md",
    });
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return adminError("ops_legal_readiness_failed", error instanceof Error ? error.message : "Ops legal readiness를 생성하지 못했습니다.");
  }
}
