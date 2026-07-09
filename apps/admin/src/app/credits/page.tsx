import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "./CreditsNav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TextRow = { t: string };

function num(v: string | null | undefined): number {
  return Number(v ?? "0");
}

function fmtNum(n: number): string {
  if (!n) return "—";
  return n.toLocaleString("ko-KR");
}

function fmtKrw(n: number): string {
  if (!n) return "—";
  return `₩${n.toLocaleString("ko-KR")}`;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export default async function CreditsDashboardPage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const sql = getAdminSql();

  const today = startOfToday();
  const monthStart = startOfMonth();

  const [
    monthlyChargeKrw,
    todayChargeKrw,
    monthlyIssued,
    monthlyConsumed,
    activeSubs,
    pastDueSubs,
    unusedCredits,
    expiringSoon,
    monthlyRefundKrw,
    adminGrantToday,
  ] = await Promise.all([
    sql<TextRow[]>`SELECT COALESCE(SUM(amount_krw),0)::text t FROM credit_payment_orders WHERE status='paid' AND paid_at >= ${monthStart}`,
    sql<TextRow[]>`SELECT COALESCE(SUM(amount_krw),0)::text t FROM credit_payment_orders WHERE status='paid' AND paid_at >= ${today}`,
    sql<TextRow[]>`SELECT COALESCE(SUM(amount_credits),0)::text t FROM credit_ledger WHERE amount_credits > 0 AND created_at >= ${monthStart}`,
    sql<TextRow[]>`SELECT COALESCE(SUM(ABS(amount_credits)),0)::text t FROM credit_ledger WHERE amount_credits < 0 AND created_at >= ${monthStart}`,
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM credit_plan_subscriptions WHERE status='active'`,
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM credit_plan_subscriptions WHERE status='past_due'`,
    sql<TextRow[]>`SELECT COALESCE(SUM(remaining_credits),0)::text t FROM credit_lots WHERE status='active'`,
    sql<TextRow[]>`SELECT COALESCE(SUM(remaining_credits),0)::text t FROM credit_lots WHERE status='active' AND expires_at <= now() + interval '30 days'`,
    sql<TextRow[]>`SELECT COALESCE(SUM(refunded_amount_krw),0)::text t FROM credit_payment_orders WHERE refunded_amount_krw > 0 AND updated_at >= ${monthStart}`,
    sql<TextRow[]>`SELECT COALESCE(SUM(amount_credits),0)::text t FROM credit_ledger WHERE entry_type IN ('admin_grant','promo_grant') AND created_at >= ${today}`,
  ]);

  const metrics: Array<{ label: string; value: string }> = [
    { label: "이달 결제액 (KRW)", value: fmtKrw(num(monthlyChargeKrw[0]?.t)) },
    { label: "오늘 결제액 (KRW)", value: fmtKrw(num(todayChargeKrw[0]?.t)) },
    { label: "이달 발행 크레딧", value: fmtNum(num(monthlyIssued[0]?.t)) },
    { label: "이달 소비 크레딧", value: fmtNum(num(monthlyConsumed[0]?.t)) },
    { label: "활성 구독", value: fmtNum(num(activeSubs[0]?.t)) },
    { label: "연체 구독 (past_due)", value: fmtNum(num(pastDueSubs[0]?.t)) },
    { label: "미사용 크레딧 (active lot)", value: fmtNum(num(unusedCredits[0]?.t)) },
    { label: "30일내 만료 예정", value: fmtNum(num(expiringSoon[0]?.t)) },
    { label: "이달 환불액 (KRW)", value: fmtKrw(num(monthlyRefundKrw[0]?.t)) },
    { label: "오늘 관리자 지급", value: fmtNum(num(adminGrantToday[0]?.t)) },
  ];

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">크레딧 운영 대시보드</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <ul className="ops-metric-grid">
          {metrics.map((m) => (
            <li key={m.label}>
              <strong>{m.value}</strong>
              <span>{m.label}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
