import type { ActionResult, FeedbackResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  buildFeedbackResult,
  buildSubmitFeedbackInput,
  decodeGrantIdSegment,
  readMatchFeedbackRequest,
} from "@/lib/server/matches/matchFeedback";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    grantId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ grantId }, body, access] = await Promise.all([
      context.params,
      readMatchFeedbackRequest(request),
      requireCompanyAccess({ permission: "write" }),
    ]);
    const input = buildSubmitFeedbackInput({
      companyId: access.companyId,
      grantId: decodeGrantIdSegment(grantId),
      userId: access.userId,
      body,
    });
    const receipt = await getServiceRepositories().feedback.submitFeedback(input);

    return NextResponse.json<ActionResult<FeedbackResult>>({
      ok: true,
      data: buildFeedbackResult(receipt),
    }, { status: 202 });
  } catch (error) {
    return webActionError<FeedbackResult>(error, {
      code: "match_feedback_failed",
      message: "피드백을 저장하지 못했습니다.",
    });
  }
}
