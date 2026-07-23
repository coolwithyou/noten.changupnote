import { adminData, adminError } from "@/lib/server/http/envelope";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole";
import { REVIEW_WORKSPACE_ROLES } from "@/lib/auth/routeAccess";
import {
  DispatchReviewError,
  listReviewQueue,
} from "@/lib/server/review/dispatchReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAnyAdminRole(session, REVIEW_WORKSPACE_ROLES);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? 100);
    return adminData(await listReviewQueue(session, {
      week: params.get("week"),
      limit: Number.isInteger(limit) ? limit : 100,
    }));
  } catch (error) {
    return reviewError(error, "review_queue_failed", "검수 큐를 불러오지 못했습니다.");
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
