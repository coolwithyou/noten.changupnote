import type { NextRequest } from "next/server";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  wallet_id: string | null;
  balance_credits: number | null;
  wallet_status: string | null;
  frozen_reason: string | null;
  updated_at: Date | null;
  has_subscription: string;
  created_at: Date;
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    const cursor = url.searchParams.get("cursor");
    const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    const sql = getAdminSql();
    const rows = await sql<MemberRow[]>`
      SELECT u.id, u.email, u.name, w.id as wallet_id, w.balance_credits, w.status as wallet_status,
             w.frozen_reason, w.updated_at,
             (SELECT COUNT(*) FROM credit_plan_subscriptions
              WHERE user_id = u.id AND status IN ('active','past_due')) as has_subscription,
             u.created_at
      FROM users u
      LEFT JOIN credit_wallets w ON w.user_id = u.id
      WHERE (${q} = '' OR u.email ILIKE '%'||${q}||'%' OR u.name ILIKE '%'||${q}||'%')
        AND (${cursor ?? null}::timestamptz IS NULL OR u.created_at < ${cursor ?? null}::timestamptz)
      ORDER BY u.created_at DESC
      LIMIT ${limit}
    `;

    const members = rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      walletId: r.wallet_id,
      balanceCredits: r.balance_credits ?? 0,
      walletStatus: r.wallet_status,
      frozenReason: r.frozen_reason,
      updatedAt: r.updated_at,
      hasSubscription: Number(r.has_subscription ?? "0") > 0,
      createdAt: r.created_at,
    }));

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last ? new Date(last.created_at).toISOString() : null;

    return adminData({ members, nextCursor });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
