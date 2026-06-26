import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string; grantId: string }>;
}

interface FeedbackRequest {
  kind?: "saved" | "dismissed" | "wrong" | "applied" | "note";
  message?: string | null;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId, grantId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireCompanyAccess(companyId);
    const receipt = await getServiceRepositories().feedback.submitFeedback({
      companyId,
      grantId,
      userId: access.userId,
      kind: body.kind ?? "note",
      message: body.message ?? null,
    });
    return appData({ receipt }, { status: 202 });
  } catch (error) {
    return appErrorFromUnknown(error, "피드백을 저장하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<FeedbackRequest> {
  try {
    const parsed = await request.json() as FeedbackRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
