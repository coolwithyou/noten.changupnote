import type {
  ActionResult,
  DocumentDraftFeedbackKind,
  DocumentDraftFeedbackRequest,
  DocumentDraftFeedbackResult,
} from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { submitGrantDocumentDraftFeedback } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEEDBACK_KINDS: DocumentDraftFeedbackKind[] = [
  "incorrect_fact",
  "missing_context",
  "format_issue",
  "too_generic",
  "other",
];

interface RouteContext {
  params: Promise<{
    draftId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ draftId }, body, access] = await Promise.all([
      context.params,
      request.json() as Promise<Partial<DocumentDraftFeedbackRequest>>,
      requireCompanyAccess({ permission: "write" }),
    ]);
    if (!isFeedbackKind(body.kind)) {
      return NextResponse.json<ActionResult<DocumentDraftFeedbackResult>>({
        ok: false,
        error: {
          code: "invalid_feedback_kind",
          message: "피드백 유형이 올바르지 않습니다.",
          field: "kind",
        },
      }, { status: 400 });
    }

    const result = await submitGrantDocumentDraftFeedback({
      draftId,
      access,
      request: {
        kind: body.kind,
        ...(typeof body.message === "string" ? { message: body.message } : {}),
        ...(typeof body.selectedText === "string" ? { selectedText: body.selectedText } : {}),
        ...(typeof body.fieldLabel === "string" ? { fieldLabel: body.fieldLabel } : {}),
      },
    });
    return NextResponse.json<ActionResult<DocumentDraftFeedbackResult>>({ ok: true, data: result }, { status: 202 });
  } catch (error) {
    return webActionError<DocumentDraftFeedbackResult>(error, {
      code: "document_draft_feedback_failed",
      message: "초안 피드백을 저장하지 못했습니다.",
    });
  }
}

function isFeedbackKind(value: unknown): value is DocumentDraftFeedbackKind {
  return typeof value === "string" && FEEDBACK_KINDS.includes(value as DocumentDraftFeedbackKind);
}
