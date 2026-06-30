import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  SupportTicketMessageError,
  type UserSupportTicketStatusResult,
  updateUserSupportTicketStatus,
} from "@/lib/server/support/supportTicketMessages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
  }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const [{ ticketId }, body, access, session] = await Promise.all([
      context.params,
      readJson(request),
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const result = await updateUserSupportTicketStatus({
      ticketId,
      action: body.action,
      access,
      session,
    });
    return NextResponse.json<ActionResult<UserSupportTicketStatusResult>>({ ok: true, data: result });
  } catch (error) {
    if (error instanceof SupportTicketMessageError) {
      return webActionError<UserSupportTicketStatusResult>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<UserSupportTicketStatusResult>(error, {
      code: "support_ticket_status_failed",
      message: "문의 상태를 저장하지 못했습니다.",
    });
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
