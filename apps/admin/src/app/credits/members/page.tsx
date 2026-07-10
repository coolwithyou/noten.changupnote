import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "../CreditsNav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  wallet_id: string | null;
  balance_credits: string | null;
  wallet_status: string | null;
  has_sub: string;
}

function fmtNum(v: string | null | undefined): string {
  const n = Number(v ?? "0");
  if (!n) return "0";
  return n.toLocaleString("ko-KR");
}

function firstParam(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function CreditMembersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const params = await searchParams;
  const q = firstParam(params.q).trim();
  const sql = getAdminSql();

  const rows = await sql<MemberRow[]>`
    SELECT u.id, u.email, u.name, w.id as wallet_id, w.balance_credits, w.status as wallet_status,
      (SELECT COUNT(*) FROM credit_plan_subscriptions WHERE user_id = u.id AND status IN ('active','past_due'))::text as has_sub
    FROM users u LEFT JOIN credit_wallets w ON w.user_id = u.id
    WHERE (${q} = '' OR u.email ILIKE '%'||${q}||'%' OR u.name ILIKE '%'||${q}||'%')
    ORDER BY u.created_at DESC LIMIT 20
  `;

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">회원 지갑</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <form method="get" className="ops-form-row" style={{ marginBottom: 12 }}>
          <input
            className="ops-input"
            type="text"
            name="q"
            defaultValue={q}
            placeholder="이메일 또는 이름으로 검색"
          />
          <button className="ops-button" type="submit">
            검색
          </button>
        </form>

        {rows.length === 0 ? (
          <p className="ops-empty">일치하는 회원이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>이메일</th>
                  <th>이름</th>
                  <th>잔액</th>
                  <th>지갑 상태</th>
                  <th>구독</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/credits/members/${r.id}`}>{r.email}</a>
                    </td>
                    <td>{r.name ?? "—"}</td>
                    <td>{r.wallet_id ? fmtNum(r.balance_credits) : "—"}</td>
                    <td>
                      {r.wallet_status === "frozen" ? (
                        <span className="ops-badge danger">frozen</span>
                      ) : r.wallet_status === "active" ? (
                        <span className="ops-badge success">active</span>
                      ) : (
                        <span className="ops-badge">미생성</span>
                      )}
                    </td>
                    <td>{Number(r.has_sub) > 0 ? "있음" : "—"}</td>
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
