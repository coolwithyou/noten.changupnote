import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  buildSupportTicketTranscript,
  SupportTicketTranscriptError,
  supportTicketTranscriptDownloadResponse,
} from "@/lib/server/support/supportTicketTranscript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ ticketId }, access, session] = await Promise.all([
      context.params,
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const transcript = await buildSupportTicketTranscript({ ticketId, access, session });
    return supportTicketTranscriptDownloadResponse(transcript);
  } catch (error) {
    if (error instanceof SupportTicketTranscriptError) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.field ? { field: error.field } : {}),
        },
      }, { status: error.status });
    }
    return webActionError<null>(error, {
      code: "support_ticket_transcript_failed",
      message: "문의 기록을 다운로드하지 못했습니다.",
    });
  }
}
