import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import {
  buildSupportTicketIntakeEmailHandoff,
  SupportTicketIntakeEmailHandoffError,
  supportTicketIntakeEmailHandoffDownloadResponse,
} from "@/lib/server/support/supportTicketIntakeEmailHandoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const handoff = buildSupportTicketIntakeEmailHandoff(body);
    return supportTicketIntakeEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof SupportTicketIntakeEmailHandoffError) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        },
      }, { status: error.status });
    }
    return NextResponse.json<ActionResult<null>>({
      ok: false,
      error: {
        code: "support_ticket_intake_email_handoff_failed",
        message: "문의 메일 파일을 만들지 못했습니다.",
      },
    }, { status: 500 });
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
