import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { CreditsNav } from "../CreditsNav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AuditRow {
  id: string;
  action: string | null;
  actor_type: string | null;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  target_type: string | null;
  target_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  created_at: string | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR");
}

function firstParam(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function DiffCell({ label, value, cls }: { label: string; value: unknown; cls: string }) {
  if (value === null || value === undefined) return null;
  return (
    <details className={cls}>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export default async function CreditAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const params = await searchParams;
  const actor = firstParam(params.actor).trim();
  const action = firstParam(params.action).trim();
  const targetType = firstParam(params.targetType).trim();
  const from = firstParam(params.from).trim();
  const to = firstParam(params.to).trim();
  const sql = getAdminSql();

  await insertCreditAuditLog({
    action: "audit.viewed",
    actorSession: session,
    targetType: "audit_log",
    targetId: "page",
    after: { filters: { actor, action, targetType, from, to } },
  });

  const rows = await sql<AuditRow[]>`
    SELECT id, action, actor_type, actor_id, actor_email, actor_role, target_type, target_id, before, after, reason, created_at
    FROM credit_audit_logs
    WHERE (${action} = '' OR action = ${action})
      AND (${actor} = '' OR actor_id = ${actor})
      AND (${targetType} = '' OR target_type = ${targetType})
    ORDER BY created_at DESC LIMIT 50
  `;

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">감사 로그</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <form method="get" className="ops-form-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <input className="ops-input" type="text" name="actor" defaultValue={actor} placeholder="actor_id" />
          <input className="ops-input" type="text" name="action" defaultValue={action} placeholder="action" />
          <input
            className="ops-input"
            type="text"
            name="targetType"
            defaultValue={targetType}
            placeholder="target type"
          />
          <input className="ops-input" type="date" name="from" defaultValue={from} />
          <input className="ops-input" type="date" name="to" defaultValue={to} />
          <button className="ops-button" type="submit">
            필터
          </button>
        </form>

        <p className="ops-note">
          CSV 내보내기는 준비 중입니다. JSON은{" "}
          <a href="/api/admin/credits/audit-logs">/api/admin/credits/audit-logs</a> 에서 조회하세요.
        </p>

        {rows.length === 0 ? (
          <p className="ops-empty">감사 로그가 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>action</th>
                  <th>actor</th>
                  <th>target</th>
                  <th>사유</th>
                  <th>diff</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.created_at)}</td>
                    <td>{r.action ?? "—"}</td>
                    <td>
                      {r.actor_email ?? r.actor_id ?? "—"}
                      {r.actor_role ? ` (${r.actor_role})` : ""}
                    </td>
                    <td>
                      {r.target_type ?? "—"}
                      {r.target_id ? `:${r.target_id}` : ""}
                    </td>
                    <td>{r.reason ?? "—"}</td>
                    <td>
                      <DiffCell label="before" value={r.before} cls="ops-diff-before" />
                      <DiffCell label="after" value={r.after} cls="ops-diff-after" />
                    </td>
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
