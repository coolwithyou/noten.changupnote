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

  // 단일 사용자 1시간 차감 임계(12.7) — settings usage_anomaly_hourly_credits(기본 100,000).
  const anomalyThresholdRows = await sql<TextRow[]>`
    SELECT COALESCE((value->>'value')::bigint, 100000)::text t FROM credit_settings WHERE key = 'usage_anomaly_hourly_credits'
  `;
  const hourlyAnomalyThreshold = num(anomalyThresholdRows[0]?.t) || 100000;
  const companyMemberThresholdRows = await sql<TextRow[]>`
    SELECT COALESCE((value->>'value')::int, 5)::text t FROM credit_settings WHERE key = 'company_new_member_threshold'
  `;
  const companyMemberThreshold = num(companyMemberThresholdRows[0]?.t) || 5;
  const companyMemberWindowRows = await sql<TextRow[]>`
    SELECT COALESCE((value->>'value')::int, 7)::text t FROM credit_settings WHERE key = 'company_new_member_window_days'
  `;
  const companyMemberWindow = num(companyMemberWindowRows[0]?.t) || 7;

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
    // ── 이상 신호(11.1) 실데이터 ──────────────────────────────────────
    shortfallToday,
    captureAfterExpiryToday,
    pendingUsageStuck,
    reconMismatchToday,
    refundFrequentUsers,
    companyMemberSurges,
    hourlyDeductBreaches,
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
    // shortfall 발생 건수(당일).
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM credit_audit_logs WHERE action='usage.shortfall' AND created_at >= ${today}`,
    // capture_after_expiry 건수(당일) — hold_ttl 조정 신호.
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM credit_audit_logs WHERE action='usage.capture_after_expiry' AND created_at >= ${today}`,
    // pending usage(정산 미확정 — hold 가 released/expired 인데 usage 가 pending).
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM usage_events ue WHERE ue.status='pending' AND EXISTS (SELECT 1 FROM credit_holds h WHERE h.usage_event_id = ue.id AND h.status IN ('released','expired'))`,
    // 대사 mismatch(당일 run 중 mismatch scope 수).
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM credit_reconciliation_runs WHERE status='mismatch' AND created_at >= ${today}`,
    // 기간(30일) 내 환불 2회 이상 사용자 수(13.2).
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM (SELECT o.user_id FROM credit_payment_orders o WHERE o.refunded_amount_krw > 0 AND o.updated_at >= now() - interval '30 days' GROUP BY o.user_id HAVING COUNT(*) >= 2) s`,
    // 동일 companyId 신규 멤버 급증(13.1) — 창 내 임계 초과 회사 수.
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM (SELECT company_id FROM user_company WHERE created_at >= now() - (${companyMemberWindow}::int || ' days')::interval GROUP BY company_id HAVING COUNT(*) > ${companyMemberThreshold}::int) s`,
    // 단일 사용자 1시간 차감 임계 초과 지갑 수(12.7).
    sql<TextRow[]>`SELECT COUNT(*)::text t FROM (SELECT wallet_id FROM credit_ledger WHERE amount_credits < 0 AND created_at >= now() - interval '1 hour' GROUP BY wallet_id HAVING SUM(ABS(amount_credits)) > ${hourlyAnomalyThreshold}::bigint) s`,
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

  // 이상 신호(11.1) — 0 이 아니면 위험(danger) 강조.
  const anomalies: Array<{ label: string; value: number; hint?: string }> = [
    { label: "오늘 shortfall 발생", value: num(shortfallToday[0]?.t), hint: "lot 부족으로 실차감<요율. 미수액 발생" },
    { label: "오늘 capture_after_expiry", value: num(captureAfterExpiryToday[0]?.t), hint: "빈발 시 hold_ttl 상향 검토" },
    { label: "미정산 pending usage", value: num(pendingUsageStuck[0]?.t), hint: "hold released/expired 인데 usage pending — 수동 정산 후보" },
    { label: "오늘 대사 mismatch", value: num(reconMismatchToday[0]?.t), hint: "대사 리포트에서 상세 확인" },
    { label: "past_due 구독", value: num(pastDueSubs[0]?.t) },
    { label: "오늘 관리자 지급 총량", value: num(adminGrantToday[0]?.t), hint: "급증 시 내부자 통제 점검" },
    { label: "환불 2회+ 사용자 (30일)", value: num(refundFrequentUsers[0]?.t), hint: "환불 어뷰징 관찰(13.2)" },
    { label: `동일 회사 신규 급증 (${companyMemberWindow}일 >${companyMemberThreshold}인)`, value: num(companyMemberSurges[0]?.t), hint: "가입 보너스 파밍 신호(13.1)" },
    { label: `1시간 차감 임계 초과 (>${fmtNum(hourlyAnomalyThreshold)})`, value: num(hourlyDeductBreaches[0]?.t), hint: "단일 사용자 이상 소모(12.7)" },
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

      <section className="ops-section">
        <h2 className="ops-subtitle">이상 신호</h2>
        <ul className="ops-metric-grid">
          {anomalies.map((a) => (
            <li key={a.label}>
              <strong>
                {fmtNum(a.value)}{" "}
                {a.value > 0 ? <span className="ops-badge danger">확인 필요</span> : <span className="ops-badge success">정상</span>}
              </strong>
              <span>{a.label}</span>
              {a.hint ? <em className="ops-note">{a.hint}</em> : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
