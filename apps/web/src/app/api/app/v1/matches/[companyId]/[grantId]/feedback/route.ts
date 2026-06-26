import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
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
  params: Promise<{ companyId: string; grantId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId, grantId }, body] = await Promise.all([context.params, readMatchFeedbackRequest(request)]);
    const access = await requireAppCompanyAccess(request, companyId);
    const input = buildSubmitFeedbackInput({
      companyId,
      grantId: decodeGrantIdSegment(grantId),
      userId: access.userId,
      body,
    });
    const receipt = await getServiceRepositories().feedback.submitFeedback(input);
    return appData(buildFeedbackResult(receipt), { status: 202 });
  } catch (error) {
    return appErrorFromUnknown(error, "피드백을 저장하지 못했습니다.");
  }
}
