import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import {
  handleRoleError,
  requireAnyAdminRole,
} from "@/lib/server/auth/adminRole";
import { REVIEW_WORKSPACE_ROLES } from "@/lib/auth/routeAccess";
import {
  DispatchReviewError,
  REVIEW_VERDICTS,
  saveReviewVerdicts,
  type ReviewVerdict,
} from "@/lib/server/review/dispatchReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAnyAdminRole(session, REVIEW_WORKSPACE_ROLES);
    const [{ id }, body] = await Promise.all([context.params, readJson(request)]);
    if (!Array.isArray(body.items)) {
      return adminError("invalid_review_items", "판정 항목 배열이 필요합니다.", 400, "items");
    }
    const items = body.items.map(normalizeVerdict);
    return adminData(await saveReviewVerdicts(session, id, items));
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    if (error instanceof DispatchReviewError) {
      return adminError(error.code, error.message, error.status, error.field);
    }
    return adminError(
      "review_verdict_save_failed",
      error instanceof Error ? error.message : "검수 판정을 저장하지 못했습니다.",
    );
  }
}

function normalizeVerdict(value: unknown): {
  itemId: string;
  humanVerdict: ReviewVerdict;
  note: string | null;
  revision: number;
} {
  if (!value || typeof value !== "object") {
    throw new DispatchReviewError("invalid_review_item", "판정 항목 형식을 확인해주세요.", 400, "items");
  }
  const record = value as Record<string, unknown>;
  const humanVerdict = record.humanVerdict;
  if (typeof humanVerdict !== "string" || !REVIEW_VERDICTS.includes(humanVerdict as ReviewVerdict)) {
    throw new DispatchReviewError("invalid_human_verdict", "판정 어휘를 확인해주세요.", 400, "humanVerdict");
  }
  return {
    itemId: typeof record.itemId === "string" ? record.itemId : "",
    humanVerdict: humanVerdict as ReviewVerdict,
    note: typeof record.note === "string" ? record.note : null,
    revision: typeof record.revision === "number" ? record.revision : Number.NaN,
  };
}
