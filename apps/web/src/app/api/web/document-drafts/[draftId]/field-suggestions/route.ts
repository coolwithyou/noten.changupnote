/**
 * 생성형 필드 제안 라우트 (Apply Experience v2 · §7.4 · P4-1).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §7.4(v2.4)·ADR-3/7/8.
 *
 * POST /api/web/document-drafts/[draftId]/field-suggestions
 * body: { labels: string[]; mode: "generate" | "regenerate"; currentValue?: string }
 * → 200 { ok: true, data: { suggestions: Record<label, { value, basis }> } }
 *
 * - runtime nodejs · force-dynamic · requireCompanyAccess({permission:"write"})(제안 생성·저장 = 변이).
 * - draft 소유권(companyId 불일치)은 404(generateFieldSuggestions 내부 getGrantDocumentDraft 가 집행).
 * - suggestions 는 **서버 저장 후의 fieldAnswers 에서 재구성**(저장-반환 일치, 컨펌 게이트 — §7.4).
 * - basis 없는/실재 불통과/manual류 제안은 반환·저장되지 않는다(fieldSuggest.ts 가 집행).
 * - 예산은 채팅과 합산(ADR-6): 초과 시 429 { code:"chat_budget_exceeded" }.
 */
import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  FieldSuggestError,
  generateFieldSuggestions,
  type FieldSuggestResult,
} from "@/lib/server/documents/fieldSuggest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CURRENT_VALUE_MAX_LENGTH = 4000;
const LABEL_MAX_LENGTH = 160;

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

interface ParsedBody {
  labels: string[];
  mode: "generate" | "regenerate";
  currentValue?: string;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const body = parseBody(await readJson(request));
    const data = await generateFieldSuggestions({
      draftId,
      access,
      labels: body.labels,
      mode: body.mode,
      ...(body.currentValue !== undefined ? { currentValue: body.currentValue } : {}),
    });
    return NextResponse.json<ActionResult<FieldSuggestResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<FieldSuggestResult>(error, {
      code: "field_suggestions_failed",
      message: "필드 제안을 생성하지 못했습니다.",
    });
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new FieldSuggestError("invalid_request_body", "요청 본문을 해석하지 못했습니다.", 400);
  }
}

function parseBody(body: unknown): ParsedBody {
  if (typeof body !== "object" || body === null) {
    throw new FieldSuggestError("invalid_request_body", "요청 본문이 올바르지 않습니다.", 400);
  }
  const record = body as Record<string, unknown>;

  const labelsRaw = record.labels;
  if (!Array.isArray(labelsRaw)) {
    throw new FieldSuggestError("invalid_labels", "labels 는 배열이어야 합니다.", 400);
  }
  const labels: string[] = [];
  for (const item of labelsRaw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, LABEL_MAX_LENGTH);
    if (trimmed) labels.push(trimmed);
  }
  if (labels.length === 0) {
    throw new FieldSuggestError("invalid_labels", "제안할 항목(labels)이 필요합니다.", 400);
  }

  const modeRaw = record.mode;
  if (modeRaw !== "generate" && modeRaw !== "regenerate") {
    throw new FieldSuggestError("invalid_mode", "mode 는 generate 또는 regenerate 여야 합니다.", 400);
  }

  const parsed: ParsedBody = { labels, mode: modeRaw };

  const currentValueRaw = record.currentValue;
  if (currentValueRaw !== undefined) {
    if (typeof currentValueRaw !== "string") {
      throw new FieldSuggestError("invalid_current_value", "currentValue 는 문자열이어야 합니다.", 400);
    }
    if (currentValueRaw.length > CURRENT_VALUE_MAX_LENGTH) {
      throw new FieldSuggestError(
        "current_value_too_long",
        `currentValue 는 ${CURRENT_VALUE_MAX_LENGTH}자까지 보낼 수 있습니다.`,
        400,
      );
    }
    parsed.currentValue = currentValueRaw;
  }

  return parsed;
}
