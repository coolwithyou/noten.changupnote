import type { ActionResult, DraftGenerationRequest, DraftGenerationResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { createGrantDocumentDraft } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { grantId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = await request.json() as Partial<DraftGenerationRequest>;
    if (!body.documentKey || typeof body.documentKey !== "string") {
      return NextResponse.json<ActionResult<DraftGenerationResult>>({
        ok: false,
        error: {
          code: "document_key_required",
          message: "초안을 만들 서류를 선택해주세요.",
          field: "documentKey",
        },
      }, { status: 400 });
    }

    const result = await createGrantDocumentDraft({
      grantId,
      access,
      request: {
        documentKey: body.documentKey,
        ...(isRecord(body.answers) ? { answers: stringRecord(body.answers) } : {}),
      },
    });
    return NextResponse.json<ActionResult<DraftGenerationResult>>({ ok: true, data: result });
  } catch (error) {
    return webActionError<DraftGenerationResult>(error, {
      code: "draft_create_failed",
      message: "초안을 만들지 못했습니다.",
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}
