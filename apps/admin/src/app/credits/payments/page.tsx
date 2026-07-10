import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "../CreditsNav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface OrderRow {
  id: string;
  payment_id: string | null;
  email: string;
  order_type: string | null;
  amount_krw: string | null;
  status: string | null;
  paid_at: string | null;
  refunded_amount_krw: string | null;
  created_at: string | null;
}

const STATUS_OPTIONS = ["paid", "pending", "failed", "refunded", "partially_refunded"];

function fmtKrw(v: string | null | undefined): string {
  const n = Number(v ?? "0");
  if (!n) return "—";
  return `₩${n.toLocaleString("ko-KR")}`;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR");
}

function statusBadge(status: string | null): string {
  if (status === "paid") return "ops-badge success";
  if (status === "failed") return "ops-badge danger";
  if (status === "refunded" || status === "partially_refunded") return "ops-badge warning";
  return "ops-badge";
}

function firstParam(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function CreditPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const params = await searchParams;
  const status = firstParam(params.status).trim();
  const sql = getAdminSql();

  const rows = await sql<OrderRow[]>`
    SELECT o.id, o.payment_id, u.email, o.order_type, o.amount_krw, o.status, o.paid_at, o.refunded_amount_krw, o.created_at
    FROM credit_payment_orders o JOIN users u ON u.id = o.user_id
    WHERE (${status} = '' OR o.status = ${status})
    ORDER BY o.created_at DESC LIMIT 30
  `;

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">결제 주문</h1>
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
          <p className="ops-empty">결제 주문이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>결제 ID</th>
                  <th>이메일</th>
                  <th>유형</th>
                  <th>금액</th>
                  <th>상태</th>
                  <th>결제일</th>
                  <th>환불액</th>
                  <th>동기화</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.payment_id ?? "—"}</td>
                    <td>{r.email}</td>
                    <td>{r.order_type ?? "—"}</td>
                    <td>{fmtKrw(r.amount_krw)}</td>
                    <td>
                      <span className={statusBadge(r.status)}>{r.status ?? "—"}</span>
                    </td>
                    <td>{fmtDate(r.paid_at)}</td>
                    <td>{fmtKrw(r.refunded_amount_krw)}</td>
                    <td>
                      <button className="ops-button ghost" type="button" disabled>
                        준비 중
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ops-note">포트원 동기화는 P3에서 구현 예정입니다.</p>
      </section>
    </main>
  );
}
