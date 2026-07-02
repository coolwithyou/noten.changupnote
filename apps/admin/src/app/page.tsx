import { redirect } from "next/navigation";
import { getOpsFlywheelSnapshot } from "@/lib/server/admin/flywheel";
import { getOptionalAdminSession } from "@/lib/server/auth/adminSession";

export const dynamic = "force-dynamic";

const OPS_SURFACES = [
  {
    title: "운영 상태",
    badge: "active",
    body: "ops.changupnote.com 전용 세션과 admin status API를 기준으로 상태를 확인합니다.",
  },
  {
    title: "고객지원 큐",
    badge: "next",
    body: "기존 /admin support ticket 운영 패널을 이 앱으로 이전할 대상입니다.",
  },
  {
    title: "플라이휠 리포트",
    badge: "next",
    body: "readiness, release checklist, matching eval, review queue를 순차 이전합니다.",
  },
];

export default async function OpsHomePage() {
  const session = await getOptionalAdminSession();
  if (!session) redirect("/login");
  const snapshot = await loadFlywheelSnapshot();

  return (
    <main className="ops-shell">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">Cunote Ops</p>
          <h1 className="ops-title">창업노트 운영 콘솔</h1>
          <p className="ops-subtitle">
            {session.user.email} 계정으로 로그인했습니다. 이 세션은 changupnote.com 사용자 프론트와 공유되지 않습니다.
          </p>
        </div>
        <span className="ops-badge success">{session.user.role}</span>
      </header>

      <section className="ops-grid">
        {OPS_SURFACES.map((surface) => (
          <article className="ops-panel" key={surface.title}>
            <span className={surface.badge === "active" ? "ops-badge success" : "ops-badge warning"}>
              {surface.badge}
            </span>
            <h2>{surface.title}</h2>
            <p>{surface.body}</p>
          </article>
        ))}
      </section>

      <section className="ops-grid" style={{ marginTop: 16 }}>
        <article className="ops-panel">
          <h3>인증 경계</h3>
          <ul className="ops-list">
            <li>Google 로그인 허용 도메인: {process.env.ADMIN_ALLOWED_GOOGLE_DOMAIN ?? "noten.im"}</li>
            <li>세션 쿠키: {process.env.ADMIN_SESSION_COOKIE_NAME ?? "__Secure-cunote-admin.session-token"}</li>
            <li>프론트 세션 공유: false</li>
          </ul>
          <div className="ops-actions">
            <a href="/api/admin/status/legal-readiness">Legal readiness</a>
            <a href="/api/admin/status/saas-readiness">SaaS readiness</a>
            <a href="/api/admin/status/release-checklist">Release checklist</a>
            <a href="/api/admin/flywheel/support-tickets/report">Support queue</a>
          </div>
        </article>
        <article className="ops-panel" style={{ gridColumn: "span 2" }}>
          <span className={snapshot ? "ops-badge success" : "ops-badge warning"}>
            {snapshot ? "connected" : "pending"}
          </span>
          <h3>운영 지표</h3>
          {snapshot ? (
            <ul className="ops-metric-grid">
              {snapshot.surfaces.map((surface) => (
                <li key={surface.key}>
                  <strong>{surface.available ? surface.count?.toLocaleString("ko-KR") : "-"}</strong>
                  <span>{surface.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>DB 연결 또는 migration 적용 전에는 운영 지표를 표시하지 않습니다.</p>
          )}
        </article>
      </section>
    </main>
  );
}

async function loadFlywheelSnapshot() {
  try {
    return await withTimeout(getOpsFlywheelSnapshot(), 5_000);
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ops_flywheel_snapshot_timeout")), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}
