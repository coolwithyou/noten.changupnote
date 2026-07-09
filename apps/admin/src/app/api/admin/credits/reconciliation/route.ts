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
    const date = params.get("date");

    const sql = getAdminSql();
    const runs = await sql`
      SELECT * FROM credit_reconciliation_runs
      WHERE (${date ?? null}::date IS NULL OR run_date::date = ${date ?? null}::date)
      ORDER BY created_at DESC LIMIT 50
    `;

    return adminData({ runs });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
