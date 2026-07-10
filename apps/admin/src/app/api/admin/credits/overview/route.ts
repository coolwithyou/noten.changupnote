import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CountRow = { value: string }[];

export async function GET() {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const sql = getAdminSql();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);

    const [
      todayCharge,
      monthlyCharge,
      monthlyIssued,
      monthlyConsumed,
      activeSubs,
      monthlyRefund,
      unused,
      expiring,
      shortfall,
      pastDue,
      adminGrant,
    ] = await Promise.all([
      sql<CountRow>`SELECT COALESCE(SUM(amount_krw),0)::text as value FROM credit_payment_orders WHERE status='paid' AND paid_at >= ${today}`,
      sql<CountRow>`SELECT COALESCE(SUM(amount_krw),0)::text as value FROM credit_payment_orders WHERE status='paid' AND paid_at >= ${monthStart}`,
      sql<CountRow>`SELECT COALESCE(SUM(amount_credits),0)::text as value FROM credit_ledger WHERE amount_credits > 0 AND created_at >= ${monthStart}`,
      sql<CountRow>`SELECT COALESCE(SUM(ABS(amount_credits)),0)::text as value FROM credit_ledger WHERE amount_credits < 0 AND created_at >= ${monthStart}`,
      sql<CountRow>`SELECT COUNT(*)::text as value FROM credit_plan_subscriptions WHERE status='active'`,
      sql<CountRow>`SELECT COALESCE(SUM(refunded_amount_krw),0)::text as value FROM credit_payment_orders WHERE refunded_amount_krw > 0 AND updated_at >= ${monthStart}`,
      sql<CountRow>`SELECT COALESCE(SUM(remaining_credits),0)::text as value FROM credit_lots WHERE status='active'`,
      sql<CountRow>`SELECT COALESCE(SUM(remaining_credits),0)::text as value FROM credit_lots WHERE status='active' AND expires_at <= now()+interval '30 days'`,
      sql<CountRow>`SELECT COUNT(*)::text as value FROM credit_audit_logs WHERE action='usage.shortfall' AND created_at >= ${today}`,
      sql<CountRow>`SELECT COUNT(*)::text as value FROM credit_plan_subscriptions WHERE status='past_due'`,
      sql<CountRow>`SELECT COALESCE(SUM(amount_credits),0)::text as value FROM credit_ledger WHERE entry_type IN ('admin_grant','promo_grant') AND created_at >= ${today}`,
    ]);

    const num = (rows: CountRow) => Number(rows[0]?.value ?? "0");

    return adminData({
      todayChargeKrw: num(todayCharge),
      monthlyChargeKrw: num(monthlyCharge),
      monthlyIssuedCredits: num(monthlyIssued),
      monthlyConsumedCredits: num(monthlyConsumed),
      activeSubscriptions: num(activeSubs),
      monthlyRefundKrw: num(monthlyRefund),
      unusedCredits: num(unused),
      expiringSoon: num(expiring),
      shortfallToday: num(shortfall),
      pastDueSubscriptions: num(pastDue),
      adminGrantToday: num(adminGrant),
    });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
