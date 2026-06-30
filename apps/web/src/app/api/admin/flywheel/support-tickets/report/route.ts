import { getAdminFlywheelSnapshot } from "@/lib/server/admin/flywheelStore";
import { renderAdminSupportTicketReport } from "@/lib/server/admin/supportTicketReport";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { appError } from "@/lib/server/appApi/envelope";
import { markdownDownloadResponse } from "@/lib/server/documents/downloadHeaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminAccess();
    const snapshot = await loadSnapshot();
    return markdownDownloadResponse({
      markdown: renderAdminSupportTicketReport({
        tickets: snapshot?.recent.supportTickets ?? [],
        generatedAt: snapshot ? new Date(snapshot.generatedAt) : new Date(),
      }),
      filename: "창업노트-고객지원-운영큐.md",
      fallbackFilename: "cunote-support-queue.md",
    });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_support_ticket_report_failed", error instanceof Error ? error.message : "고객지원 운영 큐 리포트를 생성하지 못했습니다.");
  }
}

async function loadSnapshot(): Promise<Awaited<ReturnType<typeof getAdminFlywheelSnapshot>> | null> {
  try {
    return await getAdminFlywheelSnapshot(50);
  } catch {
    return null;
  }
}
