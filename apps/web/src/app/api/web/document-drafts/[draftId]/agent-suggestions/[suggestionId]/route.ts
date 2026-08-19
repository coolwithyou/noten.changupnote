import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { requireDocumentAgentFeature } from "@/lib/server/documents/documentAgentAvailability";
import {
  transitionDocumentAgentSuggestion,
  type DocumentAgentSuggestionDto,
} from "@/lib/server/documents/documentAgentRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const actionSchema = z.enum([
  "approve",
  "dismiss",
  "stale",
  "start_apply",
  "apply_save_failed",
  "retry_apply_save",
  "abandon_apply",
  "authorize_undo",
  "undo_save_failed",
  "retry_undo_save",
  "abandon_undo",
  "recover_operation",
]);
const patchBodySchema = z.strictObject({
  action: actionSchema,
  expectedStatusVersion: z.number().int().nonnegative(),
  expectedOperationVersion: z.number().int().nonnegative(),
  operationClientId: z.string().uuid().optional(),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  failureCode: z.enum([
    "core_validation_failed",
    "reload_failed",
    "snapshot_upload_failed",
    "revision_conflict",
    "undo_conflict",
    "apply_rolled_back",
    "undo_rolled_back",
    "operation_recovered",
  ]).optional(),
});

interface RouteContext {
  params: Promise<{ draftId: string; suggestionId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireDocumentAgentFeature();
    const { draftId, suggestionId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = patchBodySchema.parse(await readLimitedJson(request));
    const data = await transitionDocumentAgentSuggestion({
      draftId,
      suggestionId,
      access,
      action: body.action,
      expectedStatusVersion: body.expectedStatusVersion,
      expectedOperationVersion: body.expectedOperationVersion,
      ...(body.operationClientId ? { operationClientId: body.operationClientId } : {}),
      ...(body.documentSha256 ? { documentSha256: body.documentSha256 } : {}),
      ...(body.failureCode ? { failureCode: body.failureCode } : {}),
    });
    return NextResponse.json<ActionResult<DocumentAgentSuggestionDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<DocumentAgentSuggestionDto>(error, {
      code: "document_agent_transition_failed",
      message: "문서 작성 제안 상태를 변경하지 못했습니다.",
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
