import { appError } from "@/lib/server/appApi/envelope";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import {
  buildSupportTicketEmailHandoff,
  SupportTicketEmailHandoffError,
  supportTicketEmailHandoffDownloadResponse,
} from "@/lib/server/admin/supportTicketEmailHandoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const admin = await requireAdminAccess();
    const { ticketId } = await context.params;
    const handoff = await buildSupportTicketEmailHandoff({ ticketId, admin });
    return supportTicketEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    if (error instanceof SupportTicketEmailHandoffError) {
      return appError(error.code, error.message, error.status, error.field);
    }
    return appError(
      "admin_support_ticket_email_handoff_failed",
      error instanceof Error ? error.message : "지원 티켓 이메일 handoff를 만들지 못했습니다.",
    );
  }
}
