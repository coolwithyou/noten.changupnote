import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "../CreditsNav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SubRow {
  id: string;
  email: string;
  plan_name: string | null;
  status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  monthly_price_krw: string | null;
}

const STATUS_OPTIONS = ["active", "past_due", "canceled", "paused"];

function fmtKrw(v: string | null | undefined): string {
  const n = Number(v ?? "0");
  if (!n) return "—";
  return `₩${n.toLocaleString("ko-KR")}`;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ko-KR");
}

function statusBadge(status: string | null): string {
  if (status === "active") return "ops-badge success";
  if (status === "past_due") return "ops-badge danger";
  if (status === "paused") return "ops-badge warning";
  return "ops-badge";
}

function firstParam(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function CreditSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const params = await searchParams;
  const status = firstParam(params.status).trim();
  const sql = getAdminSql();

  const rows = await sql<SubRow[]>`
    SELECT s.id, u.email, p.name as plan_name, s.status, s.current_period_start, s.current_period_end, p.monthly_price_krw
    FROM credit_plan_subscriptions s
    JOIN users u ON u.id = s.user_id
    JOIN credit_plans p ON p.id = s.plan_id
    WHERE (${status} = '' OR s.status = ${status})
    ORDER BY s.created_at DESC LIMIT 30
  `;

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">구독</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <form method="get" className="ops-form-row" style={{ marginBottom: 12 }}>
          <select className="ops-input" name="status" defaultValue={status}>
            <option value="">전체 상태</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="ops-button" type="submit">
            필터
          </button>
        </form>

        {rows.length === 0 ? (
          <p className="ops-empty">구독이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>이메일</th>
                  <th>플랜</th>
                  <th>상태</th>
                  <th>현재 기간</th>
                  <th>월 요금</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.email}</td>
                    <td>{r.plan_name ?? "—"}</td>
                    <td>
                      <span className={statusBadge(r.status)}>{r.status ?? "—"}</span>
                    </td>
                    <td>
                      {fmtDate(r.current_period_start)} ~ {fmtDate(r.current_period_end)}
                    </td>
                    <td>{fmtKrw(r.monthly_price_krw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
