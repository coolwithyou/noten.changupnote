import type { MatchingProfileAnswerRequest } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { applyCompanyProfileAnswer } from "@/lib/server/productProfile/applyCompanyProfileAnswer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

interface ProfileFieldRequest {
  field?: MatchingProfileAnswerRequest["field"];
  value?: unknown;
  mode?: MatchingProfileAnswerRequest["mode"];
  questionSessionId?: string;
  unknown?: boolean;
  range?: MatchingProfileAnswerRequest["range"];
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId, { permission: "write" });
    const data = await applyCompanyProfileAnswer({
      companyId,
      userId: access.userId,
      answer: toAnswer(body),
      ...(body.questionSessionId ? { questionSessionId: body.questionSessionId } : {}),
      asOf: new Date(),
    });
    return appData(data);
  } catch (error) {
    return appErrorFromUnknown(error, "회사 프로필 입력을 저장하지 못했습니다.");
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
