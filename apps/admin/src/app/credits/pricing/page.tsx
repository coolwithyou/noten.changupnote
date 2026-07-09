import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { CreditsNav } from "../CreditsNav";
import PricingForm from "./PricingForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RuleRow {
  id: string;
  rule_type: string | null;
  feature_code: string | null;
  model: string | null;
  input_millicredits_per_1k: string | null;
  output_millicredits_per_1k: string | null;
  flat_credits: string | null;
  effective_from: string | null;
  effective_until: string | null;
  note: string | null;
}

function fmtNum(v: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR");
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR");
}

function RuleTable({ rows }: { rows: RuleRow[] }) {
  if (rows.length === 0) {
    return <p className="ops-empty">요율 규칙이 없습니다.</p>;
  }
  return (
    <div className="ops-table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            <th>유형</th>
            <th>feature</th>
            <th>model</th>
            <th>in/1k</th>
            <th>out/1k</th>
            <th>flat</th>
            <th>적용 시작</th>
            <th>적용 종료</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.rule_type ?? "—"}</td>
              <td>{r.feature_code ?? "—"}</td>
              <td>{r.model ?? "—"}</td>
              <td>{fmtNum(r.input_millicredits_per_1k)}</td>
              <td>{fmtNum(r.output_millicredits_per_1k)}</td>
              <td>{fmtNum(r.flat_credits)}</td>
              <td>{fmtDate(r.effective_from)}</td>
              <td>{r.effective_until ? fmtDate(r.effective_until) : "현행"}</td>
              <td>{r.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CreditPricingPage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const sql = getAdminSql();

  const [current, history] = await Promise.all([
    sql<RuleRow[]>`
      SELECT id, rule_type, feature_code, model, input_millicredits_per_1k, output_millicredits_per_1k,
        flat_credits, effective_from, effective_until, note
      FROM credit_pricing_rules WHERE effective_until IS NULL
      ORDER BY rule_type, feature_code, model
    `,
    sql<RuleRow[]>`
      SELECT id, rule_type, feature_code, model, input_millicredits_per_1k, output_millicredits_per_1k,
        flat_credits, effective_from, effective_until, note
      FROM credit_pricing_rules ORDER BY created_at DESC LIMIT 100
    `,
  ]);

  const isOwner = session.user.role === "owner";

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">요율 규칙</h1>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <h3 className="ops-section-title">현행 요율 (effective_until = NULL)</h3>
        <RuleTable rows={current} />
      </section>

      <section className="ops-section">
        <h3 className="ops-section-title">전체 이력 (최근 100)</h3>
        <RuleTable rows={history} />
      </section>

      {isOwner ? (
        <section className="ops-section">
          <PricingForm />
        </section>
      ) : (
        <section className="ops-section">
          <p className="ops-note">요율 발행은 owner만 가능합니다.</p>
        </section>
      )}
    </main>
  );
}
