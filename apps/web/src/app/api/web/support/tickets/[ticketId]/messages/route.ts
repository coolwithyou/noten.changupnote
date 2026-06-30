import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import {
  addUserSupportTicketMessage,
  SupportTicketMessageError,
  type SupportTicketMessageReceipt,
} from "@/lib/server/support/supportTicketMessages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ ticketId }, body, access, session] = await Promise.all([
      context.params,
      readJson(request),
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const result = await addUserSupportTicketMessage({
      ticketId,
      body: body.body,
      access,
      session,
    });
    return NextResponse.json<ActionResult<SupportTicketMessageReceipt>>(
      { ok: true, data: result },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SupportTicketMessageError) {
      return actionError(error.code, error.message, error.field, error.status);
    }
    return actionError(
      "support_ticket_message_failed",
      error instanceof Error ? error.message : "답장을 저장하지 못했습니다.",
      undefined,
      500,
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

function actionError(code: string, message: string, field?: string, status = 400) {
  return NextResponse.json<ActionResult<null>>({
    ok: false,
    error: {
      code,
      message,
      ...(field ? { field } : {}),
    },
  }, { status });
}
