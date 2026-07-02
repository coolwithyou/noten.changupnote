import type { NextRequest } from "next/server";
import {
  buildSupportTicketEmailHandoff,
  SupportTicketEmailHandoffError,
  supportTicketEmailHandoffDownloadResponse,
} from "@/lib/server/admin/supportTicketEmailHandoff";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<unknown>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdminSession();
    const params = await context.params;
    const ticketId = readParam(params, "ticketId");
    const handoff = await buildSupportTicketEmailHandoff({ ticketId, admin });
    return supportTicketEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    if (error instanceof SupportTicketEmailHandoffError) {
      return adminError(error.code, error.message, error.status, error.field);
    }
    return adminError(
      "admin_support_ticket_email_handoff_failed",
      error instanceof Error ? error.message : "지원 티켓 이메일 handoff를 만들지 못했습니다.",
    );
  }
}

function readParam(params: unknown, key: string): string {
  if (params && typeof params === "object" && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  throw new SupportTicketEmailHandoffError("invalid_route_param", "요청 경로를 확인해주세요.", 400, key);
}
