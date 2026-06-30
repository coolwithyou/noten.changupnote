import { appData, appError } from "@/lib/server/appApi/envelope";
import {
  addAdminSupportTicketMessage,
  AdminSupportTicketError,
} from "@/lib/server/admin/supportTicketOps";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requireAdminAccess();
    const [{ ticketId }, body] = await Promise.all([context.params, readJson(request)]);
    const result = await addAdminSupportTicketMessage({
      ticketId,
      body: body.body,
      visibility: body.visibility,
      admin,
    });
    return appData(result, { status: 201 });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    if (error instanceof AdminSupportTicketError) {
      return appError(error.code, error.message, error.status, error.field);
    }
    return appError(
      "admin_support_ticket_message_failed",
      error instanceof Error ? error.message : "지원 티켓 메시지를 저장하지 못했습니다.",
    );
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
