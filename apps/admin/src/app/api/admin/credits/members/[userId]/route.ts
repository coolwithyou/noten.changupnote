import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ userId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const { userId } = await context.params;
    if (!userId) return adminError("invalid_route_param", "요청 경로를 확인해주세요.", 400);

    const sql = getAdminSql();

    const [userRows, walletRows] = await Promise.all([
      sql<{ id: string; email: string; name: string | null; created_at: Date }[]>`
        SELECT id, email, name, created_at FROM users WHERE id = ${userId}
      `,
      sql<Record<string, unknown>[]>`
        SELECT * FROM credit_wallets WHERE user_id = ${userId}
      `,
    ]);

    const user = userRows[0] ?? null;
    if (!user) return adminError("member_not_found", "회원을 찾을 수 없습니다.", 404);

    const wallet = walletRows[0] ?? null;

    let lots: Record<string, unknown>[] = [];
    let ledger: Record<string, unknown>[] = [];
    let holds: Record<string, unknown>[] = [];
    let orders: Record<string, unknown>[] = [];
    let subscriptions: Record<string, unknown>[] = [];
    let auditLogs: Record<string, unknown>[] = [];

    if (wallet) {
      const walletId = wallet.id as string;
      [lots, ledger, holds, orders, subscriptions, auditLogs] = await Promise.all([
        sql<Record<string, unknown>[]>`
          SELECT * FROM credit_lots WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 20
        `,
        sql<Record<string, unknown>[]>`
          SELECT * FROM credit_ledger WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 50
        `,
        sql<Record<string, unknown>[]>`
          SELECT * FROM credit_holds WHERE wallet_id = ${walletId} AND status='pending'
        `,
        sql<Record<string, unknown>[]>`
          SELECT * FROM credit_payment_orders WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 10
        `,
        sql<Record<string, unknown>[]>`
          SELECT cps.*, cp.name as plan_name, cp.monthly_price_krw, cp.monthly_credits
          FROM credit_plan_subscriptions cps
          JOIN credit_plans cp ON cp.id = cps.plan_id
          WHERE cps.wallet_id = ${walletId}
          ORDER BY cps.created_at DESC LIMIT 5
        `,
        sql<Record<string, unknown>[]>`
          SELECT * FROM credit_audit_logs
          WHERE target_id = ${walletId} OR target_id = ${userId}
          ORDER BY created_at DESC LIMIT 20
        `,
      ]);
    } else {
      auditLogs = await sql<Record<string, unknown>[]>`
        SELECT * FROM credit_audit_logs WHERE target_id = ${userId} ORDER BY created_at DESC LIMIT 20
      `;
    }

    // 회원 지갑 상세 열람은 감사 대상.
    await insertCreditAuditLog({
      action: "member.viewed",
      actorSession: session,
      targetType: "user",
      targetId: userId,
    });

    return adminData({
      user,
      wallet,
      lots,
      ledger,
      holds,
      orders,
      subscriptions,
      auditLogs,
    });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
