import { adminData, adminError } from "@/lib/server/http/envelope";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole";
import { REVIEW_WORKSPACE_ROLES } from "@/lib/auth/routeAccess";
import {
  DispatchReviewError,
  getReviewNotice,
} from "@/lib/server/review/dispatchReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAnyAdminRole(session, REVIEW_WORKSPACE_ROLES);
    const { id } = await context.params;
    return adminData(await getReviewNotice(session, id));
  } catch (error) {
    return reviewError(error, "review_notice_failed", "검수 공고를 불러오지 못했습니다.");
  }
}

function reviewError(error: unknown, code: string, fallback: string): Response {
  if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
  const roleError = handleRoleError(error);
  if (roleError) return roleError;
  if (error instanceof DispatchReviewError) {
    return adminError(error.code, error.message, error.status, error.field);
  }
  return adminError(code, error instanceof Error ? error.message : fallback);
}
