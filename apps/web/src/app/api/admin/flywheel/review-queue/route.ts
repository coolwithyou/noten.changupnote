import { appData, appError } from "@/lib/server/appApi/envelope";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import {
  AdminReviewQueueError,
  getAdminReviewQueue,
  promoteReviewFeedbackToGoldenSet,
} from "@/lib/server/admin/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdminAccess();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const queue = await getAdminReviewQueue(Number.isFinite(limit) ? limit : 20);
    return appData(queue);
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_review_queue_failed", error instanceof Error ? error.message : "리뷰 큐를 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAdminAccess();
    const body = await readJson(request);
    const feedbackId = stringValue(body.feedbackId);
    if (!feedbackId) return appError("invalid_feedback_id", "피드백 id가 필요합니다.", 400, "feedbackId");
    const result = await promoteReviewFeedbackToGoldenSet({
      feedbackId,
      goldenVer: stringValue(body.goldenVer),
      curatedBy: access.userId,
    });
    return appData(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    if (error instanceof AdminReviewQueueError) {
      return appError(error.code, error.message, error.status);
    }
    return appError(
      "admin_review_promote_failed",
      error instanceof Error ? error.message : "골든셋 후보로 저장하지 못했습니다.",
    );
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
