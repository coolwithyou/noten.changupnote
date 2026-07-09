import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "../CreditsNav";
import SettingsForm from "./SettingsForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SettingRow {
  key: string;
  value: unknown;
  updated_by_admin_id: string | null;
  updated_at: string | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR");
}

export default async function CreditSettingsPage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const sql = getAdminSql();

  const rows = await sql<SettingRow[]>`
    SELECT key, value, updated_by_admin_id, updated_at FROM credit_settings ORDER BY key
  `;

  const isOwner = session.user.role === "owner";

  const formSettings = rows.map((r) => ({
    key: r.key,
    value: r.value,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">크레딧 설정</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <h3 className="ops-section-title">현재 설정값</h3>
        {rows.length === 0 ? (
          <p className="ops-empty">설정 항목이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>키</th>
                  <th>값</th>
                  <th>최종 수정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.key}</td>
                    <td>
                      <code>{JSON.stringify(r.value)}</code>
                    </td>
                    <td>{fmtDate(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isOwner ? (
        <section className="ops-section">
          <SettingsForm settings={formSettings} />
        </section>
      ) : (
        <section className="ops-section">
          <p className="ops-note">설정 변경은 owner만 가능합니다.</p>
        </section>
      )}
    </main>
  );
}
