import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { adminData, adminError } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GROUP_BY = ["feature", "model", "day"] as const;
type GroupBy = (typeof GROUP_BY)[number];

function isGroupBy(value: string | null): value is GroupBy {
  return value !== null && (GROUP_BY as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const params = new URL(request.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");
    const groupByRaw = params.get("groupBy");
    const groupBy: GroupBy = isGroupBy(groupByRaw) ? groupByRaw : "feature";

    const sql = getAdminSql();
    let raw: ReadonlyArray<Record<string, unknown>>;

    if (groupBy === "model") {
      raw = await sql`
        SELECT model, COUNT(*)::text as count,
          COALESCE(SUM(credits_charged),0)::text as total_credits,
          COALESCE(SUM(provider_cost_usd_micros),0)::text as total_cost_micros
        FROM usage_events
        WHERE status IN ('settled','free')
          AND (${from ?? null}::timestamptz IS NULL OR created_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR created_at <= ${to ?? null}::timestamptz)
        GROUP BY model ORDER BY COALESCE(SUM(credits_charged),0) DESC
      `;
    } else if (groupBy === "day") {
      raw = await sql`
        SELECT created_at::date as day, COUNT(*)::text as count,
          COALESCE(SUM(credits_charged),0)::text as total_credits
        FROM usage_events
        WHERE status IN ('settled','free')
          AND (${from ?? null}::timestamptz IS NULL OR created_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR created_at <= ${to ?? null}::timestamptz)
        GROUP BY created_at::date ORDER BY day
      `;
    } else {
      raw = await sql`
        SELECT feature_code, COUNT(*)::text as count,
          COALESCE(SUM(credits_charged),0)::text as total_credits,
          COALESCE(SUM(provider_cost_usd_micros),0)::text as total_cost_micros
        FROM usage_events
        WHERE status IN ('settled','free')
          AND (${from ?? null}::timestamptz IS NULL OR created_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR created_at <= ${to ?? null}::timestamptz)
        GROUP BY feature_code ORDER BY COALESCE(SUM(credits_charged),0) DESC
      `;
    }

    const rows = raw.map((row) => {
      const out: Record<string, unknown> = { ...row };
      if (typeof row.count === "string") out.count = Number(row.count);
      if (typeof row.total_credits === "string") out.total_credits = Number(row.total_credits);
      if (typeof row.total_cost_micros === "string") {
        out.total_cost_micros = Number(row.total_cost_micros);
      }
      return out;
    });

    return adminData({ groupBy, rows });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
