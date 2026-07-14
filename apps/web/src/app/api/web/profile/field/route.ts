import type { ActionResult, MatchingProfileAnswerRequest } from "@cunote/contracts";
import { NextRequest, NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  applyCompanyProfileAnswer,
  type ApplyCompanyProfileAnswerResult,
} from "@/lib/server/productProfile/applyCompanyProfileAnswer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProfileFieldRequest {
  field?: MatchingProfileAnswerRequest["field"];
  value?: unknown;
  mode?: MatchingProfileAnswerRequest["mode"];
  questionSessionId?: string;
  unknown?: boolean;
  range?: MatchingProfileAnswerRequest["range"];
}

export async function POST(request: NextRequest) {
  try {
    const [access, body] = await Promise.all([
      requireCompanyAccess({ permission: "write" }),
      readBody(request),
    ]);
    const questionSessionId = validUuid(body.questionSessionId) ??
      validUuid(request.cookies.get("cunote_question_session")?.value) ??
      crypto.randomUUID();
    const data = await applyCompanyProfileAnswer({
      companyId: access.companyId,
      userId: access.userId,
      answer: toAnswer(body),
      questionSessionId,
      asOf: new Date(),
    });

    const response = NextResponse.json<ActionResult<ApplyCompanyProfileAnswerResult>>({ ok: true, data });
    response.cookies.set("cunote_question_session", data.event.sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 60,
    });
    return response;
  } catch (error) {
    return webActionError<ApplyCompanyProfileAnswerResult>(error, {
      code: "profile_field_failed",
      message: "회사 프로필 입력을 저장하지 못했습니다.",
    });
  }
}

function toAnswer(body: ProfileFieldRequest): MatchingProfileAnswerRequest {
  const answer = { field: body.field } as unknown as MatchingProfileAnswerRequest;
  if (Object.hasOwn(body, "value")) answer.value = body.value;
  if (body.mode !== undefined) answer.mode = body.mode;
  if (body.unknown !== undefined) answer.unknown = body.unknown;
  if (body.range !== undefined) answer.range = body.range;
  return answer;
}

async function readBody(request: Request): Promise<ProfileFieldRequest> {
  try {
    const parsed = await request.json() as ProfileFieldRequest;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validUuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
