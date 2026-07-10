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
    const q = params.get("q");
    const cursor = params.get("cursor");
    const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    const sql = getAdminSql();
    const orders = await sql`
      SELECT o.*, u.email as user_email, u.name as user_name
      FROM credit_payment_orders o
      JOIN users u ON u.id = o.user_id
      WHERE (${status ?? null}::text IS NULL OR o.status = ${status ?? null})
        AND (${q ?? null}::text IS NULL OR o.payment_id ILIKE '%'||${q ?? null}||'%')
        AND (${cursor ?? null}::timestamptz IS NULL OR o.created_at < ${cursor ?? null}::timestamptz)
      ORDER BY o.created_at DESC LIMIT ${limit}
    `;

    const last = orders[orders.length - 1];
    const nextCursor =
      orders.length === limit && last ? new Date(last.created_at as string).toISOString() : null;

    return adminData({ orders, nextCursor });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
