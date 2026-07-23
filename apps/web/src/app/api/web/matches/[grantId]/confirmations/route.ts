import type {
  ActionResult,
  GrantConfirmationSubmitResult,
  GrantConfirmationsResult,
} from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  ConfirmationRequestError,
  listGrantConfirmations,
  submitGrantConfirmations,
} from "@/lib/server/matches/grantConfirmations";
import type { ConfirmationAnswerInput } from "@/lib/server/matches/grantConfirmationAnswers";
import { decodeGrantIdSegment } from "@/lib/server/matches/matchFeedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ grantId }, access] = await Promise.all([
      context.params,
      requireCompanyAccess(),
    ]);
    const data = await listGrantConfirmations({
      companyId: access.companyId,
      grantId: decodeGrantIdSegment(grantId),
    });
    return NextResponse.json<ActionResult<GrantConfirmationsResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<GrantConfirmationsResult>(error, {
      code: "grant_confirmations_failed",
      message: "확인 질문을 불러오지 못했습니다.",
    });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const [{ grantId }, body, access] = await Promise.all([
      context.params,
      readAnswers(request),
      requireCompanyAccess({ permission: "write" }),
    ]);
    const data = await submitGrantConfirmations({
      companyId: access.companyId,
      userId: access.userId,
      grantId: decodeGrantIdSegment(grantId),
      answers: body,
      asOf: new Date(),
    });
    return NextResponse.json<ActionResult<GrantConfirmationSubmitResult>>({ ok: true, data });
  } catch (error) {
    return webActionError<GrantConfirmationSubmitResult>(error, {
      code: "grant_confirmations_save_failed",
      message: "확인 답변을 저장하지 못했습니다.",
    });
  }
}

/** 본문 {answers:[{questionId, values}]} 의 구조만 여기서 거른다 — 의미 검증은 순수 로직이 담당. */
async function readAnswers(request: Request): Promise<ConfirmationAnswerInput[]> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfirmationRequestError("invalid_confirmation_body", "answers가 필요합니다.", 400, "answers");
  }
  const answers = (parsed as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) {
    throw new ConfirmationRequestError("invalid_confirmation_body", "answers가 필요합니다.", 400, "answers");
  }
  return answers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfirmationRequestError(
        "invalid_confirmation_answer",
        "답변 형식이 올바르지 않습니다.",
        400,
        "answers",
      );
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.questionId !== "string" || !Array.isArray(candidate.values)) {
      throw new ConfirmationRequestError(
        "invalid_confirmation_answer",
        "답변 형식이 올바르지 않습니다.",
        400,
        "answers",
      );
    }
    return {
      questionId: candidate.questionId,
      values: candidate.values.filter((value): value is string => typeof value === "string"),
    };
  });
}
