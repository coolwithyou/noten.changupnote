import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { requireDocumentAgentFeature } from "@/lib/server/documents/documentAgentAvailability";
import {
  listDocumentAgentRuns,
  requestDocumentAgentSuggestions,
  type DocumentAgentRunDto,
  type RequestDocumentAgentSuggestionsResult,
} from "@/lib/server/documents/documentAgentRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const anchorSchema = z.strictObject({
  kind: z.literal("body_paragraph"),
  section: z.number().int().nonnegative(),
  paragraph: z.number().int().nonnegative(),
  charOffset: z.literal(0),
  length: z.number().int().min(1).max(4_000),
});
const postBodySchema = z.strictObject({
  clientRequestId: z.string().uuid(),
  checkpointRequestId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  selectedPage: z.number().int().min(1).max(10_000),
  candidateHint: z.strictObject({
    candidateId: sha256,
    anchor: anchorSchema,
  }),
});

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    requireDocumentAgentFeature();
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    const data = await listDocumentAgentRuns({ draftId, access });
    return NextResponse.json<ActionResult<DocumentAgentRunDto[]>>({ ok: true, data });
  } catch (error) {
    return webActionError<DocumentAgentRunDto[]>(error, {
      code: "document_agent_runs_failed",
      message: "문서 작성 제안 이력을 불러오지 못했습니다.",
    });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireDocumentAgentFeature();
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const parsed = postBodySchema.parse(await readLimitedJson(request));
    const data = await requestDocumentAgentSuggestions({
      draftId,
      access,
      clientRequestId: parsed.clientRequestId,
      checkpointRequestId: parsed.checkpointRequestId,
      baseRevisionId: parsed.baseRevisionId,
      selectedPage: parsed.selectedPage,
      candidateId: parsed.candidateHint.candidateId,
      anchor: parsed.candidateHint.anchor,
    });
    const status = data.run.status === "generating" ? 202 : data.acceptedExisting ? 200 : 201;
    return NextResponse.json<ActionResult<RequestDocumentAgentSuggestionsResult>>(
      { ok: true, data },
      { status },
    );
  } catch (error) {
    return webActionError<RequestDocumentAgentSuggestionsResult>(error, {
      code: "document_agent_request_failed",
      message: "문서 작성 제안을 생성하지 못했습니다.",
    });
  }
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw invalidBody("요청 본문이 너무 큽니다.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw invalidBody("요청 본문이 너무 큽니다.", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidBody("요청 본문을 해석하지 못했습니다.", 400);
  }
}

function invalidBody(message: string, status: number) {
  return Object.assign(new Error(message), { code: "invalid_request_body", status });
}
