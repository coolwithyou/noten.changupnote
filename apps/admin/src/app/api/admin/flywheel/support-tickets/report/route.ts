import { markdownDownloadResponse } from "@/lib/server/admin/readiness";
import { listAdminSupportTicketReportItems, renderAdminSupportTicketReport } from "@/lib/server/admin/supportTicketReport";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "support");
    const tickets = await loadTickets();
    return markdownDownloadResponse({
      markdown: renderAdminSupportTicketReport({
        tickets,
        generatedAt: new Date(),
      }),
      filename: "창업노트-고객지원-운영큐.md",
    });
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return adminError(
      "admin_support_ticket_report_failed",
      error instanceof Error ? error.message : "고객지원 운영 큐 리포트를 생성하지 못했습니다.",
    );
  }
}

async function loadTickets() {
  try {
    return await listAdminSupportTicketReportItems(50);
  } catch {
    return [];
  }
}
