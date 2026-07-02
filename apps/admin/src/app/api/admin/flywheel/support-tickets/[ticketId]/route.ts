import type { NextRequest } from "next/server";
import { updateAdminSupportTicket, AdminSupportTicketError } from "@/lib/server/admin/supportTickets";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<unknown>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdminSession();
    const [params, body] = await Promise.all([context.params, readJson(request)]);
    const ticketId = readParam(params, "ticketId");
    const result = await updateAdminSupportTicket({
      ticketId,
      status: body.status,
      priority: body.priority,
      assignedTo: body.assignedTo,
      slaDueAt: body.slaDueAt,
      note: body.note,
      admin,
    });
    return adminData(result);
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminSupportTicketError) {
      return adminError(error.code, error.message, error.status, error.field);
    }
    return adminError(
      "admin_support_ticket_update_failed",
      error instanceof Error ? error.message : "지원 티켓 상태를 저장하지 못했습니다.",
    );
  }
}

function readParam(params: unknown, key: string): string {
  if (params && typeof params === "object" && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  throw new AdminSupportTicketError("invalid_route_param", "요청 경로를 확인해주세요.", 400, key);
}
