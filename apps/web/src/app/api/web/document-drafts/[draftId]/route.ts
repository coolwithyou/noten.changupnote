import type { ActionResult, DocumentDraft, DocumentDraftStatus } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getGrantDocumentDraft, updateGrantDocumentDraft } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    draftId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    const draft = await getGrantDocumentDraft({ draftId, access });
    return NextResponse.json<ActionResult<DocumentDraft>>({ ok: true, data: draft });
  } catch (error) {
    return webActionError<DocumentDraft>(error, {
      code: "draft_load_failed",
      message: "초안을 불러오지 못했습니다.",
    });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = await request.json() as {
      draftMarkdown?: unknown;
      filledFields?: unknown;
      status?: unknown;
    };
    const status = typeof body.status === "string" && isDraftStatus(body.status) ? body.status : undefined;
    const draft = await updateGrantDocumentDraft({
      draftId,
      access,
      ...(typeof body.draftMarkdown === "string" ? { draftMarkdown: body.draftMarkdown } : {}),
      ...(isStringRecord(body.filledFields) ? { filledFields: body.filledFields } : {}),
      ...(status ? { status } : {}),
    });
    return NextResponse.json<ActionResult<DocumentDraft>>({ ok: true, data: draft });
  } catch (error) {
    return webActionError<DocumentDraft>(error, {
      code: "draft_update_failed",
      message: "초안을 저장하지 못했습니다.",
    });
  }
}

function isDraftStatus(value: string): value is DocumentDraftStatus {
  return ["draft", "needs_input", "reviewed", "exported", "archived"].includes(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}
