import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { requireFieldEditorAgentFeature } from "@/lib/server/documents/documentAgentAvailability";
import {
  transitionFieldAgentSuggestion,
  type FieldAgentSuggestionDto,
} from "@/lib/server/documents/fieldAgentRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  action: z.enum(["start_apply", "authorize_undo", "dismiss", "abandon_apply", "abandon_undo"]),
  expectedStatusVersion: z.number().int().nonnegative(),
  expectedOperationVersion: z.number().int().nonnegative(),
  operationClientId: z.string().uuid().optional(),
  failureCode: z.string().trim().min(1).max(100).optional(),
});

interface RouteContext {
  params: Promise<{ draftId: string; suggestionId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireFieldEditorAgentFeature();
    const { draftId, suggestionId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = bodySchema.parse(await request.json());
    const data = await transitionFieldAgentSuggestion({
      draftId,
      suggestionId,
      access,
      action: body.action,
      expectedStatusVersion: body.expectedStatusVersion,
      expectedOperationVersion: body.expectedOperationVersion,
      ...(body.operationClientId ? { operationClientId: body.operationClientId } : {}),
      ...(body.failureCode ? { failureCode: body.failureCode } : {}),
    });
    return NextResponse.json<ActionResult<FieldAgentSuggestionDto>>({ ok: true, data });
  } catch (error) {
    return webActionError<FieldAgentSuggestionDto>(error, {
      code: "field_agent_transition_failed",
      message: "AI 필드 제안 상태를 변경하지 못했습니다.",
    });
  }
}
