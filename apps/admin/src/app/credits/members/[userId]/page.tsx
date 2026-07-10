import { redirect } from "next/navigation";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { CreditsNav } from "../../CreditsNav";
import AdjustForm from "../AdjustForm";
import GoodwillForm from "../GoodwillForm";
import FreezeButton from "../FreezeButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: string | null;
}

interface WalletRow {
  id: string;
  balance_credits: string | null;
  status: string;
  frozen_reason: string | null;
  updated_at: string | null;
}

interface LotRow {
  id: string;
  source: string | null;
  initial_credits: string | null;
  remaining_credits: string | null;
  expires_at: string | null;
  status: string | null;
  created_at: string | null;
}

interface LedgerRow {
  id: string;
  entry_type: string | null;
  amount_credits: string | null;
  balance_after: string | null;
  reason: string | null;
  actor_id: string | null;
  created_at: string | null;
}

interface HoldRow {
  id: string;
  held_credits: string | null;
  status: string | null;
  expires_at: string | null;
}

interface OrderRow {
  id: string;
  payment_id: string | null;
  order_type: string | null;
  amount_krw: string | null;
  credits_to_grant: string | null;
  status: string | null;
  paid_at: string | null;
  refunded_amount_krw: string | null;
  created_at: string | null;
}

interface SubRow {
  id: string;
  plan_id: string | null;
  plan_name: string | null;
  status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string | null;
}

function fmtNum(v: string | number | null | undefined): string {
  const n = Number(v ?? "0");
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR");
}

function fmtKrw(v: string | number | null | undefined): string {
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

export default async function CreditMemberDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const { userId } = await params;
  const sql = getAdminSql();

  await insertCreditAuditLog({
    action: "member.viewed",
    actorSession: session,
    targetType: "user",
    targetId: userId,
  });

  const userRows = await sql<UserRow[]>`
    SELECT id, email, name, created_at FROM users WHERE id = ${userId} LIMIT 1
  `;
  const user = userRows[0];
  if (!user) {
    return (
      <main className="ops-shell">
        <header className="ops-header">
          <div>
            <p className="ops-eyebrow">크레딧 시스템</p>
            <h1 className="ops-title">회원 상세</h1>
          </div>
          <span className="ops-badge success">{session.user.role}</span>
        </header>
        <CreditsNav />
        <section className="ops-section">
          <p className="ops-empty">회원을 찾을 수 없습니다.</p>
        </section>
      </main>
    );
  }

  const walletRows = await sql<WalletRow[]>`
    SELECT id, balance_credits, status, frozen_reason, updated_at
    FROM credit_wallets WHERE user_id = ${userId} LIMIT 1
  `;
  const wallet = walletRows[0] ?? null;
  const walletId = wallet?.id ?? null;
  const frozen = wallet?.status === "frozen";

  let lots: LotRow[] = [];
  let ledger: LedgerRow[] = [];
  let holds: HoldRow[] = [];
  let orders: OrderRow[] = [];
  let subs: SubRow[] = [];

  if (walletId) {
    [lots, ledger, holds] = await Promise.all([
      sql<LotRow[]>`
        SELECT id, source, initial_credits, remaining_credits, expires_at, status, created_at
        FROM credit_lots WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 20
      `,
      sql<LedgerRow[]>`
        SELECT id, entry_type, amount_credits, balance_after, reason, actor_id, created_at
        FROM credit_ledger WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 50
      `,
      sql<HoldRow[]>`
        SELECT id, held_credits, status, expires_at
        FROM credit_holds WHERE wallet_id = ${walletId} AND status = 'pending' ORDER BY expires_at ASC
      `,
    ]);
  }

  [orders, subs] = await Promise.all([
    sql<OrderRow[]>`
      SELECT id, payment_id, order_type, amount_krw, credits_to_grant, status, paid_at, refunded_amount_krw, created_at
      FROM credit_payment_orders WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 10
    `,
    sql<SubRow[]>`
      SELECT s.id, s.plan_id, p.name as plan_name, s.status, s.current_period_start, s.current_period_end, s.created_at
      FROM credit_plan_subscriptions s LEFT JOIN credit_plans p ON p.id = s.plan_id
      WHERE s.user_id = ${userId} ORDER BY s.created_at DESC LIMIT 5
    `,
  ]);

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">크레딧 시스템</p>
          <h1 className="ops-title">{user.email}</h1>
          <p className="ops-subtitle">
            {user.name ?? "이름 없음"} · 가입 {fmtDate(user.created_at)}
          </p>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>
      <CreditsNav />

      <section className="ops-section">
        <div className="ops-panel">
          <h3 className="ops-section-title">지갑 요약</h3>
          {wallet ? (
            <ul className="ops-metric-grid">
              <li>
                <strong>{fmtNum(wallet.balance_credits)}</strong>
                <span>잔액 크레딧</span>
              </li>
              <li>
                <strong>{frozen ? "동결" : "정상"}</strong>
                <span>지갑 상태 {frozen && wallet.frozen_reason ? `(${wallet.frozen_reason})` : ""}</span>
              </li>
              <li>
                <strong>{fmtDate(wallet.updated_at)}</strong>
                <span>최종 갱신</span>
              </li>
            </ul>
          ) : (
            <p className="ops-empty">지갑 미생성 — 첫 지급 시 자동 생성됩니다.</p>
          )}
        </div>
      </section>

      <section className="ops-section">
        <div className="ops-grid">
          <AdjustForm userId={userId} />
          <GoodwillForm userId={userId} />
          <FreezeButton userId={userId} walletId={walletId} frozen={frozen} />
        </div>
      </section>

      <section className="ops-section">
        <h3 className="ops-section-title">크레딧 로트 (최근 20)</h3>
        {lots.length === 0 ? (
          <p className="ops-empty">로트가 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>소스</th>
                  <th>초기</th>
                  <th>잔여</th>
                  <th>상태</th>
                  <th>만료</th>
                  <th>생성</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => (
                  <tr key={l.id}>
                    <td>{l.source ?? "—"}</td>
                    <td>{fmtNum(l.initial_credits)}</td>
                    <td>{fmtNum(l.remaining_credits)}</td>
                    <td>{l.status ?? "—"}</td>
                    <td>{fmtDate(l.expires_at)}</td>
                    <td>{fmtDate(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ops-section">
        <h3 className="ops-section-title">보류(Hold) — pending</h3>
        {holds.length === 0 ? (
          <p className="ops-empty">보류 중인 항목이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>보류 크레딧</th>
                  <th>상태</th>
                  <th>만료</th>
                </tr>
              </thead>
              <tbody>
                {holds.map((h) => (
                  <tr key={h.id}>
                    <td>{fmtNum(h.held_credits)}</td>
                    <td>{h.status ?? "—"}</td>
                    <td>{fmtDate(h.expires_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ops-section">
        <h3 className="ops-section-title">원장(Ledger) — 최근 50</h3>
        {ledger.length === 0 ? (
          <p className="ops-empty">원장 내역이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>유형</th>
                  <th>변동</th>
                  <th>잔액</th>
                  <th>사유</th>
                  <th>행위자</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.created_at)}</td>
                    <td>{e.entry_type ?? "—"}</td>
                    <td>{fmtNum(e.amount_credits)}</td>
                    <td>{fmtNum(e.balance_after)}</td>
                    <td>{e.reason ?? "—"}</td>
                    <td>{e.actor_id ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ops-section">
        <h3 className="ops-section-title">결제 주문 (최근 10)</h3>
        {orders.length === 0 ? (
          <p className="ops-empty">결제 내역이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>결제 ID</th>
                  <th>유형</th>
                  <th>금액</th>
                  <th>지급 크레딧</th>
                  <th>상태</th>
                  <th>결제일</th>
                  <th>환불액</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.payment_id ?? "—"}</td>
                    <td>{o.order_type ?? "—"}</td>
                    <td>{fmtKrw(o.amount_krw)}</td>
                    <td>{fmtNum(o.credits_to_grant)}</td>
                    <td>{o.status ?? "—"}</td>
                    <td>{fmtDate(o.paid_at)}</td>
                    <td>{fmtKrw(o.refunded_amount_krw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ops-section">
        <h3 className="ops-section-title">구독 (최근 5)</h3>
        {subs.length === 0 ? (
          <p className="ops-empty">구독 내역이 없습니다.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>플랜</th>
                  <th>상태</th>
                  <th>현재 기간</th>
                  <th>생성</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td>{s.plan_name ?? s.plan_id ?? "—"}</td>
                    <td>{s.status ?? "—"}</td>
                    <td>
                      {fmtDate(s.current_period_start)} ~ {fmtDate(s.current_period_end)}
                    </td>
                    <td>{fmtDate(s.created_at)}</td>
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
