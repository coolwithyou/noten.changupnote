import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { adminData, adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const cursor = params.get("cursor");
    const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    const sql = getAdminSql();
    const subscriptions = await sql`
      SELECT s.*, u.email, u.name, p.name as plan_name, p.monthly_price_krw, p.monthly_credits
      FROM credit_plan_subscriptions s
      JOIN users u ON u.id = s.user_id
      JOIN credit_plans p ON p.id = s.plan_id
      WHERE (${status ?? null}::text IS NULL OR s.status = ${status ?? null})
        AND (${cursor ?? null}::timestamptz IS NULL OR s.created_at < ${cursor ?? null}::timestamptz)
      ORDER BY s.created_at DESC LIMIT ${limit}
    `;

    const last = subscriptions[subscriptions.length - 1];
    const nextCursor =
      subscriptions.length === limit && last
        ? new Date(last.created_at as string).toISOString()
        : null;

    return adminData({ subscriptions, nextCursor });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
