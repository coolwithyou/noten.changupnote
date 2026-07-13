import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "../CreditsNav";
import ReconcileRunButton from "./ReconcileRunButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RunRow {
  id: string;
  run_date: string | null;
  scope: string | null;
  status: string | null;
  summary: unknown;
  created_at: string | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ko-KR");
}

function statusBadge(status: string | null): string {
  if (status === "mismatch" || status === "fail") return "ops-badge danger";
  if (status === "warning" || status === "partial") return "ops-badge warning";
  if (status === "ok" || status === "matched" || status === "pass") return "ops-badge success";
  return "ops-badge";
}

function firstParam(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function CreditReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const params = await searchParams;
  const requestedDate = firstParam(params.date).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : "";
  const sql = getAdminSql();
  const dateStart = date ? new Date(`${date}T00:00:00+09:00`) : null;
  const dateEnd = dateStart ? new Date(dateStart.getTime() + 86_400_000) : null;
  const dateFilter = dateStart && dateEnd
    ? sql`run_date >= ${dateStart.toISOString()}::timestamptz AND run_date < ${dateEnd.toISOString()}::timestamptz`
    : sql`true`;

  const rows = await sql<RunRow[]>`
    SELECT id, run_date, scope, status, summary, created_at
    FROM credit_reconciliation_runs
    WHERE ${dateFilter}
    ORDER BY created_at DESC LIMIT 50
  `;

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">대사(Reconciliation)</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <form method="get" className="ops-form-row" style={{ marginBottom: 12 }}>
          <input className="ops-input" type="date" name="date" defaultValue={date} />
          <button className="ops-button" type="submit">
            필터
          </button>
          <ReconcileRunButton />
        </form>

        {rows.length === 0 ? (
          <p className="ops-empty">대사 실행 기록이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>실행일</th>
                  <th>범위</th>
                  <th>상태</th>
                  <th>요약</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.run_date)}</td>
                    <td>{r.scope ?? "—"}</td>
                    <td>
                      <span className={statusBadge(r.status)}>{r.status ?? "—"}</span>
                    </td>
                    <td>
                      {r.summary === null || r.summary === undefined ? (
                        "—"
                      ) : (
                        <details>
                          <summary>요약</summary>
                          <pre>{JSON.stringify(r.summary, null, 2)}</pre>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ops-note">
          수동 재실행은 admin+ 권한이 필요합니다. 05:00 KST 일일 cron 이 5개 범위(원장·lot·hold·포트원·관리행위)를 자동
          기록하며, 이 버튼은 즉시 재실행합니다.
        </p>
      </section>
    </main>
  );
}
