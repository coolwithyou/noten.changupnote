import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { requireFieldEditorAgentFeature } from "@/lib/server/documents/documentAgentAvailability";
import { studioFieldTargetSchema } from "@/lib/rhwp/studioDocumentAgentProtocol";
import {
  loadRecentFieldAgentRuns,
  requestFieldAgentSuggestions,
  type FieldAgentRunDto,
} from "@/lib/server/documents/fieldAgentRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const postBodySchema = z.strictObject({
  fieldId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  target: studioFieldTargetSchema,
  sourceText: z.string().trim().min(1).max(4_000).optional(),
});

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    requireFieldEditorAgentFeature();
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    const data = await loadRecentFieldAgentRuns({ draftId, access });
    return NextResponse.json<ActionResult<FieldAgentRunDto[]>>({ ok: true, data });
  } catch (error) {
    return webActionError<FieldAgentRunDto[]>(error, {
      code: "field_agent_runs_failed",
      message: "AI 필드 제안 이력을 불러오지 못했습니다.",
    });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireFieldEditorAgentFeature();
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = postBodySchema.parse(await readLimitedJson(request));
    const data = await requestFieldAgentSuggestions({
      draftId,
      access,
      fieldId: body.fieldId,
      clientRequestId: body.clientRequestId,
      baseRevisionId: body.baseRevisionId,
      target: body.target,
      ...(body.sourceText ? { sourceText: body.sourceText } : {}),
    });
    return NextResponse.json<ActionResult<FieldAgentRunDto>>({ ok: true, data }, { status: 201 });
  } catch (error) {
    return webActionError<FieldAgentRunDto>(error, {
      code: "field_agent_request_failed",
      message: "AI 필드 제안을 생성하지 못했습니다.",
    });
  }
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw invalidBody("요청 본문이 너무 큽니다.", 413);
  const value = await request.text();
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) throw invalidBody("요청 본문이 너무 큽니다.", 413);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidBody("요청 본문을 해석하지 못했습니다.", 400);
  }
}

function invalidBody(message: string, status: number) {
  return Object.assign(new Error(message), { code: "invalid_request_body", status });
}
