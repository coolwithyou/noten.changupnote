import type { ActionResult, DocumentDraft, DocumentDraftSectionRegenerationRequest } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { regenerateGrantDocumentDraftSection } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    draftId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ draftId }, body, access] = await Promise.all([
      context.params,
      request.json() as Promise<Partial<DocumentDraftSectionRegenerationRequest>>,
      requireCompanyAccess({ permission: "write" }),
    ]);
    if (typeof body.sectionTitle !== "string" || body.sectionTitle.trim().length === 0) {
      return NextResponse.json<ActionResult<DocumentDraft>>({
        ok: false,
        error: {
          code: "section_title_required",
          message: "재생성할 섹션을 선택해주세요.",
          field: "sectionTitle",
        },
      }, { status: 400 });
    }

    const draft = await regenerateGrantDocumentDraftSection({
      draftId,
      access,
      request: {
        sectionTitle: body.sectionTitle,
        ...(isStringRecord(body.answers) ? { answers: body.answers } : {}),
        ...(isStringRecord(body.filledFields) ? { filledFields: body.filledFields } : {}),
        ...(typeof body.draftMarkdown === "string" ? { draftMarkdown: body.draftMarkdown } : {}),
      },
    });
    return NextResponse.json<ActionResult<DocumentDraft>>({ ok: true, data: draft });
  } catch (error) {
    return webActionError<DocumentDraft>(error, {
      code: "draft_section_regenerate_failed",
      message: "선택한 섹션을 다시 생성하지 못했습니다.",
    });
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}
