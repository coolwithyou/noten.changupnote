import { AdminReviewQueueError, getAdminReviewQueue, promoteReviewFeedbackToGoldenSet } from "@/lib/server/admin/reviewQueue";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "viewer");
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return adminData(await getAdminReviewQueue(Number.isFinite(limit) ? limit : 20));
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return adminError("admin_review_queue_failed", error instanceof Error ? error.message : "리뷰 큐를 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "admin");
    const body = await readJson(request);
    const feedbackId = stringValue(body.feedbackId);
    if (!feedbackId) return adminError("invalid_feedback_id", "피드백 id가 필요합니다.", 400, "feedbackId");
    const result = await promoteReviewFeedbackToGoldenSet({
      feedbackId,
      goldenVer: stringValue(body.goldenVer),
      admin,
    });
    return adminData(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    if (error instanceof AdminReviewQueueError) return adminError(error.code, error.message, error.status);
    return adminError(
      "admin_review_promote_failed",
      error instanceof Error ? error.message : "골든셋 후보로 저장하지 못했습니다.",
    );
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
