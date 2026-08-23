import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { requireFieldEditorAgentFeature } from "@/lib/server/documents/documentAgentAvailability";
import { generateScheduleSuggestion, type ScheduleSuggestResult } from "@/lib/server/documents/scheduleSuggest";
import { scheduleSuggestionRequestSchema } from "@/lib/rhwp/scheduleTableContract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 12 * 1024;

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireFieldEditorAgentFeature();
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = scheduleSuggestionRequestSchema.parse(await readLimitedJson(request));
    const data = await generateScheduleSuggestion({ draftId, access, request: body });
    return NextResponse.json<ActionResult<ScheduleSuggestResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<ScheduleSuggestResult>(error, {
      code: "schedule_suggestion_failed",
      message: "사업추진 일정안을 만들지 못했습니다.",
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
