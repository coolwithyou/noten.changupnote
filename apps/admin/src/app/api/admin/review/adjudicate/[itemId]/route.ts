import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole";
import { REVIEW_ADJUDICATION_ROLES } from "@/lib/auth/routeAccess";
import {
  adjudicateConflict,
  DispatchReviewError,
  REVIEW_VERDICTS,
  type ReviewVerdict,
} from "@/lib/server/review/dispatchReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ itemId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAnyAdminRole(session, REVIEW_ADJUDICATION_ROLES);
    const [{ itemId }, body] = await Promise.all([context.params, readJson(request)]);
    const finalVerdict = body.finalVerdict;
    if (typeof finalVerdict !== "string" || !REVIEW_VERDICTS.includes(finalVerdict as ReviewVerdict)) {
      return adminError("invalid_final_verdict", "최종 판정 어휘를 확인해주세요.", 400, "finalVerdict");
    }
    return adminData(await adjudicateConflict(
      session,
      itemId,
      finalVerdict as ReviewVerdict,
      typeof body.note === "string" ? body.note : null,
    ));
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    if (error instanceof DispatchReviewError) {
      return adminError(error.code, error.message, error.status, error.field);
    }
    return adminError(
      "review_adjudication_failed",
      error instanceof Error ? error.message : "3심 판정을 저장하지 못했습니다.",
    );
  }
}
