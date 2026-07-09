import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  DocumentDraftError,
  patchGrantDocumentDraftFieldAnswers,
} from "@/lib/server/documents/grantDocumentDrafts";
import {
  type DraftFieldAnswers,
  type DraftFieldAnswerStatus,
  FIELD_ANSWERS_MAX_ENTRIES,
  isDraftFieldAnswerStatus,
} from "@/lib/server/documents/fieldAnswers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALUE_MAX_LENGTH = 4000;

interface RouteContext {
  params: Promise<{
    draftId: string;
  }>;
}

interface FieldAnswersPatchData {
  fieldAnswers: DraftFieldAnswers;
  filledFields: Record<string, string>;
}

/**
 * 필드 답변 저장 (§7.1 / P2-4).
 * body: { answers: Record<label, { value?: string; status }> }
 * → 200 { ok: true, data: { fieldAnswers, filledFields } }  (서버가 filledFields 파생 갱신 후 반환)
 * 검증: label 당 value ≤ 4,000자, answers ≤ 200개, status enum. draft 소유권(companyId) — 불일치 404.
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess({ permission: "write" });
    const answers = parseFieldAnswersBody(await readJson(request));
    const data = await patchGrantDocumentDraftFieldAnswers({ draftId, access, answers });
    return NextResponse.json<ActionResult<FieldAnswersPatchData>>({ ok: true, data });
  } catch (error) {
    return webActionError<FieldAnswersPatchData>(error, {
      code: "field_answers_update_failed",
      message: "필드 답변을 저장하지 못했습니다.",
    });
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DocumentDraftError("invalid_request_body", "요청 본문을 해석하지 못했습니다.", 400);
  }
}

function parseFieldAnswersBody(
  body: unknown,
): Record<string, { value?: string; status: DraftFieldAnswerStatus }> {
  if (typeof body !== "object" || body === null) {
    throw new DocumentDraftError("invalid_request_body", "요청 본문이 올바르지 않습니다.", 400);
  }
  const answersRaw = (body as Record<string, unknown>).answers;
  if (typeof answersRaw !== "object" || answersRaw === null || Array.isArray(answersRaw)) {
    throw new DocumentDraftError("invalid_answers", "answers 는 객체여야 합니다.", 400, "answers");
  }

  const entries = Object.entries(answersRaw as Record<string, unknown>);
  if (entries.length > FIELD_ANSWERS_MAX_ENTRIES) {
    throw new DocumentDraftError(
      "too_many_answers",
      `한 번에 저장할 수 있는 항목은 ${FIELD_ANSWERS_MAX_ENTRIES}개까지입니다.`,
      400,
      "answers",
    );
  }

  const parsed: Record<string, { value?: string; status: DraftFieldAnswerStatus }> = {};
  for (const [label, raw] of entries) {
    if (typeof label !== "string" || label.trim().length === 0) continue;
    if (typeof raw !== "object" || raw === null) {
      throw new DocumentDraftError("invalid_answer_entry", "answer 항목이 올바르지 않습니다.", 400, "answers");
    }
    const record = raw as Record<string, unknown>;
    if (!isDraftFieldAnswerStatus(record.status)) {
      throw new DocumentDraftError(
        "invalid_answer_status",
        "answer status 값이 올바르지 않습니다.",
        400,
        "status",
      );
    }
    const entry: { value?: string; status: DraftFieldAnswerStatus } = { status: record.status };
    if (record.value !== undefined) {
      if (typeof record.value !== "string") {
        throw new DocumentDraftError("invalid_answer_value", "answer value 는 문자열이어야 합니다.", 400, "value");
      }
      if (record.value.length > VALUE_MAX_LENGTH) {
        throw new DocumentDraftError(
          "answer_value_too_long",
          `answer value 는 ${VALUE_MAX_LENGTH}자까지 입력할 수 있습니다.`,
          400,
          "value",
        );
      }
      entry.value = record.value;
    }
    parsed[label] = entry;
  }

  return parsed;
}
