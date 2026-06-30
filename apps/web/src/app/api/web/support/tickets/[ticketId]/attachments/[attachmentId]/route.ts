import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  archiveSupportTicketAttachment,
  SupportTicketAttachmentError,
  type SupportTicketAttachmentArchiveResult,
} from "@/lib/server/support/supportTicketAttachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
    attachmentId: string;
  }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const [{ ticketId, attachmentId }, access, session] = await Promise.all([
      context.params,
      requireCompanyAccess(),
      getOptionalWebSession(),
    ]);
    const result = await archiveSupportTicketAttachment({
      ticketId,
      attachmentId,
      access,
      session,
    });
    return NextResponse.json<ActionResult<SupportTicketAttachmentArchiveResult>>(
      { ok: true, data: result },
      { status: result.persisted ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof SupportTicketAttachmentError) {
      return webActionError<SupportTicketAttachmentArchiveResult>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<SupportTicketAttachmentArchiveResult>(error, {
      code: "support_ticket_attachment_archive_failed",
      message: "첨부 파일 보관 상태를 변경하지 못했습니다.",
    });
  }
}
