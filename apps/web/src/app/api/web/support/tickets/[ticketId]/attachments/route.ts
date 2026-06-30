import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess, type CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  SupportTicketAttachmentError,
  uploadSupportTicketAttachment,
  type SupportTicketAttachmentUploadResult,
} from "@/lib/server/support/supportTicketAttachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    ticketId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ ticketId }, formData, session, access] = await Promise.all([
      context.params,
      request.formData(),
      getOptionalWebSession(),
      optionalCompanyAccess(),
    ]);
    const file = formData.get("file");
    if (!isUploadFile(file)) {
      return NextResponse.json<ActionResult<SupportTicketAttachmentUploadResult>>({
        ok: false,
        error: {
          code: "support_ticket_attachment_file_required",
          message: "업로드할 파일을 선택해주세요.",
          field: "file",
        },
      }, { status: 400 });
    }

    const result = await uploadSupportTicketAttachment({
      ticketId,
      file,
      access,
      session,
      email: formData.get("email"),
    });

    return NextResponse.json<ActionResult<SupportTicketAttachmentUploadResult>>(
      { ok: true, data: result },
      { status: result.persisted ? 201 : 202 },
    );
  } catch (error) {
    if (error instanceof SupportTicketAttachmentError) {
      return webActionError<SupportTicketAttachmentUploadResult>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<SupportTicketAttachmentUploadResult>(error, {
      code: "support_ticket_attachment_upload_failed",
      message: "문의 첨부 파일을 업로드하지 못했습니다.",
    });
  }
}

async function optionalCompanyAccess(): Promise<CompanyAccess | null> {
  try {
    return await requireCompanyAccess();
  } catch {
    return null;
  }
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value === "object" && "arrayBuffer" in value && "size" in value && "name" in value);
}
